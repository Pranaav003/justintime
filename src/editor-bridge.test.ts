import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HydratedStep } from './types';

const host = vi.hoisted(() => ({
  open: vi.fn(), show: vi.fn(), apply: vi.fn(), find: vi.fn(), save: vi.fn(), reveal: vi.fn(), decorate: vi.fn(),
}));
vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath, path: fsPath, toString: () => fsPath });
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: unknown, public end: unknown) {} }
  class WorkspaceEdit {
    replace = vi.fn(); createFile = vi.fn(); deleteFile = vi.fn(); renameFile = vi.fn();
  }
  class RelativePattern { constructor(public baseUri: unknown, public pattern: string) {} }
  return {
    Uri: { file: uri, joinPath: (base: { fsPath: string }, rel: string) => uri(path.resolve(base.fsPath, rel)), from: ({ path: name }: { path: string }) => uri(name) },
    Position, Range, WorkspaceEdit, RelativePattern,
    workspace: {
      openTextDocument: host.open, applyEdit: host.apply, findFiles: host.find,
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      asRelativePath: () => 'wrong-workspace-relative',
    },
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      showTextDocument: host.show, visibleTextEditors: [],
    },
    ViewColumn: { One: 1 }, TextEditorRevealType: { InCenter: 1 }, commands: { executeCommand: vi.fn() },
  };
});
import { EditorBridge } from './editor-bridge';
import { WorkspacePathError } from './workspace-paths';

let temp: string;
let root: string;
let outside: string;
let bridge: EditorBridge;
const fileUri = (fsPath: string) => ({ fsPath, path: fsPath });
function step(kind: HydratedStep['changeKind'], primaryFile: string, renameTo?: string): HydratedStep {
  return { changeKind: kind, primaryFile, renameTo, stepNumber: 1, hazards: [], fullFileContent: 'new',
    navigation: { file: primaryFile, startLine: 1, endLine: 1 },
    hunks: [{ contextBefore: '', oldText: 'old', newText: 'new', contextAfter: '' }] };
}
async function retarget() {
  await fs.unlink(path.join(root, 'link'));
  await fs.symlink(outside, path.join(root, 'link'));
}
beforeEach(async () => {
  vi.resetAllMocks();
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jit-editor-'));
  root = path.join(temp, 'workspace'); outside = path.join(temp, 'workspace-other');
  await fs.mkdir(path.join(root, 'real'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'real/file'), 'old');
  await fs.writeFile(path.join(outside, 'file'), 'sentinel');
  await fs.symlink(path.join(root, 'real'), path.join(root, 'link'));
  host.open.mockImplementation(async (uri: { fsPath: string }) => {
    const text = await fs.readFile(uri.fsPath, 'utf8');
    return { uri, getText: () => text, positionAt: (n: number) => ({ line: 0, character: n }),
      lineCount: 1, lineAt: () => ({ range: { end: { line: 0, character: text.length } } }), save: host.save };
  });
  host.save.mockResolvedValue(true);
  host.apply.mockResolvedValue(true);
  host.find.mockResolvedValue([]);
  host.show.mockResolvedValue({ revealRange: host.reveal, setDecorations: host.decorate });
  bridge = new EditorBridge(root, { highlightColor: 'red', secondaryHighlightColor: 'blue' });
});
afterEach(async () => {
  bridge.dispose();
  await fs.rm(temp, { force: true, recursive: true });
});

