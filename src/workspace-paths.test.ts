import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePaths, WorkspacePathError, isFileNotFound } from './workspace-paths';

let temp: string;
let root: string;
let outside: string;
let paths: WorkspacePaths;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jit-paths-'));
  root = path.join(temp, 'workspace');
  outside = path.join(temp, 'workspace-other');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  paths = new WorkspacePaths(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temp, { recursive: true, force: true });
});

describe('WorkspacePaths', () => {
  it('accepts descendants, ..name and absent nested destinations with stable lexical identities', async () => {
    await fs.mkdir(path.join(root, '..cache'));
    await fs.writeFile(path.join(root, '..cache/file.txt'), 'inside');
    expect(await paths.resolve('..cache/file.txt')).toBe(path.join(root, '..cache/file.txt'));
    expect(await paths.resolve('new/deep/file')).toBe(path.join(root, 'new/deep/file'));
    expect(await paths.validateAbsolute(path.join(root, 'new/file'))).toBe(path.join(root, 'new/file'));
    expect(await paths.canonicalRoot()).toBe(await fs.realpath(root));
  });

  it.each(['', '.', './', '..', '../workspace-other/secret', '/tmp/secret', 'C:\\secret', 'C:secret', '\\\\server\\share', '\\secret', 'file\0name'])('rejects unsafe relative target %j', async (target) => {
    await expect(paths.resolve(target)).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('rejects absolute root and prefix siblings without mistaking ..name for traversal', async () => {
    await expect(paths.validateAbsolute(root)).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(paths.validateAbsolute(path.join(outside, 'secret'))).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(paths.validateAbsolute('relative')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('accepts internal symlinks including new nested destinations but rejects external and dangling links', async () => {
    await fs.mkdir(path.join(root, 'real'));
    await fs.writeFile(path.join(root, 'real/file'), 'inside');
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'));
    expect(await paths.resolve('link/file')).toBe(path.join(root, 'link/file'));
    expect(await paths.resolve('link/new/deep/file')).toBe(path.join(root, 'link/new/deep/file'));
    await fs.unlink(path.join(root, 'link'));
    await fs.symlink(outside, path.join(root, 'link'));
    await expect(paths.resolve('link/file')).rejects.toBeInstanceOf(WorkspacePathError);
    await fs.unlink(path.join(root, 'link'));
    await fs.symlink(path.join(outside, 'missing'), path.join(root, 'link'));
    await expect(paths.resolve('link/new/deep/file')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('freshly rejects a previously validated symlink after retargeting', async () => {
    await fs.mkdir(path.join(root, 'real'));
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'));
    await paths.resolve('link/file');
    await fs.unlink(path.join(root, 'link'));
    await fs.symlink(outside, path.join(root, 'link'));
    await expect(paths.resolve('link/file')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('pins root identity and rejects replacement with a symlink or a different directory', async () => {
    await paths.resolve('file');
    await fs.rename(root, `${root}-original`);
    await fs.symlink(outside, root);
    await expect(paths.resolve('file')).rejects.toBeInstanceOf(WorkspacePathError);
    await fs.unlink(root);
    await fs.mkdir(root);
    await expect(paths.resolve('file')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('rejects a symlink alias targeting the workspace root itself', async () => {
    await fs.symlink(root, path.join(root, 'alias'));
    await expect(paths.resolve('alias')).rejects.toBeInstanceOf(WorkspacePathError);
    expect(await paths.resolve('alias/new/file')).toBe(path.join(root, 'alias/new/file'));
  });

  it('reports root disappearance as a containment failure rather than a missing file', async () => {
    await paths.resolve('file');
    await fs.rename(root, `${root}-original`);
    await expect(paths.resolve('file')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it.each(['EACCES', 'EIO'])('propagates %s from lstat and realpath rather than treating it as absent', async (code) => {
    await fs.mkdir(path.join(root, 'existing'));
    await paths.canonicalRoot();
    const failure = Object.assign(new Error(code), { code });
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0]) => {
      if (target === path.join(root, 'existing')) throw failure;
      return original(target);
    }) as typeof fs.lstat);
    await expect(paths.resolve('existing/new/file')).rejects.toBe(failure);
    vi.restoreAllMocks();
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation((async (target: Parameters<typeof fs.realpath>[0]) => {
      if (target === path.join(root, 'existing')) throw failure;
      return realpath(target);
    }) as typeof fs.realpath);
    await expect(paths.resolve('existing/new/file')).rejects.toBe(failure);
  });

  it('recognizes only actual Node or VS Code missing errors', () => {
    expect(isFileNotFound({ code: 'ENOENT' })).toBe(true);
    expect(isFileNotFound({ code: 'FileNotFound' })).toBe(true);
    for (const code of ['EACCES', 'EIO', 'NoPermissions', 'Unavailable', 'ENOTDIR']) {
      expect(isFileNotFound({ code })).toBe(false);
    }
    expect(isFileNotFound(new Error('FileNotFound'))).toBe(false);
  });
});
