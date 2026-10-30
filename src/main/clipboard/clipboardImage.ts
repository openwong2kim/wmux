import { clipboard } from 'electron';

/**
 * The clipboard's image as PNG bytes, or null when it holds none. Electron
 * hands a clipboard image over as `image/png`, whatever the platform stored.
 */
export async function readClipboardPng(): Promise<Buffer | null> {
  const item = (await clipboard.read()).find((i) => i.types.includes('image/png'));
  if (!item) return null;
  const png = Buffer.from(await (await item.getType('image/png')).arrayBuffer());
  return png.length > 0 ? png : null;
}
