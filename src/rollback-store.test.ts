import { describe, it, expect, afterEach } from 'vitest';
import * as nodeFs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { RollbackStore, type SnapshotFs } from './rollback-store';

class MemFs implements SnapshotFs {
  files = new Map<string, string>();
  async read(p: string): Promise<string | undefined> {
    return this.files.get(p);
  }
  async write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string): Promise<void> {
    await this.write(p, c);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
}

const BASE = '/storage';
const SID = 'sess-1';

describe('RollbackStore', () => {
  it('restores an edited file to its pre-walkthrough content', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'original');
    const store = new RollbackStore(fs, BASE, SID);

    await store.snapshotBeforeApply(1, '/repo/a.ts');
    await fs.write('/repo/a.ts', 'edited');

    const result = await store.revertAll();
    expect(fs.files.get('/repo/a.ts')).toBe('original');
    expect(result.restored).toBe(1);
  });

  it('deletes a file that did not exist before the walkthrough (create step)', async () => {
    const fs = new MemFs();
    const store = new RollbackStore(fs, BASE, SID);

    await store.snapshotBeforeApply(1, '/repo/new.ts'); // does not exist yet
    await fs.write('/repo/new.ts', 'created content');

    const result = await store.revertAll();
    expect(fs.files.has('/repo/new.ts')).toBe(false);
    expect(result.deleted).toBe(1);
  });

  it('keeps only the earliest pristine snapshot when a file is touched twice', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'v0');
    const store = new RollbackStore(fs, BASE, SID);

    await store.snapshotBeforeApply(1, '/repo/a.ts');
    await fs.write('/repo/a.ts', 'v1');
    await store.snapshotBeforeApply(2, '/repo/a.ts'); // must NOT overwrite pristine
    await fs.write('/repo/a.ts', 'v2');

    await store.revertAll();
    expect(fs.files.get('/repo/a.ts')).toBe('v0');
  });

  it('restores multiple files', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'A0');
    fs.files.set('/repo/b.ts', 'B0');
    const store = new RollbackStore(fs, BASE, SID);

    await store.snapshotBeforeApply(1, '/repo/a.ts');
    await store.snapshotBeforeApply(2, '/repo/b.ts');
    await fs.write('/repo/a.ts', 'A1');
    await fs.write('/repo/b.ts', 'B1');

    const result = await store.revertAll();
    expect(fs.files.get('/repo/a.ts')).toBe('A0');
    expect(fs.files.get('/repo/b.ts')).toBe('B0');
    expect(result.restored).toBe(2);
  });

  it('survives a fresh store instance (persisted index) — revert after reload', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'pristine');
    const store1 = new RollbackStore(fs, BASE, SID);
    await store1.snapshotBeforeApply(1, '/repo/a.ts');
    await fs.write('/repo/a.ts', 'mutated');

    // Simulate reload: brand new store over the same fs/dir.
    const store2 = new RollbackStore(fs, BASE, SID);
    await store2.load();
    await store2.revertAll();
    expect(fs.files.get('/repo/a.ts')).toBe('pristine');
  });

  it('does not count a deletion when the created file never landed on disk (R2)', async () => {
    const fs = new MemFs();
    const store = new RollbackStore(fs, BASE, SID);
    await store.snapshotBeforeApply(1, '/repo/never.ts'); // create step; file never actually written
    const result = await store.revertAll();
    expect(result.deleted).toBe(0);
  });

  it('records an error when a snapshot file is missing at revert time', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'v0');
    const store = new RollbackStore(fs, BASE, SID);
    await store.snapshotBeforeApply(1, '/repo/a.ts');
    for (const k of [...fs.files.keys()]) {
      if (k.endsWith('.snap')) {
        fs.files.delete(k); // simulate a lost snapshot
      }
    }
    const result = await store.revertAll();
    expect(result.restored).toBe(0);
    expect(result.errors.length).toBe(1);
  });

  it('load() reconstructs seq so new snapshots do not collide', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'v0');
    const s1 = new RollbackStore(fs, BASE, SID);
    await s1.snapshotBeforeApply(1, '/repo/a.ts'); // writes 0.snap

    const s2 = new RollbackStore(fs, BASE, SID);
    await s2.load();
    fs.files.set('/repo/b.ts', 'w0');
    await s2.snapshotBeforeApply(2, '/repo/b.ts'); // must be 1.snap, not clobber 0.snap
    const snaps = [...fs.files.keys()].filter((k) => k.endsWith('.snap'));
    expect(snaps.length).toBe(2);
  });

  it('revertAll catches a failing remove and records it', async () => {
    const fs = new MemFs();
    const store = new RollbackStore(fs, BASE, SID);
    await store.snapshotBeforeApply(1, '/repo/created.ts'); // did not exist -> create step
    await fs.write('/repo/created.ts', 'new');
    fs.remove = async () => {
      throw new Error('EPERM');
    };
    const result = await store.revertAll();
    expect(result.errors.length).toBe(1);
  });

  it('load() rejects corrupt metadata without discarding evidence', async () => {
    const fs = new MemFs();
    fs.files.set('/storage/snapshots/sess-1/index.json', '{ this is not json');
    const store = new RollbackStore(fs, BASE, SID);
    await expect(store.load()).rejects.toThrow();
    expect(fs.files.get('/storage/snapshots/sess-1/index.json')).toBe('{ this is not json');
    expect(store.hasSnapshots()).toBe(false);
  });

  it('reports hasSnapshots', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'x');
    const store = new RollbackStore(fs, BASE, SID);
    expect(store.hasSnapshots()).toBe(false);
    await store.snapshotBeforeApply(1, '/repo/a.ts');
    expect(store.hasSnapshots()).toBe(true);
  });
});

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => nodeFs.rm(p, { recursive: true, force: true }))); });
async function root(): Promise<string> {
  const p = await nodeFs.mkdtemp(path.join(tmpdir(), 'jit-recovery-'));
  temporary.push(p);
  return p;
}
function indexFile(fs: MemFs): string {
  return [...fs.files.keys()].find(p => p.endsWith('/index.json'))!;
}

