/**
 * Thumbnails of attachments this window staged, by staged path. The composer
 * draws one from the staged copy as it stages it, through the preview scheme
 * (main never decodes the image), and records it here, so the sent message can
 * show the picture. A message from before this window started shows its file chip.
 * Bounded: the oldest entries go first.
 */
const thumbnails = new Map<string, string>();
const THUMBNAILS_MAX = 200;

export function rememberAttachmentThumbnail(path: string, dataUrl: string | undefined): void {
  if (!dataUrl) return;
  thumbnails.delete(path);
  thumbnails.set(path, dataUrl);
  if (thumbnails.size > THUMBNAILS_MAX) thumbnails.delete(thumbnails.keys().next().value as string);
}

export function attachmentThumbnail(path: string): string | undefined {
  return thumbnails.get(path);
}
