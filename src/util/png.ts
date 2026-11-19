import { deflateSync } from 'node:zlib';

/** Minimal PNG utilities (no dependencies): header parsing and a tiny RGBA encoder for mocks/tests. */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(data: Uint8Array): boolean {
  return data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(SIGNATURE);
}

export function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (!isPng(data) || data.length < 24) return null;
  const b = Buffer.from(data);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Sniff common image formats from magic bytes. */
export function sniffImage(data: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | null {
  if (isPng(data)) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (
    Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP'
  )
    return 'webp';
  if (Buffer.from(data.subarray(0, 3)).toString('ascii') === 'GIF') return 'gif';
  return null;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * Encode an RGBA image. `pixel(x, y)` returns [r, g, b, a].
 */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
