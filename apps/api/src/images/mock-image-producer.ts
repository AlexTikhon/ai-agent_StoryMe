import { deflateSync } from 'node:zlib';

/** Keeps generated PNGs tiny — this is a placeholder color swatch, not artwork. */
const IMAGE_SIZE = 8;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Simple 32-bit string hash (FNV-1a) — deterministic, no crypto needed here. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministically produces a tiny valid PNG (solid color swatch) for a
 * given seed string. Same seed -> byte-identical PNG; different seeds ->
 * different colors, via an FNV-1a hash of the seed mapped to RGB.
 *
 * This is a local stand-in for a future real image-generation provider (see
 * docs/pdf-rendering.md) — it produces *some* real, embeddable image bytes
 * end-to-end without any AI/network call. Built with only Node's built-in
 * `zlib` (for PNG's required DEFLATE-compressed IDAT chunk) and hand-rolled
 * PNG chunk framing — no new dependencies.
 */
export function generateMockImagePng(seed: string): Buffer {
  const hash = fnv1a(seed);
  const r = (hash >>> 16) & 0xff;
  const g = (hash >>> 8) & 0xff;
  const b = hash & 0xff;

  const rowBytes = 1 + IMAGE_SIZE * 3; // leading filter-type byte + RGB per pixel
  const raw = Buffer.alloc(rowBytes * IMAGE_SIZE);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < IMAGE_SIZE; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(IMAGE_SIZE, 0);
  ihdr.writeUInt32BE(IMAGE_SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const idat = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
