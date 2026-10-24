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
/** An EXIF APP1 payload: IFD0 holds Orientation and a pointer to GPS data that follows it. */
function exifBlock(order, orientation, gpsText) {
  const u16 = (n) => (order === "MM" ? [(n >> 8) & 255, n & 255] : [n & 255, (n >> 8) & 255]);
  const u32 = (n) => (order === "MM" ? be32(n) : le32(n));
  const orientationValue = order === "MM" ? [...u16(orientation), 0, 0] : [...u16(orientation), 0, 0];
  const ifd = [
    ...u16(2),
    ...u16(0x0112), ...u16(3), ...u32(1), ...orientationValue,
    ...u16(0x8825), ...u16(4), ...u32(1), ...u32(38),
    ...u32(0),
  ];
  return [...ascii("Exif\0\0"), ...ascii(order), ...u16(42), ...u32(8), ...ifd, ...ascii(gpsText)];
}

/** Reads Orientation back out of the first EXIF block in a JPEG, or null. */
function orientationOf(bytes) {
  const buf = Buffer.from(bytes);
  const at = buf.indexOf(Buffer.from("Exif\0\0", "latin1"));
  if (at < 0) return null;
  const tiff = at + 6;
  const big = buf.toString("latin1", tiff, tiff + 2) === "MM";
  const u16 = (i) => (big ? buf.readUInt16BE(i) : buf.readUInt16LE(i));
  const u32 = (i) => (big ? buf.readUInt32BE(i) : buf.readUInt32LE(i));
  const ifd = tiff + u32(tiff + 4);
  for (let k = 0; k < u16(ifd); k++) {
    const entry = ifd + 2 + k * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

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

  test("a JPEG ends at its end-of-image marker, so a picture or video appended after it is dropped", () => {
    const secondary = [0xff, 0xd8, ...jpegSegment(0xe1, ascii("Exif\0\0GPS-secondary")), ...jpegSegment(0xda, [1]), 7, 0xff, 0xd9];
    const jpeg = [0xff, 0xd8, ...jpegSegment(0xda, [1]), 5, 0xff, 0x00, 0xff, 0xd3, 6, 0xff, 0xd9];
    const withTrailer = [...jpeg, ...secondary, ...ascii("....ftypmp42 video")];

    const out = bytesOf(stripImageMetadata({ type: "image", mediaType: "image/jpeg", base64: b64(withTrailer) }));

    expect(out).toEqual(jpeg);
  });

  test("a JPEG with several scans keeps them all, and the tables between them", () => {
    const jpeg = [
      0xff, 0xd8,
      ...jpegSegment(0xda, [1]), 5, 6,
      ...jpegSegment(0xc4, [0, 1, 2]),
      ...jpegSegment(0xda, [2]), 7, 0xff, 0x00, 8,
      0xff, 0xd9,
    ];
    expect(bytesOf(stripImageMetadata({ type: "image", mediaType: "image/jpeg", base64: b64(jpeg) }))).toEqual(jpeg);
  });

  test("a JPEG keeps only which way up it goes from its EXIF block, so a portrait photo still shows upright", () => {
    for (const order of ["MM", "II"]) {
      const exif = exifBlock(order, 6, "GPS 23.8N 90.4E");
      const jpeg = [0xff, 0xd8, ...jpegSegment(0xe1, exif), ...jpegSegment(0xda, [1]), 5, 0xff, 0xd9];

      const out = bytesOf(stripImageMetadata({ type: "image", mediaType: "image/jpeg", base64: b64(jpeg) }));

      expect(has(out, "GPS")).toBe(false);
      expect(orientationOf(out)).toBe(6);
    }
  });

  test("a JPEG that is already upright loses its EXIF block entirely", () => {
    const jpeg = [0xff, 0xd8, ...jpegSegment(0xe1, exifBlock("MM", 1, "GPS")), ...jpegSegment(0xda, [1]), 5, 0xff, 0xd9];
    const out = bytesOf(stripImageMetadata({ type: "image", mediaType: "image/jpeg", base64: b64(jpeg) }));
    expect(has(out, "Exif")).toBe(false);
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
