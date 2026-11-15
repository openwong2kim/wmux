/**
 * The longest single held write (`daemon.session.writeHeldV1`), in UTF-16
 * units. Escaped as JSON it stays under the daemon's 1 MB control-pipe line
 * cap even at 6 bytes a unit (a control character as \u00XX). Main sends a
 * longer paste as several held writes, every one under the same token; the
 * daemon refuses a longer one.
 */
export const HELD_WRITE_CHUNK_MAX = 128 * 1024;

/** `data` in held-write chunks, never splitting a surrogate pair. */
export function heldWriteChunks(data: string): string[] {
  if (data.length <= HELD_WRITE_CHUNK_MAX) return [data];
  const chunks: string[] = [];
  for (let at = 0; at < data.length;) {
    let end = Math.min(at + HELD_WRITE_CHUNK_MAX, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(data.slice(at, end));
    at = end;
  }
  return chunks;
}
