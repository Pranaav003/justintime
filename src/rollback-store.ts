/**
 * Persisted rollback store (design Section 6). Snapshots the pristine
 * pre-walkthrough content of every file JustInTime is about to touch, so
 * "Revert All" survives reload/crash — the flaw the pressure-test found in the
 * original in-memory-only design.
 *
 * Filesystem access is injected via SnapshotFs so the snapshot + reverse-order
 * restore logic is unit-testable with an in-memory fs; the extension supplies a
 * real fs backed by context.globalStorageUri.
 */

/** Minimal async filesystem over absolute paths. read() returns undefined for a missing file. */
export interface SnapshotFs {
  read(path: string): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

interface SnapshotEntry {
  /** Absolute path of the touched file. */
  path: string;
  /** Whether the file existed before the walkthrough touched it. */
  existedBefore: boolean;
  /** Snapshot file holding the pristine content (present only when existedBefore). */
  snapFile?: string;
  /** Step number that first touched this path (for reporting). */
  step: number;
}

export interface RevertResult {
  restored: number;
  deleted: number;
  errors: string[];
}

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

export class RollbackStore {
  private index: SnapshotEntry[] = [];
  private seq = 0;
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(
    private readonly fs: SnapshotFs,
    baseDir: string,
    private readonly sessionId: string,
  ) {
    this.dir = join(baseDir, 'snapshots', this.sessionId);
    this.indexPath = join(this.dir, 'index.json');
  }

  hasSnapshots(): boolean {
    return this.index.length > 0;
  }

  /** Rebuild in-memory index from disk (call after a reload before revertAll). */
  async load(): Promise<void> {
    const raw = await this.fs.read(this.indexPath);
    if (!raw) {
      return;
    }
    let parsed: { order?: SnapshotEntry[] };
    try {
      parsed = JSON.parse(raw) as { order?: SnapshotEntry[] };
    } catch {
      // Corrupt index — start fresh rather than crashing Revert All.
      this.index = [];
      this.seq = 0;
      return;
    }
    this.index = parsed.order ?? [];
    this.seq = this.index.reduce((max, e) => {
      const n = e.snapFile ? Number(e.snapFile.split('/').pop()!.replace('.snap', '')) : -1;
      return Number.isFinite(n) && n > max ? n : max;
    }, -1) + 1;
  }

  /**
   * Capture the pristine state of `absPath` before an edit is applied to it.
   * Idempotent per path — only the FIRST touch is recorded, which is the true
   * pre-walkthrough state.
   */
  async snapshotBeforeApply(step: number, absPath: string): Promise<void> {
    if (this.index.some((e) => e.path === absPath)) {
      return;
    }
    const content = await this.fs.read(absPath);
    const existedBefore = content !== undefined;
    let snapFile: string | undefined;
    if (existedBefore) {
      snapFile = join(this.dir, `${this.seq++}.snap`);
      await this.fs.write(snapFile, content!);
    }
    this.index.push({ path: absPath, existedBefore, snapFile, step });
    await this.persist();
  }

  /**
   * Restore every touched file to its pristine state, processing in reverse
   * touch order. Files that existed are rewritten; files created during the
   * walkthrough are deleted.
   */
  async revertAll(): Promise<RevertResult> {
    const result: RevertResult = { restored: 0, deleted: 0, errors: [] };
    for (let i = this.index.length - 1; i >= 0; i--) {
      const entry = this.index[i]!;
      try {
        if (entry.existedBefore) {
          const content = entry.snapFile ? await this.fs.read(entry.snapFile) : undefined;
          if (content === undefined) {
            result.errors.push(`missing snapshot for ${entry.path}`);
            continue;
          }
          await this.fs.write(entry.path, content);
          result.restored++;
        } else {
          if (await this.fs.exists(entry.path)) {
            await this.fs.remove(entry.path);
            result.deleted++;
          }
        }
      } catch (err) {
        result.errors.push(`failed to revert ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  private async persist(): Promise<void> {
    await this.fs.write(this.indexPath, JSON.stringify({ order: this.index }));
  }
}
