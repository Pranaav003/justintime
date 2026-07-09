import { describe, it, expect } from 'vitest';
import { RollbackStore, type SnapshotFs } from './rollback-store';

class MemFs implements SnapshotFs {
  files = new Map<string, string>();
  async read(p: string): Promise<string | undefined> {
    return this.files.get(p);
  }
  async write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
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

  it('reports hasSnapshots', async () => {
    const fs = new MemFs();
    fs.files.set('/repo/a.ts', 'x');
    const store = new RollbackStore(fs, BASE, SID);
    expect(store.hasSnapshots()).toBe(false);
    await store.snapshotBeforeApply(1, '/repo/a.ts');
    expect(store.hasSnapshots()).toBe(true);
  });
});
