/** Formats Claude Code attaches from a pasted path. */
export const CHAT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_ATTACHMENT_LIMIT = 5;

/** A path the daemon may paste into the agent: absolute, one line, an image name. */
export function validChatImagePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length >= 4096 || !/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  const dot = value.lastIndexOf('.');
  return dot > Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) && CHAT_IMAGE_EXTENSIONS.includes(value.slice(dot).toLowerCase());
}

export function validChatAttachments(value: unknown): value is string[] | undefined {
  return value === undefined || Array.isArray(value) && value.length <= CHAT_ATTACHMENT_LIMIT && value.every(validChatImagePath);
}