describe('durable workspace journal', () => {
  it('does not publish a failed index commit; retry and reload recover the original (R1)', async () => {
    const fs = new MemFs();
    const store = new RollbackStore(fs, BASE, SID);
    fs.files.set('/repo/a', 'A0');
    fs.writeAtomic = async () => { throw new Error('ENOSPC'); };
    await expect(store.snapshotBeforeApply(1, '/repo/a')).rejects.toThrow('ENOSPC');
    expect(store.hasSnapshots()).toBe(false);
    fs.writeAtomic = async (p, c) => { fs.files.set(p, c); };
    await store.snapshotBeforeApply(1, '/repo/a');
    fs.files.set('/repo/a', 'A1');
    const reloaded = new RollbackStore(fs, BASE, SID);
    await reloaded.load();
    expect((await reloaded.revertAll()).errors).toEqual([]);
    expect(fs.files.get('/repo/a')).toBe('A0');
  });

  it('uses a stable workspace journal outside the root, retaining earliest preimages across independent instances (R2/R9)', async () => {
    const workspace = await root();
    const storage = new MemFs();
    const target = new MemFs();
    const file = path.join(workspace, 'a');
    target.files.set(file, 'A0');
    storage.files.set('/storage/snapshots/legacy-random/index.json', 'legacy');
    const first = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    const second = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    await first.runExclusive(async () => { await first.snapshotBeforeApply(1, file); await target.write(file, 'A1'); });
    await second.runExclusive(async () => { await second.snapshotBeforeApply(2, file); await target.write(file, 'A2'); });
    const fresh = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    expect((await fresh.revertAll()).restored).toBe(1);
    expect(target.files.get(file)).toBe('A0');
    expect(storage.files.get('/storage/snapshots/legacy-random/index.json')).toBe('legacy');
    target.files.set(file, 'user edit');
    expect((await fresh.revertAll()).restored).toBe(0);
    expect(target.files.get(file)).toBe('user edit');
    await fresh.runExclusive(async () => { await fresh.snapshotBeforeApply(3, file); await target.write(file, 'A3'); });
    await fresh.revertAll();
    expect(target.files.get(file)).toBe('user edit');
  });

  it('serializes the whole snapshot and mutation across two stores before recovery', async () => {
    const workspace = await root();
    const fs = new MemFs();
    const file = path.join(workspace, 'a');
    fs.files.set(file, 'A0');
    const a = await RollbackStore.forWorkspace(fs, BASE, workspace);
    const b = await RollbackStore.forWorkspace(fs, BASE, workspace);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const apply = a.runExclusive(async () => {
      await a.snapshotBeforeApply(1, file);
      entered();
      await gate;
      await fs.write(file, 'A1');
    });
    await started;
    const revert = b.revertAll();
    release();
    await apply;
    expect((await revert).restored).toBe(1);
    expect(fs.files.get(file)).toBe('A0');
    await expect(a.runExclusive(async () => { throw new Error('mutation failed'); })).rejects.toThrow('mutation failed');
    expect(await b.runExclusive(async () => 'usable')).toBe('usable');
  });

  it('retains failed entries across reload, retires successes, and retries only failures', async () => {
    const workspace = await root();
    const storage = new MemFs();
    const target = new MemFs();
    const a = path.join(workspace, 'a');
    const b = path.join(workspace, 'b');
    target.files.set(a, 'A0'); target.files.set(b, 'B0');
    const store = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    await store.snapshotBeforeApply(1, a); await store.snapshotBeforeApply(1, b);
    target.files.set(a, 'A1'); target.files.set(b, 'B1');
    target.write = async (p, c) => { if (p === a) throw new Error('NoPermissions'); target.files.set(p, c); };
    expect((await store.revertAll()).errors).toHaveLength(1);
    expect(target.files.get(b)).toBe('B0');
    target.files.set(b, 'later user edit');
    target.write = async (p, c) => { target.files.set(p, c); };
    const fresh = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    expect((await fresh.revertAll()).restored).toBe(1);
    expect(target.files.get(a)).toBe('A0'); expect(target.files.get(b)).toBe('later user edit');
    expect(fresh.hasSnapshots()).toBe(false);
  });

  it('retains snapshots when retirement commit fails and reports read failures without reset', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a', 'A0');
    const store = new RollbackStore(fs, BASE, SID);
    await store.snapshotBeforeApply(1, '/repo/a');
    const saved = fs.files.get(indexFile(fs));
    fs.writeAtomic = async () => { throw new Error('ENOSPC'); };
    expect((await store.revertAll()).errors.join()).toContain('ENOSPC');
    expect(store.hasSnapshots()).toBe(true);
    expect(fs.files.get(indexFile(fs))).toBe(saved);
    expect([...fs.files.keys()].filter(p => p.endsWith('.snap'))).toHaveLength(1);
    fs.read = async () => { throw new Error('NoPermissions'); };
    await expect(store.load()).rejects.toThrow('NoPermissions');
    expect(store.hasSnapshots()).toBe(true);
    await expect(store.snapshotBeforeApply(2, '/repo/new')).rejects.toThrow('NoPermissions');
  });

  it.each(['null', '{}', '{"version":99,"order":[]}', ''])('rejects malformed journal %s without erasing it', async (raw) => {
    const fs = new MemFs();
    const file = '/storage/snapshots/sess-1/index.json';
    fs.files.set(file, raw);
    await expect(new RollbackStore(fs, BASE, SID).load()).rejects.toThrow();
    expect(fs.files.get(file)).toBe(raw);
  });

  it.each(['root', 'path', 'snapFile'])('rejects tampered %s metadata before any target access', async (field) => {
    const workspace = await root();
    const storage = new MemFs(); const target = new MemFs();
    const file = path.join(workspace, 'a'); target.files.set(file, 'A0');
    const store = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    await store.snapshotBeforeApply(1, file);
    const index = indexFile(storage); const data = JSON.parse(storage.files.get(index)!);
    if (field === 'root') data.root = '/wrong-root';
    else data.order[0][field] = '../../outside';
    const tampered = JSON.stringify(data); storage.files.set(index, tampered);
    target.read = target.write = target.remove = async () => { throw new Error('target accessed'); };
    await expect(RollbackStore.forWorkspace(storage, BASE, workspace, target)).rejects.toThrow(/journal/i);
    expect(storage.files.get(index)).toBe(tampered);
  });

  it.each([true, false])('retains an unsafe symlink target (existed=%s), restores safe entries and retries after repair', async (existed) => {
    const workspace = await root(); const outside = await root();
    await nodeFs.mkdir(path.join(workspace, 'sub'));
    const storage = new MemFs(); const target = new MemFs();
    const unsafe = path.join(workspace, 'sub/a'); const safe = path.join(workspace, 'safe');
    if (existed) target.files.set(unsafe, 'A0');
    target.files.set(safe, 'S0');
    const store = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    await store.snapshotBeforeApply(1, unsafe); await store.snapshotBeforeApply(1, safe);
    target.files.set(unsafe, 'A1'); target.files.set(safe, 'S1');
    await nodeFs.rename(path.join(workspace, 'sub'), path.join(workspace, 'saved-sub'));
    await nodeFs.symlink(outside, path.join(workspace, 'sub'));
    const fresh = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    const result = await fresh.revertAll();
    expect(result.errors).toHaveLength(1); expect(result.restored).toBe(1);
    expect(target.files.get(unsafe)).toBe('A1'); expect(fresh.hasSnapshots()).toBe(true);
    await nodeFs.unlink(path.join(workspace, 'sub'));
    await nodeFs.rename(path.join(workspace, 'saved-sub'), path.join(workspace, 'sub'));
    const retry = await RollbackStore.forWorkspace(storage, BASE, workspace, target);
    expect((await retry.revertAll()).errors).toEqual([]);
    expect(target.files.get(unsafe)).toBe(existed ? 'A0' : undefined);
    expect(retry.hasSnapshots()).toBe(false);
  });
});

