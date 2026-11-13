import * as vscode from 'vscode';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { SnapshotFs } from './rollback-store';
import { WorkspacePaths, isFileNotFound } from './workspace-paths';

/** No root: owned storage only. With root: freshly guarded, editor-aware workspace access. */
export class VscodeSnapshotFs implements SnapshotFs {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly paths?: WorkspacePaths;

  constructor(workspaceRoot?: string) {
    if (workspaceRoot !== undefined) this.paths = new WorkspacePaths(workspaceRoot);
  }

  private async uri(file: string): Promise<vscode.Uri> {
    return vscode.Uri.file(this.paths ? await this.paths.validateAbsolute(file) : file);
  }

  private async document(file: string): Promise<vscode.TextDocument | undefined> {
    if (!this.paths) return undefined;
    const documents = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file');
    const exact = documents.find(doc => doc.uri.fsPath === file);
    if (exact) return exact;
    // VS Code can reuse an open document for a differently cased file URI.
    // Ask the filesystem for identity rather than lowercasing case-sensitive paths.
    let canonical: string;
    try { canonical = await fs.realpath(file); }
    catch (error) { if (isFileNotFound(error)) return undefined; throw error; }
    for (const doc of documents) {
      try { if (await fs.realpath(doc.uri.fsPath) === canonical) return doc; }
      catch (error) { if (!isFileNotFound(error)) throw error; }
    }
    return undefined;
  }

  async read(file: string): Promise<string | undefined> {
    await this.uri(file);
    const doc = await this.document(file);
    const uri = await this.uri(file);
    if (doc) { await this.uri(doc.uri.fsPath); return doc.getText(); }
    try { return this.decoder.decode(await vscode.workspace.fs.readFile(uri)); }
    catch (error) { if (isFileNotFound(error)) return undefined; throw error; }
  }

  async write(file: string, content: string): Promise<void> {
    await this.uri(file);
    const doc = await this.document(file);
    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
      await this.uri(file);
      await this.uri(doc.uri.fsPath);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error(`Failed to restore editor buffer: ${file}`);
      await this.uri(file);
      await this.uri(doc.uri.fsPath);
      if (!await doc.save()) throw new Error(`Failed to save restored editor buffer: ${file}`);
      return;
    }
    await this.uri(file);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)));
    const uri = await this.uri(file);
    await vscode.workspace.fs.writeFile(uri, this.encoder.encode(content));
  }

  async writeAtomic(file: string, content: string): Promise<void> {
    if (this.paths) throw new Error('Atomic journal writes require the storage adapter');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await this.write(temporary, content);
    try {
      // VS Code's overwrite move deletes the destination before provider.rename.
      // Native same-directory rename replaces this local index atomically.
      await fs.rename(temporary, file);
    } catch (error) {
      // Failure leaves the old index intact; an abandoned temp file is harmless.
      try { await this.remove(temporary); } catch { /* Preserve the publication error. */ }
      throw error;
    }
  }

  async remove(file: string): Promise<void> {
    await this.uri(file);
    const doc = await this.document(file);
    const uri = await this.uri(file);
    try {
      if (doc) {
        const edit = new vscode.WorkspaceEdit();
        edit.deleteFile(uri, { ignoreIfNotExists: true });
        await this.uri(file);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error(`Failed to delete editor document: ${file}`);
      } else await vscode.workspace.fs.delete(uri);
    } catch (error) { if (!isFileNotFound(error)) throw error; }
  }

  async exists(file: string): Promise<boolean> {
    await this.uri(file);
    const doc = await this.document(file);
    const uri = await this.uri(file);
    if (doc) return true;
    try { await vscode.workspace.fs.stat(uri); return true; }
    catch (error) { if (isFileNotFound(error)) return false; throw error; }
  }
}
