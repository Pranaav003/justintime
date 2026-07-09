import * as vscode from 'vscode';
import type { SnapshotFs } from './rollback-store';

/**
 * SnapshotFs backed by vscode.workspace.fs. Used to persist rollback snapshots
 * under globalStorageUri and to restore pristine content on Revert All.
 */
export class VscodeSnapshotFs implements SnapshotFs {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  async read(path: string): Promise<string | undefined> {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return this.decoder.decode(data);
    } catch {
      return undefined;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    if (dir) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.file(path), this.encoder.encode(content));
  }

  async remove(path: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(path));
    } catch {
      // Already gone — nothing to do.
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return true;
    } catch {
      return false;
    }
  }
}
