import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

const host = vi.hoisted(() => ({
  documents: [] as any[],
  readFile: vi.fn(), writeFile: vi.fn(), createDirectory: vi.fn(), deleteFile: vi.fn(), stat: vi.fn(), rename: vi.fn(),
  applyEdit: vi.fn(),
}));
vi.mock('vscode', () => ({
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => fsPath }) },
  Range: class { constructor(..._args: any[]) {} },
  WorkspaceEdit: class {
    replacements: any[] = [];
    deletions: any[] = [];
    replace(uri: any, range: any, text: string) { this.replacements.push({ uri, range, text }); }
    deleteFile(uri: any) { this.deletions.push(uri); }
  },
  workspace: {
    get textDocuments() { return host.documents; },
    fs: { readFile: host.readFile, writeFile: host.writeFile, createDirectory: host.createDirectory,
      delete: host.deleteFile, stat: host.stat, rename: host.rename },
    applyEdit: host.applyEdit,
  },
}));
import { VscodeSnapshotFs } from './vscode-snapshot-fs';
import { RollbackStore } from './rollback-store';

let root: string;
beforeEach(async () => {
  vi.restoreAllMocks(); vi.resetAllMocks(); host.documents = [];
  root = await fs.mkdtemp(path.join(tmpdir(), 'jit-adapter-'));
  host.readFile.mockImplementation(async (uri) => fs.readFile(uri.fsPath));
  host.writeFile.mockImplementation(async (uri, data) => fs.writeFile(uri.fsPath, data));
  host.createDirectory.mockImplementation(async (uri) => fs.mkdir(uri.fsPath, { recursive: true }));
  host.deleteFile.mockImplementation(async (uri) => fs.unlink(uri.fsPath));
  host.stat.mockImplementation(async (uri) => fs.stat(uri.fsPath));
  host.rename.mockImplementation(async (from, to) => fs.rename(from.fsPath, to.fsPath));
  host.applyEdit.mockImplementation(async (edit) => {
    for (const replacement of edit.replacements) host.documents.find(d => d.uri.fsPath === replacement.uri.fsPath).text = replacement.text;
    for (const uri of edit.deletions) { await fs.unlink(uri.fsPath); host.documents = host.documents.filter(d => d.uri.fsPath !== uri.fsPath); }
    return true;
  });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function document(file: string, text: string) {
  const doc = {
    uri: { scheme: 'file', fsPath: file }, text,
    getText() { return this.text; }, positionAt: (offset: number) => offset,
    save: vi.fn(async () => { await fs.writeFile(file, doc.text); return true; }),
  };
  host.documents.push(doc); return doc;
}

describe('VscodeSnapshotFs authorization and buffers', () => {
  it('captures unsaved editor text without saving; restores the open buffer and saves the baseline (R3)', async () => {
    const file = path.join(root, 'a'); await fs.writeFile(file, 'disk A0');
    const doc = document(file, 'dirty U0'); const target = new VscodeSnapshotFs(root);
    expect(await target.read(file)).toBe('dirty U0'); expect(doc.save).not.toHaveBeenCalled();
    doc.text = 'generated U1'; await target.write(file, 'dirty U0');
    expect(doc.text).toBe('dirty U0'); expect(await fs.readFile(file, 'utf8')).toBe('dirty U0');
    await doc.save(); expect(await fs.readFile(file, 'utf8')).toBe('dirty U0');
  });

  it('storage reads ignore editor buffers and atomically replace the index', async () => {
    const file = path.join(root, 'index.json'); await fs.writeFile(file, 'old'); document(file, 'untrusted editor text');
    const storage = new VscodeSnapshotFs(); expect(await storage.read(file)).toBe('old');
    await storage.writeAtomic(file, 'new'); expect(await fs.readFile(file, 'utf8')).toBe('new');
    expect(await fs.readdir(root)).toEqual(['index.json']);
  });

  it('failed atomic publication leaves the previous index intact', async () => {
    const file = path.join(root, 'index.json'); await fs.writeFile(file, 'old');
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('ENOSPC'));
    await expect(new VscodeSnapshotFs().writeAtomic(file, 'new')).rejects.toThrow('ENOSPC');
    expect(await fs.readFile(file, 'utf8')).toBe('old');
  });

  it('bypasses VS Code overwrite moves that delete the existing manifest before rename', async () => {
    const file = path.join(root, 'index.json'); await fs.writeFile(file, 'old');
    host.rename.mockImplementation(async (_from, to) => {
      await fs.unlink(to.fsPath);
      throw new Error('provider rename failed after destination deletion');
    });
    await new VscodeSnapshotFs().writeAtomic(file, 'new');
    expect(host.rename).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('new');
  });

  it('finds a dirty document through an existing canonical alias and restores the same buffer', async () => {
    const file = path.join(root, 'Case.ts'); const alias = path.join(root, 'alias.ts');
    await fs.writeFile(file, 'disk baseline'); await fs.symlink(file, alias);
    const doc = document(file, 'unsaved baseline'); const target = new VscodeSnapshotFs(root);
    expect(await target.read(alias)).toBe('unsaved baseline');
    expect(doc.save).not.toHaveBeenCalled();
    doc.text = 'generated'; await target.write(alias, 'unsaved baseline');
    expect(doc.text).toBe('unsaved baseline');
    expect(await fs.readFile(file, 'utf8')).toBe('unsaved baseline');
    await doc.save(); expect(await fs.readFile(file, 'utf8')).toBe('unsaved baseline');
  });

  it('matches filesystem case identity for dirty Case.ts accessed as case.ts', async ({ skip }) => {
    const file = path.join(root, 'Case.ts'); const alias = path.join(root, 'case.ts');
    await fs.writeFile(file, 'disk baseline');
    try { await fs.realpath(alias); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') skip(); else throw error; }
    // The real host regression covers URI reuse on a case-insensitive volume.
    const doc = document(file, 'unsaved baseline'); const target = new VscodeSnapshotFs(root);
    expect(await target.read(alias)).toBe('unsaved baseline');
    doc.text = 'generated'; await target.write(alias, 'unsaved baseline');
    expect(doc.text).toBe('unsaved baseline');
    expect(await fs.readFile(file, 'utf8')).toBe('unsaved baseline');
  });

  it.each(['NoPermissions', 'Unavailable', 'EIO'])('propagates %s from read/stat/delete', async (code) => {
    const error = Object.assign(new Error(code), { code }); const target = new VscodeSnapshotFs(root);
    host.readFile.mockRejectedValue(error); host.stat.mockRejectedValue(error); host.deleteFile.mockRejectedValue(error);
    await expect(target.read(path.join(root, 'a'))).rejects.toThrow(code);
    await expect(target.exists(path.join(root, 'a'))).rejects.toThrow(code);
    await expect(target.remove(path.join(root, 'a'))).rejects.toThrow(code);
  });

  it('suppresses only true FileNotFound read/stat/delete errors', async () => {
    const error = Object.assign(new Error('missing'), { code: 'FileNotFound' });
    host.readFile.mockRejectedValue(error); host.stat.mockRejectedValue(error); host.deleteFile.mockRejectedValue(error);
    const target = new VscodeSnapshotFs(root); const file = path.join(root, 'a');
    expect(await target.read(file)).toBeUndefined(); expect(await target.exists(file)).toBe(false);
    await expect(target.remove(file)).resolves.toBeUndefined();
  });

  it('deletes an open created document through WorkspaceEdit so its buffer cannot resurrect generated content', async () => {
    const file = path.join(root, 'a'); await fs.writeFile(file, 'generated'); document(file, 'generated dirty');
    await new VscodeSnapshotFs(root).remove(file);
    expect(host.documents).toHaveLength(0); await expect(fs.stat(file)).rejects.toThrow();
    expect(host.applyEdit).toHaveBeenCalledOnce();
  });

  it('rechecks after missing-document lookup before mkdir and retains recovery on parent retarget', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'jit-outside-'));
    const storageRoot = await fs.mkdtemp(path.join(tmpdir(), 'jit-storage-'));
    try {
      await fs.mkdir(path.join(root, 'inside/deep/nested'), { recursive: true });
      await fs.symlink(path.join(root, 'inside'), path.join(root, 'link'));
      const file = path.join(root, 'link/deep/nested/a');
      await fs.writeFile(file, 'original');
      const storage = new VscodeSnapshotFs(); const target = new VscodeSnapshotFs(root);
      const store = await RollbackStore.forWorkspace(storage, storageRoot, root, target);
      await store.runExclusive(async () => {
        await store.snapshotBeforeApply(1, file);
        await fs.rm(path.join(root, 'inside/deep'), { recursive: true });
      });
      const realpath = fs.realpath.bind(fs);
      let intercepted = false;
      const lookup = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
        // Validation stops at the absent deep directory. Only document lookup
        // calls realpath on the full absent target, after the first guard.
        if (args[0] === file) {
          intercepted = true;
          await fs.unlink(path.join(root, 'link'));
          await fs.symlink(outside, path.join(root, 'link'));
          throw Object.assign(new Error('missing restore document'), { code: 'ENOENT' });
        }
        return realpath(...args);
      });
      const result = await store.revertAll();
      lookup.mockRestore();
      expect(intercepted).toBe(true);
      expect(result.errors).toHaveLength(1);
      const fresh = await RollbackStore.forWorkspace(storage, storageRoot, root, target);
      expect(fresh.hasSnapshots()).toBe(true);
      expect(await fs.readdir(outside)).toEqual([]);
      await fs.unlink(path.join(root, 'link'));
      await fs.symlink(path.join(root, 'inside'), path.join(root, 'link'));
      expect((await fresh.revertAll()).restored).toBe(1);
      expect(await fs.readFile(file, 'utf8')).toBe('original');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
      await fs.rm(storageRoot, { recursive: true, force: true });
    }
  });

  it('rechecks after applyEdit before saving when a parent symlink is retargeted (R8)', async () => {
    await fs.mkdir(path.join(root, 'inside')); const outside = await fs.mkdtemp(path.join(tmpdir(), 'jit-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'a'), 'outside sentinel');
      await fs.symlink(path.join(root, 'inside'), path.join(root, 'link'));
      const file = path.join(root, 'link/a'); await fs.writeFile(file, 'generated'); const doc = document(file, 'generated');
      host.applyEdit.mockImplementation(async () => {
        await fs.unlink(path.join(root, 'link')); await fs.symlink(outside, path.join(root, 'link')); return true;
      });
      await expect(new VscodeSnapshotFs(root).write(file, 'original')).rejects.toThrow();
      expect(doc.save).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(outside, 'a'), 'utf8')).toBe('outside sentinel');
      await expect(new VscodeSnapshotFs(root).remove(file)).rejects.toThrow();
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
});
