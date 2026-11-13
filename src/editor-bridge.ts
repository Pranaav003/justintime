import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WorkspacePaths, WorkspacePathError, isFileNotFound } from './workspace-paths';
import { applyHunks } from './anchor';
import type { HydratedStep, ApplyOutcome } from './types';

/**
 * Editor Bridge (design Section 7): the only module that drives the VS Code
 * editor. Navigation, target-range decorations (re-applied across tab switches),
 * WorkspaceEdit-based application (dirty-buffer safe, integrates with undo), and
 * the native diff editor via a virtual-document content provider.
 *
 * Filesystem boundaries have focused mocked-host tests and extension-host coverage.
 */

export interface EditorBridgeConfig {
  highlightColor: string;
  secondaryHighlightColor: string;
}

/** Serves before/after virtual documents for the native diff editor. */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();
  private readonly keyQueue: [string, string][] = [];
  private seq = 0;
  private static readonly MAX_PAIRS = 5;

  register(relPath: string, before: string, after: string): [vscode.Uri, vscode.Uri] {
    const id = this.seq++;
    const name = relPath.split('/').pop() ?? 'file';
    const leftPath = `/${id}/before/${name}`;
    const rightPath = `/${id}/after/${name}`;
    this.store.set(leftPath, before);
    this.store.set(rightPath, after);
    // Bound memory: evict the oldest diff pair once past the cap.
    this.keyQueue.push([leftPath, rightPath]);
    if (this.keyQueue.length > DiffContentProvider.MAX_PAIRS) {
      const [oldLeft, oldRight] = this.keyQueue.shift()!;
      this.store.delete(oldLeft);
      this.store.delete(oldRight);
    }
    return [
      vscode.Uri.from({ scheme: 'justintime-diff', path: leftPath }),
      vscode.Uri.from({ scheme: 'justintime-diff', path: rightPath }),
    ];
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.store.get(uri.path) ?? '';
  }
}

export class EditorBridge implements vscode.Disposable {
  private readonly targetDecoration: vscode.TextEditorDecorationType;
  private readonly secondaryDecoration: vscode.TextEditorDecorationType;
  private current?: { uri: vscode.Uri; range: vscode.Range };
  private readonly disposables: vscode.Disposable[] = [];
  private readonly diffProvider = new DiffContentProvider();
  private readonly paths: WorkspacePaths;

