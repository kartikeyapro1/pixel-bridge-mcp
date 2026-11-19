import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { PixelBridgeError } from '../core/errors.js';
import { sniffImage } from './png.js';

/**
 * RGBA raster utilities (pure JavaScript) and background removal for images
 * generated on a flat background. Used to produce transparent PNGs from providers
 * that cannot output transparency (e.g. Gemini).
 */

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major. */
  data: Uint8Array;
}

const MAX_MEGAPIXELS = 64;

export function decodeImage(buf: Uint8Array): Raster {
  const kind = sniffImage(buf);
  try {
    if (kind === 'png') {
      const png = PNG.sync.read(Buffer.from(buf));
      if (png.width * png.height > MAX_MEGAPIXELS * 1e6) throw new Error('image too large');
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    if (kind === 'jpeg') {
      const img = jpeg.decode(buf, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_MEGAPIXELS,
        maxMemoryUsageInMB: 1024,
      });
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch (e) {
    throw new PixelBridgeError(
      'INVALID_INPUT',
      `Could not decode image: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  throw new PixelBridgeError('INVALID_INPUT', 'Background removal supports PNG and JPEG images.');
}

export function encodePngRaster(r: Raster): Buffer {
  const png = new PNG({ width: r.width, height: r.height });
  Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).copy(png.data);
  return PNG.sync.write(png);
}

export interface RemoveBackgroundOptions {
  /** Colour distance (0-441) treated as fully background. Default 40, tolerant of JPEG noise. */
  tolerance?: number;
  /** Extra distance over which alpha ramps from 0 to 1, for soft edges. Default 40. */
  softness?: number;
  /** Also clear background-coloured regions not connected to the border (e.g. holes). Default false. */
  removeEnclosed?: boolean;
  /** Crop to the opaque content plus `padding` pixels. Default false. */
  trim?: boolean;
  padding?: number;
  /** Minimum share of border pixels that must match the background colour. Default 0.6. */
  minBorderUniformity?: number;
}

export interface RemoveBackgroundResult {
  raster: Raster;
  background: [number, number, number];
  borderUniformity: number;
  transparentShare: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * Remove a flat background. The background colour is the per-channel median of the
 * border pixels; pixels connected to the border and close to that colour become
 * transparent, with a soft ramp and colour decontamination at the edges.
 */
export function removeBackground(src: Raster, opts: RemoveBackgroundOptions = {}): RemoveBackgroundResult {
  const tolerance = opts.tolerance ?? 40;
  const softness = Math.max(1, opts.softness ?? 40);
  const { width: w, height: h, data } = src;
  if (w < 3 || h < 3) throw new PixelBridgeError('INVALID_INPUT', 'Image is too small.');

  // 1. Estimate background colour from the border.
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const bg: [number, number, number] = [0, 1, 2].map((c) => median(border.map((i) => data[i * 4 + c]!))) as [
    number,
    number,
    number,
  ];
  const dist = (i: number) => {
    const o = i * 4;
    const dr = data[o]! - bg[0];
    const dg = data[o + 1]! - bg[1];
    const db = data[o + 2]! - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const uniform = border.filter((i) => dist(i) <= tolerance).length / border.length;
  if (uniform < (opts.minBorderUniformity ?? 0.6)) {
    throw new PixelBridgeError(
      'VALIDATION_FAILED',
      `The background is not a flat colour (only ${Math.round(uniform * 100)}% of the border matches it), so it cannot be removed reliably.`,
      { hint: 'Generate the image on a plain, solid background, or raise the tolerance.' },
    );
  }

  // 2. Flood fill from the border through background-like pixels.
  const limit = tolerance + softness;
  const alpha = new Float32Array(w * h).fill(1);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const i of border) {
    if (!seen[i] && dist(i) <= limit) {
      seen[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const d = dist(i);
    alpha[i] = d <= tolerance ? 0 : (d - tolerance) / softness;
    if (d > tolerance) continue; // edge pixel: don't spread into the subject
    const x = i % w;
    const y = (i - x) / w;
    const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const n of next) {
      if (n >= 0 && !seen[n] && dist(n) <= limit) {
        seen[n] = 1;
        stack.push(n);
      }
    }
  }
  if (opts.removeEnclosed) {
    for (let i = 0; i < w * h; i++) {
      if (!seen[i]) {
        const d = dist(i);
        if (d <= limit) alpha[i] = d <= tolerance ? 0 : (d - tolerance) / softness;
      }
    }
  }

  // 3. Compose RGBA with colour decontamination on partially transparent pixels.
  const out = new Uint8Array(w * h * 4);
  let clear = 0;
  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, Math.max(0, alpha[i]!)) * (data[i * 4 + 3]! / 255);
    const o = i * 4;
    if (a <= 0) {
      clear++;
      continue; // fully transparent black
    }
    for (let c = 0; c < 3; c++) {
      const v = a < 1 ? (data[o + c]! - (1 - a) * bg[c]!) / a : data[o + c]!;
      out[o + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
    out[o + 3] = Math.round(a * 255);
  }
  let raster: Raster = { width: w, height: h, data: out };
  if (opts.trim) raster = trim(raster, opts.padding ?? 0);
  return { raster, background: bg, borderUniformity: uniform, transparentShare: clear / (w * h) };
}

/** Crop to the bounding box of non-transparent pixels, plus padding. */
export function trim(r: Raster, padding = 0): Raster {
  let minX = r.width;
  let minY = r.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[(y * r.width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0)
    throw new PixelBridgeError('VALIDATION_FAILED', 'Nothing left after removing the background.');
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(r.width - 1, maxX + padding);
  maxY = Math.min(r.height - 1, maxY + padding);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((minY + y) * r.width + minX) * 4;
    out.set(r.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}
