import { readFile, stat } from "node:fs/promises";
import { nanoid } from "nanoid";
import {
  SHARE_MAX_BYTES,
  fromShareFile,
  toShareFile,
  type ShareRefusal,
} from "@shared/canvasShare";
import { readCanvas, writeCanvas } from "./canvases";
import { atomicWriteFile } from "./paths";

/** Writes the canvas's questions and answers to `filePath`. False when there is no such canvas. */
export async function exportCanvasToFile(id: string, filePath: string, now = Date.now()): Promise<boolean> {
  const canvas = await readCanvas(id);
  if (!canvas) return false;
  await atomicWriteFile(filePath, JSON.stringify(toShareFile(canvas, now), null, 2));
  return true;
}

/** Adds the canvas in a file someone else made as a new canvas, or says why it can't. */
export async function importCanvasFromFile(
  filePath: string,
  maxBytes = SHARE_MAX_BYTES,
): Promise<{ status: "imported"; canvasId: string } | { status: "refused"; reason: ShareRefusal }> {
  const info = await stat(filePath);
  // A pipe or a device reports a small size but may never finish reading.
  if (!info.isFile()) return { status: "refused", reason: "not-lmcanvas" };
  if (info.size > maxBytes) return { status: "refused", reason: "too-large" };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return { status: "refused", reason: "not-lmcanvas" };
  }
  const result = fromShareFile(raw, () => nanoid(10));
  if (!result.ok) return { status: "refused", reason: result.reason };
  const now = Date.now();
  const canvasId = nanoid(10);
  await writeCanvas({ id: canvasId, ...result.canvas, createdAt: now, updatedAt: now });
  return { status: "imported", canvasId };
}
