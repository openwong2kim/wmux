import { clipboard } from 'electron';

/**
 * The clipboard's image as PNG bytes, or null when it holds none. Electron
 * hands a clipboard image over as `image/png`, whatever the platform stored.
 */
export async function readClipboardPng(): Promise<Buffer | null> {
  // A single-format check first: a paste with no image lists no types.
  if (!(await clipboard.has('image/png'))) return null;
  const item = (await clipboard.read()).find((i) => i.types.includes('image/png'));
  if (!item) return null;
  const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
  return png.length > 0 ? png : null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's width and height, read from its IHDR header without decoding it; null for bytes that are no PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
