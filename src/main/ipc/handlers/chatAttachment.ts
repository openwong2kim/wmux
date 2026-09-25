import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeImage } from 'electron';
import type { ChatAttachmentPreview } from '../../../shared/transcript/turnEvents';
import { CHAT_IMAGE_MAX_BYTES, validChatImagePath } from '../../../shared/transcript/chatAttachments';

const THUMBNAIL_EDGE = 160;

/**
 * Validate a dropped or pasted file for the chat composer and draw its chip
 * thumbnail. A format nativeImage cannot decode still attaches (the agent reads
 * the file itself); its chip simply has no picture.
 */
export async function previewChatAttachment(file: unknown): Promise<ChatAttachmentPreview> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, reason: 'missing' };
  if (!validChatImagePath(file)) return { ok: false, reason: 'type' };
  let bytes: number;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { ok: false, reason: 'missing' };
    bytes = stat.size;
  } catch { return { ok: false, reason: 'missing' }; }
  if (bytes > CHAT_IMAGE_MAX_BYTES) return { ok: false, reason: 'size' };
  const image = nativeImage.createFromPath(file);
  let thumbnail = '';
  if (!image.isEmpty()) {
    const { width, height } = image.getSize();
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height, 1));
    thumbnail = (scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' }) : image).toDataURL();
  }
  return { ok: true, path: file, name: path.basename(file), bytes, thumbnail };
}
