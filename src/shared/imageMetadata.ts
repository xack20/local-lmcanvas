import type { ImageBlock } from "./types";

// Sections that can carry who, where and when a picture was taken. Colour profiles stay.
const JPEG_DROP = new Set([0xe1 /* EXIF, XMP */, 0xed /* IPTC */, 0xfe /* comment */]);
const JPEG_SOS = 0xda;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const WEBP_DROP = new Set(["EXIF", "XMP "]);
const VP8X_METADATA_FLAGS = 0x08 | 0x04;

/** The image with its metadata sections removed and the picture bytes untouched, or null
 *  when the bytes don't parse as the stated type. GIFs carry no location and pass through. */
export function stripImageMetadata(block: ImageBlock): ImageBlock | null {
  if (block.mediaType === "image/gif") return block;
  const bytes = decode(block.base64);
  if (!bytes) return null;
  const stripped =
    block.mediaType === "image/jpeg" ? stripJpeg(bytes)
    : block.mediaType === "image/png" ? stripPng(bytes)
    : stripWebp(bytes);
  return stripped ? { ...block, base64: encode(stripped) } : null;
}

function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const keep = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (end < i + 4 || end > b.length) return null;
    // Everything from the start of scan on is the picture itself.
    if (marker === JPEG_SOS) return concat([...keep, b.subarray(i)]);
    if (!JPEG_DROP.has(marker)) keep.push(b.subarray(i, end));
    i = end;
  }
  return null;
}

function stripPng(b: Uint8Array): Uint8Array | null {
  if (!PNG_SIGNATURE.every((v, k) => b[k] === v)) return null;
  const keep = [b.subarray(0, 8)];
  for (let i = 8; i < b.length; ) {
    if (i + 12 > b.length) return null;
    const end = i + 12 + readU32BE(b, i);
    if (end > b.length) return null;
    if (!PNG_DROP.has(ascii(b, i + 4, 4))) keep.push(b.subarray(i, end));
    i = end;
  }
  return concat(keep);
}

function stripWebp(b: Uint8Array): Uint8Array | null {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const keep: Uint8Array[] = [];
  for (let i = 12; i < b.length; ) {
    if (i + 8 > b.length) return null;
    const size = readU32LE(b, i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > b.length) return null;
    const fourcc = ascii(b, i, 4);
    if (fourcc === "VP8X" && size > 0) {
      const chunk = b.slice(i, end);
      chunk[8] &= ~VP8X_METADATA_FLAGS;
      keep.push(chunk);
    } else if (!WEBP_DROP.has(fourcc)) {
      keep.push(b.subarray(i, end));
    }
    i = end;
  }
  const body = concat(keep);
  const out = concat([b.subarray(0, 12), body]);
  writeU32LE(out, 4, 4 + body.length);
  return out;
}

function readU32BE(b: Uint8Array, i: number): number {
  return b[i] * 0x1000000 + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
}

function readU32LE(b: Uint8Array, i: number): number {
  return b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + b[i + 3] * 0x1000000;
}

function writeU32LE(b: Uint8Array, i: number, n: number): void {
  b[i] = n & 255;
  b[i + 1] = (n >>> 8) & 255;
  b[i + 2] = (n >>> 16) & 255;
  b[i + 3] = (n >>> 24) & 255;
}

function ascii(b: Uint8Array, i: number, n: number): string {
  return String.fromCharCode(...b.subarray(i, i + n));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// `src/shared` is also type-checked for the renderer, so no Buffer here.
function decode(base64: string): Uint8Array | null {
  try {
    const s = atob(base64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function encode(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}
