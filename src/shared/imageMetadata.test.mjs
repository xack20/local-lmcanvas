// .mjs keeps the bun:test import out of `bun run typecheck`.
import { describe, expect, test } from "bun:test";
import { stripImageMetadata } from "./imageMetadata.ts";

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const bytesOf = (block) => [...Buffer.from(block.base64, "base64")];
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, "latin1"));
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

const jpegSegment = (marker, payload) => [0xff, marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
const pngChunk = (type, data) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const riffChunk = (fourcc, data) => [...ascii(fourcc), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])];
const webp = (chunks) => {
  const body = [...ascii("WEBP"), ...chunks.flat()];
  return [...ascii("RIFF"), ...le32(body.length), ...body];
};

describe("stripImageMetadata", () => {
  test("a JPEG loses its EXIF, XMP, IPTC and comment segments but keeps JFIF and the image data", () => {
    const scan = [0x12, 0x34, 0xff, 0x00, 0x56];
    const jpeg = [
      0xff, 0xd8,
      ...jpegSegment(0xe0, ascii("JFIF\0")),
      ...jpegSegment(0xe1, ascii("Exif\0\0GPS 23.8N 90.4E")),
      ...jpegSegment(0xe1, ascii("http://ns.adobe.com/xap/1.0/")),
      ...jpegSegment(0xed, ascii("Photoshop 3.0\0")),
      ...jpegSegment(0xfe, ascii("hi there")),
      ...jpegSegment(0xda, [1, 2, 3]),
      ...scan,
      0xff, 0xd9,
    ];

    const out = bytesOf(stripImageMetadata({ type: "image", mediaType: "image/jpeg", base64: b64(jpeg) }));

    expect(has(out, "Exif")).toBe(false);
    expect(has(out, "adobe")).toBe(false);
    expect(has(out, "Photoshop")).toBe(false);
    expect(has(out, "hi there")).toBe(false);
    expect(out.slice(0, 4)).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    const tail = [...jpegSegment(0xda, [1, 2, 3]), ...scan, 0xff, 0xd9];
    expect(out.slice(-tail.length)).toEqual(tail);
  });

  test("a PNG loses eXIf, tEXt, zTXt, iTXt and tIME chunks and keeps IHDR, IDAT and IEND", () => {
    const png = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      ...pngChunk("tEXt", ascii("Author\0me")),
      ...pngChunk("eXIf", ascii("GPS")),
      ...pngChunk("zTXt", ascii("Comment\0\0x")),
      ...pngChunk("iTXt", ascii("XML:com.adobe.xmp\0")),
      ...pngChunk("tIME", [7, 234, 10, 24, 1, 2, 3]),
      ...pngChunk("IDAT", [9, 9, 9]),
      ...pngChunk("IEND", []),
    ];

    const out = bytesOf(stripImageMetadata({ type: "image", mediaType: "image/png", base64: b64(png) }));

    for (const gone of ["tEXt", "eXIf", "zTXt", "iTXt", "tIME"]) expect(has(out, gone)).toBe(false);
    for (const kept of ["IHDR", "IDAT", "IEND"]) expect(has(out, kept)).toBe(true);
  });

  test("a WebP loses its EXIF and XMP chunks, its RIFF size shrinks to match, and the VP8X EXIF/XMP flags are cleared", () => {
    const vp8x = [0x08 | 0x04 | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const file = webp([
      riffChunk("VP8X", vp8x),
      riffChunk("VP8 ", [1, 2, 3]),
      riffChunk("EXIF", ascii("GPS 23.8N")),
      riffChunk("XMP ", ascii("<x:xmpmeta/>")),
    ]);

    const out = bytesOf(stripImageMetadata({ type: "image", mediaType: "image/webp", base64: b64(file) }));

    expect(has(out, "EXIF")).toBe(false);
    expect(has(out, "XMP ")).toBe(false);
    expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20] & 0x0c).toBe(0);
    expect(out[20] & 0x10).toBe(0x10);
  });

  test("a GIF is returned unchanged", () => {
    const gif = { type: "image", mediaType: "image/gif", base64: b64(ascii("GIF89a....")) };
    expect(stripImageMetadata(gif)).toEqual(gif);
  });

  test("bytes that don't parse as the stated type give null", () => {
    expect(stripImageMetadata({ type: "image", mediaType: "image/jpeg", base64: b64(ascii("not an image")) })).toBeNull();
    const truncatedPng = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(100), ...ascii("IHDR"), 1, 2];
    expect(stripImageMetadata({ type: "image", mediaType: "image/png", base64: b64(truncatedPng) })).toBeNull();
    expect(stripImageMetadata({ type: "image", mediaType: "image/webp", base64: b64(ascii("RIFF\0\0\0\0WAVE")) })).toBeNull();
  });
});
