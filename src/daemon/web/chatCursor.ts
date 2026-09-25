import type { ChatSource } from '../chat/chatBridge';

/**
 * Cursor v2 for `GET /api/sessions/:id/turns` once the chat bridge is wired
 * (contract §5.3). Still opaque base64url JSON to the client; what changed is
 * that it names WHICH conversation its offsets belong to — the reader (`src`),
 * the native id (`a`) and the bridge epoch (`e`) — so a new Claude session in
 * the same pane, an OpenCode route switch or a managed record can never be
 * paged with offsets taken from another one.
 */
export type ReadSource = Exclude<ChatSource, 'none'>;

export interface ChatCursor {
  v: 2;
  src: ReadSource;
  a: string;
  e: string;
  head: number;
  tail?: number;
  fileSize?: number;
}

export function encodeChatCursor(c: ChatCursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

/**
 * Decode, or null for anything that is not a well-formed v2 cursor. A v1
 * cursor (no `v`) decodes to null ON PURPOSE: the caller answers a tail
 * snapshot with `reset:true`, which is how a phone upgraded across the daemon
 * change re-bases once instead of paging an unbound offset.
 */
export function decodeChatCursor(raw: string | null): ChatCursor | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 2) return null;
  if (r.src !== 'file' && r.src !== 'tui' && r.src !== 'managed') return null;
  if (typeof r.a !== 'string' || typeof r.e !== 'string') return null;
  if (typeof r.head !== 'number' || !Number.isFinite(r.head) || r.head < 0) return null;
  const tail = r.tail;
  const fileSize = r.fileSize;
  if (tail !== undefined && (typeof tail !== 'number' || !Number.isFinite(tail) || tail < 0)) return null;
  if (fileSize !== undefined && (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0)) return null;
  return {
    v: 2,
    src: r.src,
    a: r.a,
    e: r.e,
    head: r.head,
    ...(tail !== undefined ? { tail } : {}),
    ...(fileSize !== undefined ? { fileSize } : {}),
  };
}

/**
 * Rules 1–4 of §5.3: the cursor belongs to the conversation the pane has NOW.
 * Applied to forward and back reads alike — a back page trusted blindly would
 * prepend rows of a new file at offsets taken from the old one.
 */
export function cursorMatches(
  cursor: ChatCursor | null,
  current: { src: ReadSource; agentSessionId: string; epoch: string },
): cursor is ChatCursor {
  return cursor !== null &&
    cursor.src === current.src &&
    cursor.a === current.agentSessionId &&
    cursor.e === current.epoch;
}
