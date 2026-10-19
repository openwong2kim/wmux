// ─── A phone message to Moa (main side of `moa.wake`) ────────────────────────
//
// The daemon forwards a phone's message to Moa over the desktop bridge
// (src/shared/moaWake.ts). With `mode: 'factory'` it goes to the agent
// factory's HQ bot (factoryWiring.ts installs the taker), or with
// `workspaceId` + `threadId` to that one conversation (a bot's 1:1 or a group
// chat, `POST /api/rooms/:workspaceId/messages`); the factory off
// answers `factory_off` and the daemon takes the Moa pane path itself. Any
// other `moa.wake` answers `moa_off`: there is no Moa brain to wake.

import type { MoaWakeAttachment, MoaWakePayload, MoaWakeResult } from '../../shared/moaWake';
import { ROOM_ATTACHMENT_LIMITS, UPLOAD_NAME_RE } from '../../shared/roomAttachments';
import { parseThreadId } from '../../shared/room';
import { isPhoneRoomWorkspaceId } from '../../shared/phoneRooms';

/** The agent factory's taker of a phone message to Moa: null when the
 *  factory is off. Resolves once the message's wake is on disk. Installed by
 *  the factory wiring. */
export type FactoryPhoneMessageHandler = (payload: MoaWakePayload) => Promise<MoaWakeResult | null>;

let factoryHandler: FactoryPhoneMessageHandler | null = null;

export function setFactoryPhoneMessageHandler(h: FactoryPhoneMessageHandler | null): void {
  factoryHandler = h;
}

/**
 * The bridge command, answered once the message's wake is on disk. A
 * malformed payload rejects (the daemon validated it, so this is not a
 * phone-reachable answer).
 */
export async function handlePhoneMoaWake(raw: Record<string, unknown>): Promise<MoaWakeResult> {
  const { clientMessageId, text, actor, deviceId, mode, workspaceId, threadId } = raw;
  // A target is both fields or neither, and only for the factory.
  const targeted = workspaceId !== undefined || threadId !== undefined;
  // Photos ride a targeted message only; with them the text may be empty.
  const attachments = raw.attachments === undefined ? undefined : parseWakeAttachments(raw.attachments);
  if (attachments === null || (attachments && !targeted)) throw new Error('invalid moa.wake payload');
  if (typeof clientMessageId !== 'string' || clientMessageId.length === 0 || clientMessageId.length > 128 ||
      typeof text !== 'string' || (!text.trim() && !attachments) || typeof actor !== 'string' || actor.length === 0 || actor.length > 256 ||
      (deviceId !== undefined && typeof deviceId !== 'string') || (mode !== undefined && mode !== 'factory') ||
      (targeted && (mode !== 'factory' || !isPhoneRoomWorkspaceId(workspaceId) || parseThreadId(threadId) === null))) {
    throw new Error('invalid moa.wake payload');
  }
  if (mode !== 'factory') return { ok: false, code: 'moa_off' };
  const payload: MoaWakePayload = {
    clientMessageId, text, actor, mode,
    ...(typeof deviceId === 'string' ? { deviceId } : {}),
    ...(targeted ? { workspaceId: workspaceId as string, threadId: parseThreadId(threadId) as string } : {}),
    ...(attachments ? { attachments } : {}),
  };
  let r: MoaWakeResult | null = null;
  try {
    r = (await factoryHandler?.(payload)) ?? null;
  } catch (err) {
    console.warn(`[factory] phone message failed: ${String(err)}`);
    return { ok: false, code: 'hq_unknown' };
  }
  return r ?? { ok: false, code: 'factory_off' };
}

/** The payload's photos: 1–PER_MESSAGE distinct uploads by name, size and
 *  SHA-256; null for any other shape. */
function parseWakeAttachments(value: unknown): MoaWakeAttachment[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > ROOM_ATTACHMENT_LIMITS.PER_MESSAGE) return null;
  const out: MoaWakeAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const a = raw as Record<string, unknown>;
    if (typeof a.uploadId !== 'string' || !UPLOAD_NAME_RE.test(a.uploadId) || out.some((o) => o.uploadId === a.uploadId)) return null;
    // Size and hash both, or neither (the daemon found the file gone).
    if (a.bytes === undefined && a.sha256 === undefined) {
      out.push({ uploadId: a.uploadId });
      continue;
    }
    if (typeof a.bytes !== 'number' || !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > ROOM_ATTACHMENT_LIMITS.SOURCE_MAX_BYTES) return null;
    if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return null;
    out.push({ uploadId: a.uploadId, bytes: a.bytes, sha256: a.sha256 });
  }
  return out;
}
