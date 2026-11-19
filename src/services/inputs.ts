import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PixelBridgeError } from '../core/errors.js';
import { sha256 } from '../core/hashing.js';
import type { ProjectPaths } from '../core/paths.js';
import type { AssetRecord, AssetRegistry } from '../core/registry.js';
import type { InputImage } from '../providers/types.js';
import { sniffImage } from '../util/png.js';

export interface ResolvedImage extends InputImage {
  sha256: string;
  assetId: string | null;
  absPath: string;
}

const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/**
 * Resolve an agent-supplied image reference: either an asset id (`ast_…`) or a
 * path inside the project. Only PNG/JPEG/WebP are accepted, verified by magic bytes.
 */
export function resolveImage(ref: string, registry: AssetRegistry, paths: ProjectPaths): ResolvedImage {
  let absPath: string;
  let asset: AssetRecord | null = null;
  if (/^ast_[a-f0-9]{16}$/.test(ref)) {
    asset = registry.get(ref);
    absPath = registry.absolutePath(asset);
  } else {
    absPath = paths.resolve(ref, 'image path');
  }
  if (!existsSync(absPath)) throw new PixelBridgeError('NOT_FOUND', `Image not found: ${ref}`);
  const st = statSync(absPath);
  if (!st.isFile()) throw new PixelBridgeError('INVALID_INPUT', `Not a file: ${ref}`);
  if (st.size > MAX_INPUT_BYTES)
    throw new PixelBridgeError('INVALID_INPUT', `Image is larger than 50MB: ${ref}`);
  const data = readFileSync(absPath);
  const kind = sniffImage(data);
  if (kind !== 'png' && kind !== 'jpeg' && kind !== 'webp') {
    throw new PixelBridgeError('INVALID_INPUT', `${ref} is not a PNG, JPEG or WebP image.`);
  }
  return {
    data,
    filename: path.basename(absPath),
    mime: kind === 'jpeg' ? 'image/jpeg' : `image/${kind}`,
    sha256: sha256(data),
    assetId: asset?.id ?? null,
    absPath,
  };
}
