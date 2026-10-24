import type { ImageBlock } from "./types";

// Sections that can carry who, where and when a picture was taken. Colour profiles stay.
// EXIF (APP1) is rebuilt with only its Orientation; XMP shares the marker and goes.
const JPEG_EXIF = 0xe1;
const JPEG_DROP = new Set([0xed /* IPTC */, 0xfe /* comment */]);
const JPEG_SOS = 0xda;
const JPEG_EOI = 0xd9;
const EXIF_ORIENTATION = 0x0112;
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
  let scanFrom = -1;
  while (i < b.length) {
    if (scanFrom >= 0) {
      // Picture data: FF00 is an escaped byte, FFD0-FFD7 restart markers, FFFF padding.
      const next = b[i + 1];
      if (b[i] !== 0xff || next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
        i++;
        continue;
      }
      keep.push(b.subarray(scanFrom, i));
      scanFrom = -1;
    }
    if (b[i] !== 0xff || i + 1 >= b.length) return null;
    const marker = b[i + 1];
    // A phone can append a second picture or a video after the end of the image.
    if (marker === JPEG_EOI) return concat([...keep, b.subarray(i, i + 2)]);
    if (i + 4 > b.length) return null;
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (end < i + 4 || end > b.length) return null;
    const segment = b.subarray(i, end);
    if (marker === JPEG_EXIF) {
      const orientation = orientationSegment(segment);
      if (orientation) keep.push(orientation);
    } else if (!JPEG_DROP.has(marker)) {
      keep.push(segment);
    }
    if (marker === JPEG_SOS) scanFrom = end;
    i = end;
  }
  // No end-of-image marker: keep the picture data the file does have.
  return scanFrom >= 0 ? concat([...keep, b.subarray(scanFrom)]) : null;
}

/** A replacement EXIF segment holding only Orientation, so a turned photo still shows upright;
 *  null when the segment isn't EXIF or the picture is already upright. */
function orientationSegment(segment: Uint8Array): Uint8Array | null {
  const tiff = segment.subarray(4 + 6);
  if (ascii(segment, 4, 6) !== "Exif\0\0" || tiff.length < 8) return null;
  const big = ascii(tiff, 0, 2) === "MM";
  if (!big && ascii(tiff, 0, 2) !== "II") return null;
  const u16 = (k: number) => (big ? (tiff[k] << 8) | tiff[k + 1] : tiff[k] | (tiff[k + 1] << 8));
  const ifd = big ? readU32BE(tiff, 4) : readU32LE(tiff, 4);
  if (ifd + 2 > tiff.length) return null;
  for (let k = 0; k < u16(ifd); k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) !== EXIF_ORIENTATION) continue;
    const value = u16(entry + 8);
    if (value < 2 || value > 8) return null;
    // Big-endian TIFF, one IFD0 entry (SHORT, count 1), no next IFD.
    const payload = [
      ...[0x45, 0x78, 0x69, 0x66, 0, 0],
      ...[0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8],
      ...[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0],
      ...[0, 0, 0, 0],
    ];
    return Uint8Array.from([0xff, JPEG_EXIF, 0, payload.length + 2, ...payload]);
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
