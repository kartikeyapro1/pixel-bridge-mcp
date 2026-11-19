import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PixelBridgeError } from './errors.js';

/**
 * Filesystem confinement. Every path an agent supplies is resolved against the
 * project root and must stay inside it after symlinks are resolved.
 */

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve the real path of the deepest existing ancestor, then re-append the rest. */
function realpathLenient(p: string): string {
  let current = p;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync.native(current) : current;
  return path.join(real, ...tail);
}

export class ProjectPaths {
  readonly root: string;
  private readonly realRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = existsSync(this.root) ? realpathSync.native(this.root) : this.root;
  }

  /**
   * Resolve a user/agent-supplied path. Relative paths are relative to the
   * project root; absolute paths are accepted only if they are inside it.
   */
  resolve(input: string, purpose = 'path'): string {
    if (typeof input !== 'string' || input.length === 0) {
      throw new PixelBridgeError('INVALID_INPUT', `Empty ${purpose}.`);
    }
    if (input.includes('\0')) {
      throw new PixelBridgeError('INVALID_INPUT', `Invalid ${purpose}: contains a NUL byte.`);
    }
    const candidate = path.resolve(this.root, input);
    if (!isInside(this.root, candidate)) {
      throw this.escapeError(input, purpose);
    }
    const real = realpathLenient(candidate);
    if (!isInside(this.realRoot, real)) {
      throw this.escapeError(
        input,
        purpose,
        'it resolves through a symlink to a location outside the project',
      );
    }
    return candidate;
  }

  /** Project-relative POSIX-style path for storage in metadata. */
  relative(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join('/');
  }

  private escapeError(
    input: string,
    purpose: string,
    why = 'it is outside the project root',
  ): PixelBridgeError {
    return new PixelBridgeError('PATH_OUTSIDE_PROJECT', `Refusing ${purpose} "${input}": ${why}.`, {
      hint: `PixelBridge only reads and writes inside ${this.root}. Copy the file into the project first.`,
    });
  }
}

/** Lowercase, filesystem-safe slug: [a-z0-9-], max 48 chars. */
export function slugify(input: string, fallback = 'asset'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}
