// ─── Wake Moa from the phone — the daemon ↔ main contract ────────────────────
//
// `/api/config` names the Moa pane only once its brain TUI runs, and main
// starts that brain lazily on the first turn. A phone that wants to talk to
// Moa before anyone typed on the desktop sends its first message through the
// desktop bridge as `moa.wake`; main runs it as an ordinary human turn.
//
// Main answers on ACCEPT, never on turn end: a cold start takes longer than
// the bridge's 15 s request timeout. Refusals are results, never throws, so
// the daemon can tell "main said no" from "nothing came back".

/** The optional desktop-bridge command main announces at register. */
export const MOA_WAKE_COMMAND = 'moa.wake';

/** Announced alongside MOA_WAKE_COMMAND by a desktop whose agent factory can
 *  take the phone's messages to Moa: the daemon then sends each message as
 *  `moa.wake` with `mode: 'factory'` first, and falls back to the Moa pane /
 *  wake path when main answers `factory_off`. */
export const FACTORY_PHONE_MESSAGE_CAPABILITY = 'factory.message';

/** Announced by a desktop whose factory takes a phone message addressed to
 *  one conversation of the Bots page (`POST /api/rooms/:workspaceId/messages`):
 *  `moa.wake` with `mode: 'factory'` plus `workspaceId` and `threadId`. A
 *  desktop without it would ignore the target and deliver to its phone bot,
 *  so the daemon never sends a target to one. */
export const FACTORY_THREAD_MESSAGE_CAPABILITY = 'factory.threadMessage';

/** Announced by a desktop whose factory takes photos with a message for one
 *  conversation (`attachments` on the payload, shared/roomAttachments.ts).
 *  A desktop without it would drop them silently, so the daemon never sends
 *  it a message with photos. */
export const FACTORY_THREAD_ATTACHMENTS_CAPABILITY = 'factory.threadAttachments';

export type MoaWakeRefusalCode =
  | 'moa_off' | 'mode_off' | 'not_hq' | 'hq_missing' | 'hq_unknown'
  | 'unsupported_vendor' | 'busy' | 'duplicate'
  /** mode 'factory' only: the factory is off; nothing ran, use the Moa path. */
  | 'factory_off'
  /** A targeted message only: the 1:1's bot does not exist in that room, or
   *  is switched off; the group chat does not exist, or none of its bots is
   *  on. Nothing was posted. `room_refused`: the room took no card. */
  | 'bot_missing' | 'bot_off' | 'group_missing' | 'group_off' | 'room_refused'
  /** mode 'factory': the id already stands for a card with other words or in
   *  another thread. Nothing was posted or queued. */
  | 'id_reused'
  /** A targeted message with photos: a photo could not be taken (`reason`).
   *  Nothing was posted. */
  | 'attachment_refused'
  /** A targeted message with photos: the room's photo store is full.
   *  Nothing was posted. */
  | 'attachments_full';

/** Why a photo was refused: gone, not PNG/JPEG, too large, or not the file
 *  the daemon checked. */
export type MoaWakeAttachmentRefusal = 'missing' | 'type' | 'size' | 'changed';

export type MoaWakeResult =
  /** `queued`: the factory took the message as a wake for the HQ bot (its
   *  reply is a room card; no Moa pane will appear). */
  | { ok: true; accepted: true; queued?: true }
  | { ok: false; code: MoaWakeRefusalCode; reason?: MoaWakeAttachmentRefusal };

/** Failures main learns only after it accepted, reported over `daemon.moa.wakeResult`. */
export type MoaWakeFailure = 'tui-dialog' | 'spawn-failed';

/** What the daemon sends with `moa.wake`. `actor` is the daemon's chat owner for the caller. */
export interface MoaWakePayload {
  clientMessageId: string;
  text: string;
  actor: string;
  /** Display only; the daemon already authenticated the caller. */
  deviceId?: string;
  /** 'factory': deliver to the agent factory's HQ bot, or refuse
   *  `factory_off` without touching the Moa brain. */
  mode?: 'factory';
  /** With `mode: 'factory'`, both or neither (FACTORY_THREAD_MESSAGE_CAPABILITY):
   *  the conversation the message is for — a bot's 1:1 (`dm:<botId>`) or a
   *  group chat's thread (`group:<groupId>`, or `general` for a group made
   *  from the room) in the room of `workspaceId`. Neither: the phone bot. */
  workspaceId?: string;
  threadId?: string;
  /** With a target only (FACTORY_THREAD_ATTACHMENTS_CAPABILITY): the phone
   *  uploads the message carries, as the daemon read them. Main copies each
   *  from its own uploads folder and refuses one whose bytes are not these. */
  attachments?: MoaWakeAttachment[];
}

/** One phone upload on a message: its file name in the uploads folder (the
 *  daemon's name rule), and the size and SHA-256 the daemon read — both
 *  absent when the file is gone (a retry whose card already has its photos
 *  needs none; main refuses a new message with one). */
export interface MoaWakeAttachment {
  uploadId: string;
  bytes?: number;
  sha256?: string;
}

const REFUSAL_CODES: ReadonlySet<string> = new Set<MoaWakeRefusalCode>([
  'moa_off', 'mode_off', 'not_hq', 'hq_missing', 'hq_unknown', 'unsupported_vendor', 'busy', 'duplicate', 'factory_off',
  'bot_missing', 'bot_off', 'group_missing', 'group_off', 'room_refused', 'id_reused',
  'attachment_refused', 'attachments_full',
]);

const ATTACHMENT_REFUSALS: ReadonlySet<string> = new Set<MoaWakeAttachmentRefusal>(['missing', 'type', 'size', 'changed']);

/** Main's answer, or null for any shape outside the contract (the daemon reads that as uncertain). */
export function parseMoaWakeResult(raw: unknown): MoaWakeResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.ok === true && r.accepted === true) return r.queued === true ? { ok: true, accepted: true, queued: true } : { ok: true, accepted: true };
  if (r.ok === false && typeof r.code === 'string' && REFUSAL_CODES.has(r.code)) {
    const reason = r.code === 'attachment_refused' && typeof r.reason === 'string' && ATTACHMENT_REFUSALS.has(r.reason)
      ? r.reason as MoaWakeAttachmentRefusal : undefined;
    return { ok: false, code: r.code as MoaWakeRefusalCode, ...(reason ? { reason } : {}) };
  }
  return null;
}

export function isMoaWakeFailure(value: unknown): value is MoaWakeFailure {
  return value === 'tui-dialog' || value === 'spawn-failed';
}
