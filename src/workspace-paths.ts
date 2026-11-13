import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/** Missing is distinct from permission, unavailable and malformed-path errors. */
export function isFileNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'FileNotFound';
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Fresh containment checks at each I/O boundary; this is not an OS race sandbox. */
export class WorkspacePaths {
  readonly root: string;
  private identity?: Promise<{ canonical: string; dev: number; ino: number }>;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async canonicalRoot(): Promise<string> {
    // Capture once, but re-read on EVERY use, including canonicalRoot callers.
    this.identity ??= this.readRoot();
    const original = await this.identity;
    const current = await this.readRoot();
    if (current.canonical !== original.canonical || current.dev !== original.dev || current.ino !== original.ino) {
      throw new WorkspacePathError('Workspace root identity changed');
    }
    return original.canonical;
  }

  private async readRoot(): Promise<{ canonical: string; dev: number; ino: number }> {
    try {
      const canonical = await fs.realpath(this.root);
      const stat = await fs.stat(this.root);
      if (!stat.isDirectory()) throw new WorkspacePathError('Workspace root is not a directory');
      return { canonical, dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if (isFileNotFound(error)) throw new WorkspacePathError('Workspace root is missing or dangling');
      throw error;
    }
  }

  async resolve(relativePath: string): Promise<string> {
    if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)
      || path.win32.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath) || relativePath.includes('\\')) {
      throw new WorkspacePathError(`Unsafe workspace path: ${JSON.stringify(relativePath)}`);
    }
    return this.validateAbsolute(path.resolve(this.root, relativePath));
  }

  async validateAbsolute(absolutePath: string): Promise<string> {
    if (!path.isAbsolute(absolutePath) || absolutePath.includes('\0')) {
      throw new WorkspacePathError('Expected an absolute workspace file path');
    }
    const target = path.resolve(absolutePath);
    if (target === this.root || !contains(this.root, target)) {
      throw new WorkspacePathError(`Path is outside workspace file scope: ${target}`);
    }
    const canonical = await this.canonicalRoot();
    let ancestor = this.root;
    for (const component of path.relative(this.root, target).split(path.sep)) {
      ancestor = path.join(ancestor, component);
      let stat;
      try {
        stat = await fs.lstat(ancestor);
      } catch (error) {
        if (!isFileNotFound(error)) throw error;
        // The first absent component makes the remaining suffix absent too.
        break;
      }
      let real: string;
      try {
        real = await fs.realpath(ancestor);
      } catch (error) {
        // lstat succeeded: ENOENT here identifies a dangling link, not an absent parent.
        if (isFileNotFound(error)) throw new WorkspacePathError(`Dangling workspace path: ${ancestor}`);
        throw error;
      }
      if ((ancestor === target && real === canonical) || !contains(canonical, real)) throw new WorkspacePathError(`Path resolves outside workspace: ${ancestor}`);
      if (ancestor !== target && !stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new WorkspacePathError(`Workspace path parent is not a directory: ${ancestor}`);
      }
    }
    // An intervening await must not authorize replacement of the root itself.
    await this.canonicalRoot();
    return target;
  }
}
