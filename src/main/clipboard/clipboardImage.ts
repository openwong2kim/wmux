import { clipboard, nativeImage } from 'electron';

const isImage = (type: string): boolean => type.startsWith('image/');

/**
 * Whether the clipboard holds an image in any format, as availableFormats()
 * used to say: a source that stored only another format (a bitmap, a TIFF)
 * counts too. A busy clipboard (the Win32 one can be locked) is no image.
 */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    return (await clipboard.read()).some((item) => item.types.some(isImage));
  } catch {
    return false;
  }
}

/**
 * The clipboard's image as PNG bytes, or null when it holds none. `image/png`
 * is taken as it is; another image format is converted, so a source that
 * stored only that format still pastes.
 */
export async function readClipboardPng(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.includes('image/png') ? 'image/png' : item.types.find(isImage);
    if (!type) continue;
    // eslint-disable-next-line no-await-in-loop -- one item at a time, the first image wins
    // An image type always comes back as a Blob (only the bookmark format does not).
    const bytes = Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer());
    if (bytes.length === 0) continue;
    if (type === 'image/png') return bytes;
    const image = nativeImage.createFromBuffer(bytes);
    if (!image.isEmpty()) return image.toPNG();
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's width and height, read from its IHDR header without decoding it; null for bytes that are no PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