describe('EditorBridge workspace boundary', () => {
  it('reads an internal symlink and revalidates repeated access after retarget', async () => {
    expect(await bridge.readFile('link/file')).toBe('old');
    await retarget();
    await expect(bridge.readFile('link/file')).rejects.toBeInstanceOf(WorkspacePathError);
    await expect(bridge.navigateTo('link/file', 1, 1)).rejects.toBeInstanceOf(WorkspacePathError);
    expect(host.open).toHaveBeenCalledTimes(1);
    expect(host.show).not.toHaveBeenCalled();
  });

  it.each(['edit', 'create', 'delete', 'rename'] as const)('rejects external symlinks before %s without opening or mutating outside files', async (kind) => {
    await retarget();
    expect(await bridge.applyStep(step(kind, 'link/file', 'safe'))).toMatchObject({ status: 'error' });
    expect(host.open).not.toHaveBeenCalled();
    expect(host.apply).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(outside, 'file'), 'utf8')).toBe('sentinel');
  });

  it('validates both rename endpoints', async () => {
    await retarget();
    expect(await bridge.applyStep(step('rename', 'real/file', 'link/file'))).toMatchObject({ status: 'error' });
    expect(host.apply).not.toHaveBeenCalled();
  });

  it.each(['edit', 'create', 'delete', 'rename'] as const)('rejects a workspace-root %s target', async (kind) => {
    expect(await bridge.applyStep(step(kind, '.', 'safe'))).toMatchObject({ status: 'error' });
    expect(host.apply).not.toHaveBeenCalled();
  });

  it('checks again after document open before edit application', async () => {
    const open = host.open.getMockImplementation()!;
    host.open.mockImplementation(async (...args: unknown[]) => { const doc = await open(...args); await retarget(); return doc; });
    expect(await bridge.applyStep(step('edit', 'link/file'))).toMatchObject({ status: 'error' });
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.save).not.toHaveBeenCalled();
  });

  it('checks again after applyEdit before saving', async () => {
    host.apply.mockImplementation(async () => { await retarget(); return true; });
    expect(await bridge.applyStep(step('edit', 'link/file'))).toMatchObject({ status: 'error' });
    expect(host.apply).toHaveBeenCalledTimes(1);
    expect(host.save).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(outside, 'file'), 'utf8')).toBe('sentinel');
  });

  it.each(['read', 'navigate'] as const)('checks again after open before %s continuation', async (operation) => {
    const open = host.open.getMockImplementation()!;
    host.open.mockImplementation(async (...args: unknown[]) => { const doc = await open(...args); await retarget(); return doc; });
    const result = operation === 'read' ? bridge.readFile('link/file') : bridge.navigateTo('link/file', 1, 1);
    await expect(result).rejects.toBeInstanceOf(WorkspacePathError);
    expect(host.show).not.toHaveBeenCalled();
  });

  it('keeps read and navigation missing semantics while surfacing other host errors', async () => {
    for (const code of ['FileNotFound', 'ENOENT']) {
      host.open.mockRejectedValue(Object.assign(new Error(code), { code }));
      expect(await bridge.readFile('new/deep/file')).toBeUndefined();
      await expect(bridge.navigateTo('new/deep/file', 1, 1)).resolves.toBeUndefined();
    }
    for (const code of ['NoPermissions', 'Unavailable', 'EIO']) {
      const error = Object.assign(new Error(code), { code });
      host.open.mockRejectedValue(error);
      await expect(bridge.readFile('real/file')).rejects.toBe(error);
      await expect(bridge.navigateTo('real/file', 1, 1)).rejects.toBe(error);
      await expect(bridge.readFile('new/deep/file')).rejects.toBe(error);
      await expect(bridge.navigateTo('new/deep/file', 1, 1)).rejects.toBe(error);
    }
  });

  it('classifies uncoded resolver errors using fresh disk absence for reads and navigation', async () => {
    const wrapped = Object.assign(new Error('opaque resolver failure'), { name: 'CodeExpectedError', code: undefined });
    host.open.mockRejectedValue(wrapped);
    expect(await bridge.readFile('new/deep/file')).toBeUndefined();
    await expect(bridge.navigateTo('new/deep/file', 1, 1)).resolves.toBeUndefined();
    expect(host.show).not.toHaveBeenCalled();
    await expect(bridge.readFile('real/file')).rejects.toBe(wrapped);
    await expect(bridge.navigateTo('real/file', 1, 1)).rejects.toBe(wrapped);
  });

  it.each(['EACCES', 'EIO'])('preserves %s when disk stat fails after an uncoded resolver error', async (code) => {
    const wrapped = Object.assign(new Error('opaque resolver failure'), { name: 'CodeExpectedError' });
    const failure = Object.assign(new Error(code), { code });
    host.open.mockRejectedValue(wrapped);
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation((async (target: Parameters<typeof fs.stat>[0]) => {
      if (target === path.join(root, 'new/deep/file')) throw failure;
      return stat(target);
    }) as typeof fs.stat);
    try {
      await expect(bridge.readFile('new/deep/file')).rejects.toBe(failure);
      await expect(bridge.navigateTo('new/deep/file', 1, 1)).rejects.toBe(failure);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('revalidates containment before stat classification after an uncoded open failure', async () => {
    host.open.mockImplementation(async () => { await retarget(); throw new Error('opaque resolver failure'); });
    await expect(bridge.readFile('link/new')).rejects.toBeInstanceOf(WorkspacePathError);
  });

  it('uses selected-root RelativePattern, 600 cap, root-relative names and filters canonical escapes', async () => {
    await retarget();
    host.find.mockResolvedValue([
      fileUri(path.join(root, 'real/file')), fileUri(path.join(root, 'link/file')), fileUri(path.join(outside, 'file')),
    ]);
    expect(await bridge.listFiles()).toEqual(['real/file']);
    const [pattern, exclude, cap] = host.find.mock.calls[0]!;
    expect(pattern).toMatchObject({ baseUri: { fsPath: root }, pattern: '**/*' });
    expect(exclude).toContain('**/node_modules/**');
    expect(cap).toBe(600);
    expect(await bridge.searchCode('sentinel')).toBe('(no matches for "sentinel")');
    expect(host.open).toHaveBeenCalledTimes(1);
    expect(host.open.mock.calls[0]![0].fsPath).toBe(path.join(root, 'real/file'));
  });

  it('stops search before reads when cancellation arrives during enumeration', async () => {
    const controller = new AbortController();
    host.find.mockImplementation(async () => {
      controller.abort();
      return [fileUri(path.join(root, 'real/file'))];
    });
    await expect(bridge.searchCode('old', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.open).not.toHaveBeenCalled();
  });

  it('stops additional search reads after cancellation during an already-started read', async () => {
    const controller = new AbortController();
    host.find.mockResolvedValue([fileUri(path.join(root, 'real/file')), fileUri(path.join(root, 'real/second'))]);
    const open = host.open.getMockImplementation()!;
    host.open.mockImplementation(async (...args: unknown[]) => {
      const doc = await open(...args);
      controller.abort();
      return doc;
    });
    await expect(bridge.searchCode('old', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.open).toHaveBeenCalledTimes(1);
  });

  it('bounds even a malformed oversized enumeration response and does not recursively enumerate', async () => {
    host.find.mockResolvedValue(Array.from({ length: 650 }, (_, n) => fileUri(path.join(root, `new-${n}`))));
    expect(await bridge.listFiles()).toHaveLength(600);
    expect(host.find).toHaveBeenCalledTimes(1);
  });
});
