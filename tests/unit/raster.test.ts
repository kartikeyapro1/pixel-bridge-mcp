import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { afterEach, describe, expect, it } from 'vitest';
import { MockImageProvider } from '../../src/providers/mock.js';
import type { ImageCapabilities } from '../../src/providers/types.js';
import { CUTOUT_PROMPT_SUFFIX } from '../../src/services/image-service.js';
import { encodePng, isPng, pngSize } from '../../src/util/png.js';
import { decodeImage, removeBackground, trim, type Raster } from '../../src/util/raster.js';
import { makeBridge, type TestBridge } from '../helpers.js';

/** 64x64 magenta background with a blue square and a magenta "hole" inside it. */
function iconPng(): Buffer {
  return encodePng(64, 64, (x, y) => {
    const inSquare = x >= 16 && x < 48 && y >= 16 && y < 48;
    const inHole = x >= 28 && x < 36 && y >= 28 && y < 36;
    if (inSquare && !inHole) return [30, 60, 200, 255];
    return [255, 0, 255, 255];
  });
}

const alphaAt = (r: Raster, x: number, y: number) => r.data[(y * r.width + x) * 4 + 3];

describe('removeBackground', () => {
  it('clears the border-connected background and keeps the subject opaque', () => {
    const res = removeBackground(decodeImage(iconPng()));
    expect(res.background).toEqual([255, 0, 255]);
    expect(alphaAt(res.raster, 0, 0)).toBe(0);
    expect(alphaAt(res.raster, 20, 20)).toBe(255);
    // The enclosed hole is not connected to the border, so it stays by default...
    expect(alphaAt(res.raster, 31, 31)).toBe(255);
    // ...and is cleared on request.
    expect(alphaAt(removeBackground(decodeImage(iconPng()), { removeEnclosed: true }).raster, 31, 31)).toBe(
      0,
    );
  });

  it('trims to the subject with padding', () => {
    const t = removeBackground(decodeImage(iconPng()), { trim: true, padding: 2 }).raster;
    expect([t.width, t.height]).toEqual([36, 36]);
    expect(() => trim({ width: 2, height: 2, data: new Uint8Array(16) })).toThrow(/Nothing left/);
  });

  it('handles JPEG noise and decodes JPEG input', () => {
    const src = decodeImage(iconPng());
    const jpg = jpeg.encode({ width: src.width, height: src.height, data: Buffer.from(src.data) }, 70).data;
    const res = removeBackground(decodeImage(jpg));
    expect(alphaAt(res.raster, 2, 2)).toBe(0);
    expect(alphaAt(res.raster, 22, 22)).toBe(255);
  });

  it('removes the background tint from soft edge pixels', () => {
    // A half-blended pixel between blue subject and magenta background.
    const img = encodePng(9, 9, (x, y) =>
      x === 4 && y === 4 ? [30, 60, 200, 255] : x === 5 && y === 4 ? [143, 30, 228, 255] : [255, 0, 255, 255],
    );
    const res = removeBackground(decodeImage(img), { tolerance: 20, softness: 200 }).raster;
    const o = (4 * 9 + 5) * 4;
    expect(res.data[o + 3]).toBeGreaterThan(0);
    expect(res.data[o + 3]).toBeLessThan(255);
    expect(res.data[o]).toBeLessThan(143); // red (from magenta) reduced
  });

  it('refuses non-uniform backgrounds instead of guessing', () => {
    const noisy = encodePng(32, 32, (x, y) => [(x * 37 + y * 91) % 256, (x * 13) % 256, (y * 7) % 256, 255]);
    expect(() => removeBackground(decodeImage(noisy))).toThrow(/not a flat colour/);
  });

  it('rejects unsupported formats', () => {
    expect(() => decodeImage(Buffer.from('GIF89a......'))).toThrow(/PNG and JPEG/);
  });
});

/** Mock that, like Gemini, cannot output transparency. */
class OpaqueOnlyMock extends MockImageProvider {
  override capabilities(): ImageCapabilities {
    return { ...super.capabilities(), transparentBackground: 'unsupported' };
  }
}

describe('ImageService output options', () => {
  let t: TestBridge;
  afterEach(() => t?.done());

  it('writes into outputDir with the given file name, recorded in the registry', async () => {
    t = makeBridge();
    const r = await t.pb.images.generate({
      prompt: 'dumbbell icon',
      collection: 'icons',
      outputDir: 'src/assets/icons',
      fileName: 'DumbbellIcon.png',
    });
    expect(r.assets[0]!.path).toBe('src/assets/icons/DumbbellIcon.png');
    const again = await t.pb.images.generate({
      prompt: 'dumbbell icon',
      collection: 'icons',
      outputDir: 'src/assets/icons',
      fileName: 'DumbbellIcon',
      bypassCache: true,
    });
    expect(again.assets[0]!.path).toBe('src/assets/icons/DumbbellIcon-2.png'); // never overwrites
    const manifest = JSON.parse(
      readFileSync(path.join(t.dir, 'assets/characters/icons/manifest.json'), 'utf8'),
    ) as {
      assets: { projectPath: string }[];
    };
    expect(manifest.assets.map((a) => a.projectPath)).toContain('src/assets/icons/DumbbellIcon.png');
  });

  it('rejects output folders outside the project before spending', async () => {
    t = makeBridge();
    await expect(
      t.pb.images.generate({ prompt: 'x', collection: 'c', outputDir: '../outside' }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    expect(t.images.calls).toHaveLength(0);
    expect(t.pb.ctx.budget.summary().committedUsd).toBe(0);
  });

  it('sanitises file names into a single safe path segment', async () => {
    t = makeBridge();
    const r = await t.pb.images.generate({
      prompt: 'x',
      collection: 'c',
      outputDir: 'out',
      fileName: '../../evil name',
    });
    expect(r.assets[0]!.path).toBe('out/evil-name.png');
  });

  it('produces a transparent PNG locally when the provider cannot', async () => {
    const provider = new OpaqueOnlyMock(0.01);
    t = makeBridge({ imageProviders: [provider] });
    const r = await t.pb.images.generate({
      prompt: 'a red apple icon',
      collection: 'icons',
      background: 'transparent',
      outputDir: 'public/img',
      fileName: 'apple',
      trim: true,
    });
    expect(provider.calls[0]!.params.prompt).toContain(CUTOUT_PROMPT_SUFFIX.trim().slice(0, 30));
    expect(provider.calls[0]!.params.background).toBe('auto');
    const out = r.assets[0]!;
    expect(out.path).toBe('public/img/apple.png');
    const data = readFileSync(path.join(t.dir, out.path));
    expect(isPng(data)).toBe(true);
    const decoded = decodeImage(data);
    expect(alphaAt(decoded, 0, 0)).toBe(0); // corner is transparent after trim+padding
    expect(pngSize(data)!.width).toBeLessThan(256); // trimmed
    expect(out.parentId).toBeTruthy();
    const source = t.pb.ctx.registry.get(out.parentId!);
    expect(source.role).toBe('image-source');
    expect(existsSync(path.join(t.dir, source.path))).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/cut out locally/);
  });

  it('remove_background works on any project image for free', async () => {
    t = makeBridge();
    writeFileSync(path.join(t.dir, 'logo.png'), iconPng());
    const res = await t.pb.images.removeBackground({ image: 'logo.png', outputDir: 'ui', trim: true });
    expect(res.asset.path).toBe('ui/logo-cutout.png');
    expect(res.transparentShare).toBeGreaterThan(0);
    expect(res.asset.provider).toBe('local');
    expect(t.pb.ctx.budget.summary().committedUsd).toBe(0);
  });
});
