import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectPaths, slugify } from '../../src/core/paths.js';
import { cleanup, tempDir } from '../helpers.js';

describe('ProjectPaths', () => {
  const dirs: string[] = [];
  const mk = () => {
    const d = tempDir();
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.splice(0).forEach(cleanup));

  it('resolves relative paths inside the root', () => {
    const root = mk();
    const p = new ProjectPaths(root);
    expect(p.resolve('assets/a.png')).toBe(path.join(root, 'assets', 'a.png'));
    expect(p.relative(path.join(root, 'assets', 'a.png'))).toBe('assets/a.png');
  });

  it.each(['../outside.png', 'assets/../../outside.png', '..', '..\\x.png'])(
    'rejects traversal: %s',
    (input) => {
      const p = new ProjectPaths(mk());
      expect(() => p.resolve(input)).toThrow(/outside the project/);
    },
  );

  it('rejects absolute paths outside the root but accepts ones inside', () => {
    const root = mk();
    const other = mk();
    const p = new ProjectPaths(root);
    expect(() => p.resolve(path.join(other, 'x.png'))).toThrow(/outside the project/);
    expect(p.resolve(path.join(root, 'x.png'))).toBe(path.join(root, 'x.png'));
  });

  it('rejects NUL bytes and empty input', () => {
    const p = new ProjectPaths(mk());
    expect(() => p.resolve('a\0b')).toThrow(/NUL/);
    expect(() => p.resolve('')).toThrow(/Empty/);
  });

  it('rejects paths that escape through a symlink / junction', (ctx) => {
    const root = mk();
    const outside = mk();
    writeFileSync(path.join(outside, 'secret.txt'), 'x');
    const link = path.join(root, 'link');
    try {
      // 'junction' works on Windows without admin rights; ignored elsewhere.
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      ctx.skip(`cannot create symlinks here: ${(e as Error).message}`);
    }
    const p = new ProjectPaths(root);
    expect(() => p.resolve('link/secret.txt')).toThrow(/symlink/);
    expect(() => p.resolve('link/new-file.png')).toThrow(/symlink/);
    mkdirSync(path.join(root, 'real'));
    expect(p.resolve('real/new.png')).toBe(path.join(root, 'real', 'new.png'));
  });
});

describe('slugify', () => {
  it('produces safe lowercase slugs', () => {
    expect(slugify('Pip the Cat!')).toBe('pip-the-cat');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('Café Ünïcode')).toBe('cafe-unicode');
    expect(slugify('***')).toBe('asset');
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(48);
  });
});
