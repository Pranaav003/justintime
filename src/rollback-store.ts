import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { WorkspacePaths } from './workspace-paths';

/** Storage and workspace access are separate capabilities. Missing reads return undefined. */
export interface SnapshotFs {
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  /** Replace an index using a same-directory temporary file and atomic rename. */
  writeAtomic(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

interface SnapshotEntry {
  /** Workspace-relative in workspace journals; absolute only for the legacy constructor. */
  path: string;
  existedBefore: boolean;
  /** Immutable basename, never an arbitrary filesystem path. */
  snapFile?: string;
  step: number;
}

export interface RevertResult {
  restored: number;
  deleted: number;
  errors: string[];
}

// A host has one lane per journal, including separately constructed stores.
// This intentionally does not promise cross-process locking.
const lanes = new Map<string, Promise<void>>();

export class RollbackStore {
  private index: SnapshotEntry[] = [];
  private readonly dir: string;
  private readonly indexPath: string;
  private targetFs: SnapshotFs;
  private paths?: WorkspacePaths;
  private root: string | null = null;

  constructor(private readonly fs: SnapshotFs, baseDir: string, sessionId: string) {
    this.dir = path.join(baseDir, 'snapshots', sessionId);
    this.indexPath = path.join(this.dir, 'index.json');
    this.targetFs = fs;
  }

  static async forWorkspace(
    storageFs: SnapshotFs, baseDir: string, workspaceRoot: string, targetFs: SnapshotFs = storageFs,
  ): Promise<RollbackStore> {
    const paths = new WorkspacePaths(workspaceRoot);
    const root = await paths.canonicalRoot();
    const id = `workspace-${createHash('sha256').update(root).digest('hex')}`;
    const store = new RollbackStore(storageFs, baseDir, id);
    store.paths = paths;
    store.root = root;
    store.targetFs = targetFs;
    await store.runExclusive(async () => {});
    return store;
  }

  hasSnapshots(): boolean { return this.index.length > 0; }

  /** Call once around ALL snapshots and the corresponding editor mutation. Do not nest. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = lanes.get(this.indexPath) ?? Promise.resolve();
    const result = previous.then(async () => {
      await this.load();
      return operation();
    });
    const tail = result.then(() => {}, () => {});
    lanes.set(this.indexPath, tail);
    void tail.then(() => { if (lanes.get(this.indexPath) === tail) lanes.delete(this.indexPath); });
    return result;
  }

  /** Corruption or permission failure must leave recovery evidence intact. */
  async load(): Promise<void> {
    if (this.paths) await this.paths.canonicalRoot();
    const raw = await this.fs.read(this.indexPath);
    if (raw === undefined) { this.index = []; return; }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error('Invalid recovery journal JSON'); }
    if (!data || typeof data !== 'object') throw new Error('Invalid recovery journal');
    const journal = data as { version?: unknown; root?: unknown; order?: unknown };
    if (journal.version !== 1 || journal.root !== this.root || !Array.isArray(journal.order)) {
      throw new Error('Invalid recovery journal version, root or entries');
    }
    const seen = new Set<string>();
    for (const value of journal.order) {
      if (!value || typeof value !== 'object') throw new Error('Invalid recovery journal entry');
      const entry = value as SnapshotEntry;
      if (typeof entry.path !== 'string' || !this.validStoredPath(entry.path)
        || typeof entry.existedBefore !== 'boolean' || !Number.isSafeInteger(entry.step) || entry.step < 0
        || (entry.existedBefore ? typeof entry.snapFile !== 'string' || !/^[a-f0-9-]+\.snap$/.test(entry.snapFile) : entry.snapFile !== undefined)
        || seen.has(entry.path)) throw new Error('Invalid recovery journal entry');
      seen.add(entry.path);
    }
    // Canonical target authorization occurs at restore time, so one newly unsafe
    // target cannot hide other recoverable entries or prevent safe partial recovery.
    this.index = journal.order as SnapshotEntry[];
  }

  private validStoredPath(value: string): boolean {
    if (!value || value.includes('\0') || value.includes('\\')) return false;
    if (!this.paths) return path.isAbsolute(value) && path.normalize(value) === value;
    return !path.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^[a-z]:/i.test(value)
      && value !== '.' && value.split('/').every(component => component !== '..' && component !== '' && component !== '.');
  }

  /** The caller's transaction lane covers snapshot publication through apply. */
  async snapshotBeforeApply(step: number, absPath: string): Promise<void> {
    if (!Number.isSafeInteger(step) || step < 0) throw new Error('Invalid snapshot step');
    const target = this.paths ? await this.paths.validateAbsolute(absPath) : absPath;
    const storedPath = this.paths ? path.relative(this.paths.root, target).split(path.sep).join('/') : target;
    if (!this.validStoredPath(storedPath)) throw new Error('Invalid snapshot target');
    if (this.index.some(entry => entry.path === storedPath)) return;
    const content = await this.targetFs.read(target);
    const entry: SnapshotEntry = { path: storedPath, existedBefore: content !== undefined, step };
    if (content !== undefined) {
      entry.snapFile = `${randomUUID()}.snap`;
      await this.fs.write(path.join(this.dir, entry.snapFile), content);
    }
    const next = [...this.index, entry];
    await this.persist(next);
    this.index = next;
  }

  /** Explicit workspace-wide recovery; failed entries survive for a later retry. */
  revertAll(): Promise<RevertResult> {
    return this.runExclusive(async () => {
      const result: RevertResult = { restored: 0, deleted: 0, errors: [] };
      for (const entry of [...this.index].reverse()) {
        try {
          const target = this.paths ? await this.paths.resolve(entry.path) : entry.path;
          let deleted = false;
          if (entry.existedBefore) {
            const content = await this.fs.read(path.join(this.dir, entry.snapFile!));
            if (content === undefined) throw new Error('missing snapshot');
            // Storage reads can await; do not reuse authorization from before them.
            if (this.paths) await this.paths.validateAbsolute(target);
            await this.targetFs.write(target, content);
          } else if (await this.targetFs.exists(target)) {
            if (this.paths) await this.paths.validateAbsolute(target);
            await this.targetFs.remove(target);
            deleted = true;
          }
          const next = this.index.filter(item => item !== entry);
          await this.persist(next);
          this.index = next;
          if (entry.existedBefore) result.restored++;
          else if (deleted) result.deleted++;
          // Retirement must be durable before removing its recovery payload.
          if (entry.snapFile) await this.fs.remove(path.join(this.dir, entry.snapFile));
        } catch (error) {
          result.errors.push(`failed to revert ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    });
  }

  private persist(order: SnapshotEntry[]): Promise<void> {
    return this.fs.writeAtomic(this.indexPath, JSON.stringify({ version: 1, root: this.root, order }));
  }
}
