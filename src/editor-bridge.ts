import * as vscode from 'vscode';
import { applyHunks } from './anchor';
import type { HydratedStep, ApplyOutcome } from './types';

/**
 * Editor Bridge (design Section 7): the only module that drives the VS Code
 * editor. Navigation, target-range decorations (re-applied across tab switches),
 * WorkspaceEdit-based application (dirty-buffer safe, integrates with undo), and
 * the native diff editor via a virtual-document content provider.
 *
 * Not unit-tested (importing `vscode` requires the extension host); covered by
 * the Task 11 E2E suite.
 */

export interface EditorBridgeConfig {
  highlightColor: string;
  secondaryHighlightColor: string;
}

/** Serves before/after virtual documents for the native diff editor. */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly store = new Map<string, string>();
  private seq = 0;

  register(relPath: string, before: string, after: string): [vscode.Uri, vscode.Uri] {
    const id = this.seq++;
    const name = relPath.split('/').pop() ?? 'file';
    const leftPath = `/${id}/before/${name}`;
    const rightPath = `/${id}/after/${name}`;
    this.store.set(leftPath, before);
    this.store.set(rightPath, after);
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

  constructor(
    private readonly workspaceRoot: string,
    config: EditorBridgeConfig,
  ) {
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

  private uriFor(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRoot), relPath);
  }

  /** Current content of a workspace-relative file, or undefined if it does not exist. */
  async readFile(relPath: string): Promise<string | undefined> {
    try {
      const doc = await vscode.workspace.openTextDocument(this.uriFor(relPath));
      return doc.getText();
    } catch {
      return undefined;
    }
  }

  /** Open + reveal + highlight the target range. startLine/endLine are 1-based, advisory. */
  async navigateTo(relPath: string, startLine: number, endLine: number): Promise<void> {
    const uri = this.uriFor(relPath);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      // Target may not exist yet (create step) — nothing to navigate to.
      return;
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
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
    const [left, right] = this.diffProvider.register(relPath, beforeText, afterText);
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
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
    const uri = this.uriFor(step.primaryFile);
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const res = applyHunks(text, step.hunks ?? []);
    if (res.status === 'error') {
      return { status: 'conflict', reason: `${res.reason} (hunk ${res.hunkIndex})` };
    }
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange, res.text);
    const ok = await vscode.workspace.applyEdit(edit);
    return ok ? { status: 'applied' } : { status: 'error', message: 'applyEdit returned false' };
  }

  private async applyCreate(step: HydratedStep): Promise<ApplyOutcome> {
    const uri = this.uriFor(step.primaryFile);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, {
      ignoreIfExists: false,
      contents: Buffer.from(step.fullFileContent ?? '', 'utf8'),
    });
    const ok = await vscode.workspace.applyEdit(edit);
    return ok ? { status: 'applied' } : { status: 'error', message: 'createFile failed' };
  }

  private async applyDelete(step: HydratedStep): Promise<ApplyOutcome> {
    const uri = this.uriFor(step.primaryFile);
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    const ok = await vscode.workspace.applyEdit(edit);
    return ok ? { status: 'applied' } : { status: 'error', message: 'deleteFile failed' };
  }

  private async applyRename(step: HydratedStep): Promise<ApplyOutcome> {
    if (!step.renameTo) {
      return { status: 'error', message: 'rename step missing renameTo' };
    }
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(this.uriFor(step.primaryFile), this.uriFor(step.renameTo), { overwrite: false });
    const ok = await vscode.workspace.applyEdit(edit);
    return ok ? { status: 'applied' } : { status: 'error', message: 'renameFile failed' };
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