  constructor(
    workspaceRoot: string,
    config: EditorBridgeConfig,
  ) {
    this.paths = new WorkspacePaths(workspaceRoot);
    this.targetDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: config.highlightColor,
      isWholeLine: true,
    });
    this.secondaryDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: config.secondaryHighlightColor,
      isWholeLine: true,
    });
    this.disposables.push(
      this.targetDecoration,
      this.secondaryDecoration,
      vscode.workspace.registerTextDocumentContentProvider('justintime-diff', this.diffProvider),
      // Decorations are per-editor and lost on tab switch; re-apply on focus change.
      vscode.window.onDidChangeActiveTextEditor(() => this.reapplyDecorations()),
    );
  }

  private async uriFor(relPath: string): Promise<vscode.Uri> {
    return vscode.Uri.file(await this.paths.resolve(relPath));
  }

  /** Bounded, noise-excluded list of workspace-relative file paths for the repo map. */
  async listFiles(): Promise<string[]> {
    const exclude =
      '{**/node_modules/**,**/.git/**,**/dist/**,**/dist-e2e/**,**/dist-smoke/**,**/out/**,**/build/**,**/.vscode-test/**,**/coverage/**,**/*.map,**/*.vsix,**/*.lock,**/*-lock.json}';
    await this.paths.canonicalRoot();
    const pattern = new vscode.RelativePattern(vscode.Uri.file(this.paths.root), '**/*');
    const uris = await vscode.workspace.findFiles(pattern, exclude, 600);
    await this.paths.canonicalRoot();
    const files: string[] = [];
    for (const uri of uris.slice(0, 600)) {
      try {
        const absolute = await this.paths.validateAbsolute(uri.fsPath);
        files.push(path.relative(this.paths.root, absolute).split(path.sep).join('/'));
      } catch (error) {
        if (!(error instanceof WorkspacePathError)) throw error;
      }
    }
    return files.sort();
  }

  /** Grep the workspace (repo-map files) for a keyword/regex; returns file:line matches. */
  async searchCode(query: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    let re: RegExp | undefined;
    try {
      re = new RegExp(query, 'i');
    } catch {
      re = undefined;
    }
    const needle = query.toLowerCase();
    const matches = (line: string): boolean => (re ? re.test(line) : line.toLowerCase().includes(needle));

    const files = await this.listFiles();
    signal?.throwIfAborted();
    const out: string[] = [];
    const MAX = 40;
    for (const rel of files) {
      if (out.length >= MAX) {
        break;
      }
      signal?.throwIfAborted();
      const content = await this.readFile(rel);
      signal?.throwIfAborted();
      if (content === undefined) {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && out.length < MAX; i++) {
        if (matches(lines[i]!)) {
          out.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
        }
      }
    }
    return out.length > 0 ? out.join('\n') : `(no matches for "${query}")`;
  }

  private async openFile(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      await this.paths.validateAbsolute(uri.fsPath);
      // Some hosts drop the resolver's error code. Confirm absence on disk,
      // while preserving any explicit permission/unavailable error from the host.
      if (error && typeof error === 'object' && 'code' in error && error.code !== undefined && !isFileNotFound(error)) throw error;
      try {
        await fs.stat(uri.fsPath);
      } catch (statError) {
        if (!isFileNotFound(statError)) throw statError;
        return undefined;
      }
      throw error;
    }
  }

  /** Current content of a workspace-relative file, or undefined if it does not exist. */
  async readFile(relPath: string): Promise<string | undefined> {
    const uri = await this.uriFor(relPath);
    const doc = await this.openFile(uri);
    if (!doc) return undefined;
    await this.paths.validateAbsolute(uri.fsPath);
    return doc.getText();
  }

  /** Open + reveal + highlight the target range. startLine/endLine are 1-based, advisory. */
  async navigateTo(relPath: string, startLine: number, endLine: number): Promise<void> {
    const uri = await this.uriFor(relPath);
    const doc = await this.openFile(uri);
    // Target may not exist yet (create step) — nothing to navigate to.
    if (!doc) return;
    await this.paths.validateAbsolute(uri.fsPath);
    // Reuse a single preview tab in the main editor column instead of piling up
    // a new permanent tab per step; keep focus on the explanation panel.
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preview: true,
      preserveFocus: true,
    });
    await this.paths.validateAbsolute(uri.fsPath);
    const range = this.clampRange(doc, startLine, endLine);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    this.current = { uri, range };
    editor.setDecorations(this.targetDecoration, [range]);
  }

  private clampRange(doc: vscode.TextDocument, startLine1: number, endLine1: number): vscode.Range {
    const last = Math.max(0, doc.lineCount - 1);
    const s = Math.min(Math.max(0, startLine1 - 1), last);
    const e = Math.min(Math.max(s, endLine1 - 1), last);
    return new vscode.Range(new vscode.Position(s, 0), doc.lineAt(e).range.end);
  }

  private reapplyDecorations(): void {
    if (!this.current) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.toString() === this.current.uri.toString()) {
      editor.setDecorations(this.targetDecoration, [this.current.range]);
    }
  }

  clearHighlights(): void {
    this.current = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.targetDecoration, []);
      editor.setDecorations(this.secondaryDecoration, []);
    }
  }

  /** Open a native diff editor comparing before/after for a step. */
  async showDiff(title: string, relPath: string, beforeText: string, afterText: string): Promise<void> {
    await this.paths.resolve(relPath);
    const [left, right] = this.diffProvider.register(relPath, beforeText, afterText);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
      preview: true,
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
    });
  }

  /** Apply a hydrated step's change via WorkspaceEdit. */
  async applyStep(step: HydratedStep): Promise<ApplyOutcome> {
    try {
      switch (step.changeKind) {
        case 'edit':
          return await this.applyEdit(step);
        case 'create':
          return await this.applyCreate(step);
        case 'delete':
          return await this.applyDelete(step);
        case 'rename':
          return await this.applyRename(step);
        default:
          return { status: 'error', message: `unknown changeKind` };
      }
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async applyEdit(step: HydratedStep): Promise<ApplyOutcome> {
    const uri = await this.uriFor(step.primaryFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    await this.paths.validateAbsolute(uri.fsPath);
    const text = doc.getText();
    const res = applyHunks(text, step.hunks ?? []);
    if (res.status === 'error') {
      return { status: 'conflict', reason: `${res.reason} (hunk ${res.hunkIndex})` };
    }
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, res.text);
    await this.paths.validateAbsolute(uri.fsPath);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      return { status: 'error', message: 'applyEdit returned false' };
    }
    // Persist so the change lands on disk and stays consistent with the
    // fs-based rollback store (the edit otherwise lives only in the buffer).
    await this.paths.validateAbsolute(uri.fsPath);
    const saved = await doc.save();
    if (!saved) {
      return { status: 'error', message: 'doc.save() returned false — file not persisted' };
    }
    return { status: 'applied' };
  }

  private async applyCreate(step: HydratedStep): Promise<ApplyOutcome> {
    const uri = await this.uriFor(step.primaryFile);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, {
      ignoreIfExists: false,
      contents: Buffer.from(step.fullFileContent ?? '', 'utf8'),
    });
    await this.paths.validateAbsolute(uri.fsPath);
    const ok = await vscode.workspace.applyEdit(edit);
    // No doc.save() needed: WorkspaceEdit.createFile with 'contents' uses the VS Code
    // filesystem API and writes directly to disk (not a buffer-level edit), so the
    // file is already persisted. Unlike applyEdit (which replaces buffer content and
    // needs an explicit save), create/delete/rename are filesystem-level operations. (Finding 6)
    return ok ? { status: 'applied' } : { status: 'error', message: 'createFile failed' };
  }

  private async applyDelete(step: HydratedStep): Promise<ApplyOutcome> {
    const uri = await this.uriFor(step.primaryFile);
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    await this.paths.validateAbsolute(uri.fsPath);
    const ok = await vscode.workspace.applyEdit(edit);
    // No doc.save() needed: deleteFile is a filesystem-level operation (see applyCreate comment). (Finding 6)
    return ok ? { status: 'applied' } : { status: 'error', message: 'deleteFile failed' };
  }

  private async applyRename(step: HydratedStep): Promise<ApplyOutcome> {
    if (!step.renameTo) {
      return { status: 'error', message: 'rename step missing renameTo' };
    }
    const source = await this.uriFor(step.primaryFile);
    const destination = await this.uriFor(step.renameTo);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(source, destination, { overwrite: false });
    await this.paths.validateAbsolute(source.fsPath);
    await this.paths.validateAbsolute(destination.fsPath);
    const ok = await vscode.workspace.applyEdit(edit);
    // No doc.save() needed: renameFile is a filesystem-level operation (see applyCreate comment). (Finding 6)
    return ok ? { status: 'applied' } : { status: 'error', message: 'renameFile failed' };
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