class DiskFs implements SnapshotFs {
  async read(file: string): Promise<string | undefined> {
    try { return await nodeFs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async write(file: string, content: string): Promise<void> {
    await nodeFs.mkdir(path.dirname(file), { recursive: true }); await nodeFs.writeFile(file, content);
  }
  async writeAtomic(file: string, content: string): Promise<void> {
    await this.write(`${file}.tmp`, content); await nodeFs.rename(`${file}.tmp`, file);
  }
  async remove(file: string): Promise<void> { await nodeFs.rm(file, { force: true }); }
  async exists(file: string): Promise<boolean> { return (await this.read(file)) !== undefined; }
}

describe('recovery filesystem integration', () => {
  it('recovers actual rename source and destination from separate outside storage after fresh construction', async () => {
    const workspace = await root(); const storageRoot = await root();
    const source = path.join(workspace, 'source'); const destination = path.join(workspace, 'destination');
    await nodeFs.writeFile(source, 'source baseline'); await nodeFs.writeFile(destination, 'destination baseline');
    const store = await RollbackStore.forWorkspace(new DiskFs(), storageRoot, workspace, new DiskFs());
    await store.runExclusive(async () => {
      await store.snapshotBeforeApply(1, source); await store.snapshotBeforeApply(1, destination);
      await nodeFs.rename(source, destination);
    });
    const fresh = await RollbackStore.forWorkspace(new DiskFs(), storageRoot, workspace, new DiskFs());
    expect((await fresh.revertAll()).restored).toBe(2);
    expect(await nodeFs.readFile(source, 'utf8')).toBe('source baseline');
    expect(await nodeFs.readFile(destination, 'utf8')).toBe('destination baseline');
    expect(fresh.hasSnapshots()).toBe(false);
  });

  it('rejects a tampered snapshot basename without reading outside real journal storage', async () => {
    const workspace = await root(); const storageRoot = await root(); const fs = new DiskFs();
    const file = path.join(workspace, 'a'); await fs.write(file, 'baseline');
    const store = await RollbackStore.forWorkspace(fs, storageRoot, workspace, fs);
    await store.snapshotBeforeApply(1, file); await fs.write(file, 'generated');
    const journals = await nodeFs.readdir(path.join(storageRoot, 'snapshots'));
    const index = path.join(storageRoot, 'snapshots', journals[0]!, 'index.json');
    const data = JSON.parse((await fs.read(index))!); data.order[0].snapFile = '../../../outside';
    await fs.write(index, JSON.stringify(data));
    const read = fs.read.bind(fs); const reads: string[] = [];
    fs.read = async p => { reads.push(p); return read(p); };
    await expect(RollbackStore.forWorkspace(fs, storageRoot, workspace, fs)).rejects.toThrow(/journal/);
    expect(reads).toEqual([index]); expect(await nodeFs.readFile(file, 'utf8')).toBe('generated');
    expect(JSON.parse(await nodeFs.readFile(index, 'utf8')).order).toHaveLength(1);
  });

  it('fresh recovery never writes or deletes external sentinels and retries the unsafe entry after repair', async () => {
    const workspace = await root(); const storageRoot = await root(); const outside = await root(); const fs = new DiskFs();
    await fs.write(path.join(workspace, 'sub/a'), 'A0'); await fs.write(path.join(workspace, 'safe'), 'S0');
    await fs.write(path.join(outside, 'a'), 'outside A'); await fs.write(path.join(outside, 'new'), 'outside new');
    const store = await RollbackStore.forWorkspace(fs, storageRoot, workspace, fs);
    for (const relative of ['sub/a', 'sub/new', 'safe']) await store.snapshotBeforeApply(1, path.join(workspace, relative));
    await fs.write(path.join(workspace, 'sub/a'), 'A1'); await fs.write(path.join(workspace, 'sub/new'), 'new');
    await fs.write(path.join(workspace, 'safe'), 'S1');
    await nodeFs.rename(path.join(workspace, 'sub'), path.join(workspace, 'saved'));
    await nodeFs.symlink(outside, path.join(workspace, 'sub'));
    const fresh = await RollbackStore.forWorkspace(fs, storageRoot, workspace, fs);
    const result = await fresh.revertAll(); expect(result.restored).toBe(1); expect(result.errors).toHaveLength(2);
    expect(await fs.read(path.join(outside, 'a'))).toBe('outside A');
    expect(await fs.read(path.join(outside, 'new'))).toBe('outside new');
    await nodeFs.unlink(path.join(workspace, 'sub')); await nodeFs.rename(path.join(workspace, 'saved'), path.join(workspace, 'sub'));
    const retry = await RollbackStore.forWorkspace(fs, storageRoot, workspace, fs);
    expect(await retry.revertAll()).toEqual({ restored: 1, deleted: 1, errors: [] });
    expect(await fs.read(path.join(workspace, 'sub/a'))).toBe('A0');
    expect(await fs.read(path.join(workspace, 'sub/new'))).toBeUndefined();
  });
});
