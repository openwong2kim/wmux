// ─── Wake Moa from the phone (daemon side) ──────────────────────────────────
//
// `POST /api/moa/messages` while no Moa pane exists: the phone's first
// message goes to main as `moa.wake` over the desktop bridge, and main runs it
// as a human turn on the HQ brain (src/main/deck/moaWake.ts). Idempotent per
// `(chat owner, clientMessageId)` on its own receipt file,
// `phone-moa-wake-receipts.json` — the AnswerReceiptStore rules, the same
// 24 h retention as chat send receipts, and never the text, only its hash:
//
//   same id, same text, still running → 202 {state:'pending', replayed:true}
//   same id, same text, finished      → the stored response again
//   same id, other text               → 409 message-id-reused
//   timeout / disconnect after send   → 202 {state:'uncertain'}, never re-sent
//
// A receipt is released only when nothing ran: the request never left
// (desktop-unavailable, desktop-busy), or main answered a definite no-op the
// phone is told to retry (busy, unsupported_vendor). Main's other refusals
// are final for that id.

import type { AnswerReceiptStore, AnswerReceiptResponse } from '../approvals/AnswerReceiptStore';
import { receiptHash } from '../approvals/AnswerReceiptStore';
import type { ChatDeliveredMessage } from '../chat/chatBridge';
import { DesktopPhoneError, type DesktopPhoneBridge } from './DesktopPhoneBridge';
import {
  FACTORY_THREAD_ATTACHMENTS_CAPABILITY, FACTORY_THREAD_MESSAGE_CAPABILITY, MOA_WAKE_COMMAND, parseMoaWakeResult,
  type MoaWakeAttachment, type MoaWakeAttachmentRefusal, type MoaWakeFailure, type MoaWakePayload, type MoaWakeRefusalCode,
} from '../../shared/moaWake';

/** The receipt store's per-approval slot; every wake shares it. */
const WAKE_SLOT = 'moa-wake';
/** How long an accepted wake counts as "the brain is starting" with no pane yet. */
export const MOA_WAKE_STARTING_TTL_MS = 90_000;
/** Texts kept in memory for tagging the wake's row in `/turns`. */
const DELIVERED_MAX = 64;

export const MOA_WAKE_RETRY_AFTER = { starting: '3', busy: '5', desktopBusy: '2' } as const;

export interface MoaWakeWire {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** `queued`: the agent factory took the message as a wake for its HQ bot. */
export type MoaWakeState = 'pending' | 'accepted' | 'queued' | 'failed' | 'uncertain';

export interface MoaWakeView {
  state: MoaWakeState;
  code?: string;
}

export interface MoaWakeDeps {
  /** The receipt store; throws when its file is unreadable. */
  receipts: () => AnswerReceiptStore;
  desktop: () => DesktopPhoneBridge | null;
  now?: () => number;
}

/** A refusal main returned, as the phone sees it. */
function refusalWire(code: MoaWakeRefusalCode, clientMessageId: string, reason?: MoaWakeAttachmentRefusal): { wire: MoaWakeWire; release: boolean } {
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    ({ status, body: { state: 'failed', error, code: error, ...extra, clientMessageId }, ...(headers ? { headers } : {}) });
  switch (code) {
    case 'moa_off': return { wire: fail(409, 'moa-off'), release: false };
    case 'mode_off': return { wire: fail(409, 'moa-mode-off'), release: false };
    case 'not_hq': case 'hq_missing': case 'hq_unknown':
      return { wire: fail(409, 'no-hq', { reason: code.replace('_', '-') }), release: false };
    case 'busy':
      return { wire: fail(409, 'moa-busy', {}, { 'Retry-After': MOA_WAKE_RETRY_AFTER.busy }), release: true };
    case 'unsupported_vendor':
      return { wire: fail(503, 'desktop-unavailable', { reason: 'unsupported-vendor' }), release: true };
    case 'duplicate':
      // Main already ran this id; the daemon lost track of how it went.
      return { wire: { status: 202, body: { state: 'uncertain', clientMessageId } }, release: false };
    case 'factory_off':
      // Nothing ran; only a factory send gets it, and it falls back first.
      return { wire: fail(409, 'factory-off'), release: true };
    // A targeted message: nothing was posted. Final for the id, like no-hq;
    // a room that took no card may take it later, so that id is released.
    case 'bot_missing': case 'bot_off': case 'group_missing': case 'group_off': case 'room_refused':
      return { wire: fail(409, 'no-recipient', { reason: code.replace('_', '-') }), release: code === 'room_refused' };
    case 'id_reused':
      // Its first card is in the room: the id stays bound to it.
      return { wire: { status: 409, body: { error: 'message-id-reused', clientMessageId } }, release: false };
    // A photo main could not take, or no room for it: nothing was posted.
    case 'attachment_refused':
      return { wire: fail(409, 'attachment-refused', reason ? { reason } : {}), release: true };
    case 'attachments_full':
      return { wire: fail(507, 'attachments-full'), release: true };
  }
}

/** The conversation a targeted message is for (`POST /api/rooms/:workspaceId/messages`). */
export interface MoaWakeTarget {
  workspaceId: string;
  threadId: string;
}

/** What an id's text is recorded as: a target is part of it, so the same id
 *  with the same text sent to another conversation is a reused id; so are
 *  the photos, by their upload names in order (never their bytes: a replay
 *  after the uploads were swept must still answer). A message without
 *  photos hashes as before photos existed. */
function wakeHash(text: string, target?: MoaWakeTarget, uploads: readonly string[] = []): string {
  if (!target) return receiptHash(['moa-wake', text]);
  return receiptHash(['moa-wake', text, target.workspaceId, target.threadId, ...(uploads.length > 0 ? ['uploads', ...uploads] : [])]);
}

/** Read the photos a new message names, once its receipt is begun. */
export type MoaWakeAttachmentReader = () => Promise<{ ok: true; attachments: MoaWakeAttachment[]; missing?: number[] } | { ok: false; wire: MoaWakeWire }>;

function failureResponse(failure: MoaWakeFailure, clientMessageId: string): AnswerReceiptResponse {
  return { status: 409, body: { state: 'failed', error: 'moa-wake-failed', code: failure, clientMessageId } };
}

export class MoaWakeService {
  private readonly now: () => number;
  private starting: { at: number; owner: string; clientMessageId: string } | null = null;
  private delivered: Array<ChatDeliveredMessage & { owner: string }> = [];
  /**
   * Failures main reported before this daemon finished recording the accept.
   * A brain that fails at once (no claude binary) sends its report right
   * behind the accept, and the pipe can hand both lines over in one read.
   */
  private earlyFailures = new Map<string, MoaWakeFailure>();

  constructor(private readonly deps: MoaWakeDeps) {
    this.now = deps.now ?? Date.now;
  }

  private store(): AnswerReceiptStore | null {
    try {
      return this.deps.receipts();
    } catch {
      return null;
    }
  }

  /**
   * What an id already stands for, or null when it is unused. Checked before
   * any routing, so a retry after the pane appeared replays the wake instead
   * of becoming a second turn through the chat path.
   */
  peek(owner: string, clientMessageId: string, text: string, target?: MoaWakeTarget, uploads?: readonly string[]): MoaWakeWire | null {
    const seen = this.store()?.peek(owner, clientMessageId, WAKE_SLOT, wakeHash(text, target, uploads)) ?? null;
    if (!seen) return null;
    switch (seen.kind) {
      case 'reused': return { status: 409, body: { error: 'message-id-reused', clientMessageId } };
      case 'in-flight': return { status: 202, body: { state: 'pending', replayed: true, clientMessageId } };
      case 'uncertain': return { status: 202, body: { state: 'uncertain', replayed: true, clientMessageId } };
      case 'replay': return { status: seen.response.status, body: { ...seen.response.body, replayed: true } };
    }
  }

  /** An accepted wake whose pane has not appeared yet (bounded). */
  isStarting(): boolean {
    if (!this.starting) return false;
    if (this.now() - this.starting.at >= MOA_WAKE_STARTING_TTL_MS) this.starting = null;
    return this.starting !== null;
  }

  /** The Moa pane is published: the start is over. */
  paneAppeared(): void {
    this.starting = null;
  }

  async wake(input: { owner: string; clientMessageId: string; text: string; deviceId?: string }): Promise<MoaWakeWire> {
    return (await this.send(input, false)) as MoaWakeWire;
  }

  /**
   * The agent factory's route (the desktop announced
   * FACTORY_PHONE_MESSAGE_CAPABILITY): main queues the message for its HQ bot
   * and answers `queued`, or `factory_off` — then the receipt is released and
   * null comes back, so the caller takes the Moa path with the same id.
   */
  factoryMessage(input: { owner: string; clientMessageId: string; text: string; deviceId?: string }): Promise<MoaWakeWire | null> {
    return this.send(input, true);
  }

  /**
   * A message to one conversation of the desktop's Bots page (a bot's 1:1 or
   * a group chat): the factory route with a target, on the same receipt file
   * and rules. Only a desktop that announced FACTORY_THREAD_MESSAGE_CAPABILITY
   * is sent one (an older one would deliver it to its phone bot); the factory
   * off is `409 factory-off`, with the id released.
   */
  async roomMessage(input: {
    owner: string; clientMessageId: string; text: string; deviceId?: string; target: MoaWakeTarget;
    /** The photos' upload names, and how to read them once the id is new. */
    uploads?: readonly string[]; readAttachments?: MoaWakeAttachmentReader;
  }): Promise<MoaWakeWire> {
    const desktop = this.deps.desktop();
    if (!desktop?.available || !desktop.supports(FACTORY_THREAD_MESSAGE_CAPABILITY)) {
      return { status: 503, body: { error: 'desktop-unavailable', clientMessageId: input.clientMessageId } };
    }
    const wire = await this.send(input, true, input.target, input.uploads?.length ? { uploads: input.uploads, read: input.readAttachments } : undefined);
    if (wire) return wire;
    const { wire: off } = refusalWire('factory_off', input.clientMessageId);
    return { ...off, body: { ...off.body, replayed: false } };
  }

  private async send(
    input: { owner: string; clientMessageId: string; text: string; deviceId?: string },
    factory: boolean,
    target?: MoaWakeTarget,
    photos?: { uploads: readonly string[]; read?: MoaWakeAttachmentReader },
  ): Promise<MoaWakeWire | null> {
    const { owner, clientMessageId, text } = input;
    const desktop = this.deps.desktop();
    if (!desktop?.available || !desktop.supports(MOA_WAKE_COMMAND)) {
      return { status: 503, body: { error: 'desktop-unavailable', clientMessageId } };
    }
    const store = this.store();
    if (!store) return { status: 500, body: { error: 'chat-persist-failed', clientMessageId } };
    const bodyHash = wakeHash(text, target, photos?.uploads);
    let begun;
    try {
      begun = await store.begin(owner, clientMessageId, WAKE_SLOT, bodyHash);
    } catch {
      return { status: 500, body: { error: 'chat-persist-failed', clientMessageId } };
    }
    if (begun.kind === 'full') return { status: 409, body: { error: 'message-history-full', clientMessageId } };
    if (begun.kind !== 'new') return this.peek(owner, clientMessageId, text, target, photos?.uploads) ?? { status: 202, body: { state: 'uncertain', clientMessageId } };

    // The photos are read only for a new id: a replay never needs the files.
    let attachments: MoaWakeAttachment[] | undefined;
    // The first upload the daemon found gone, for main's `missing` refusal.
    let missingAt: number | undefined;
    if (photos) {
      if (!target || !desktop.supports(FACTORY_THREAD_ATTACHMENTS_CAPABILITY) || !photos.read) {
        await store.release(owner, clientMessageId);
        return { status: 409, body: { error: 'attachments-unsupported', effect: 'none', clientMessageId } };
      }
      let read: Awaited<ReturnType<MoaWakeAttachmentReader>>;
      try {
        read = await photos.read();
      } catch {
        read = { ok: false, wire: { status: 500, body: { error: 'attachment-read-failed', effect: 'none', clientMessageId } } };
      }
      if (!read.ok) {
        await store.release(owner, clientMessageId);
        return read.wire;
      }
      attachments = read.attachments;
      missingAt = read.missing?.[0];
    }

    const payload: MoaWakePayload = {
      clientMessageId, text, actor: owner,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(factory ? { mode: 'factory' as const } : {}),
      ...(target ? { workspaceId: target.workspaceId, threadId: target.threadId } : {}),
      ...(attachments ? { attachments } : {}),
    };
    // The desktop may have changed while the receipt was written: a target
    // goes only to one that announced it now (request takes this owner
    // synchronously, with nothing awaited in between).
    if (target && (!desktop.supports(FACTORY_THREAD_MESSAGE_CAPABILITY) || (attachments && !desktop.supports(FACTORY_THREAD_ATTACHMENTS_CAPABILITY)))) {
      await store.release(owner, clientMessageId);
      return { status: 503, body: { error: 'desktop-unavailable', clientMessageId } };
    }
    let raw: unknown;
    try {
      raw = await desktop.request(MOA_WAKE_COMMAND, { ...payload });
    } catch (err) {
      const tag = err instanceof DesktopPhoneError ? err.tag : '';
      // Refused before anything left: the same id may try again.
      if (tag === 'desktop-unavailable' || tag === 'desktop-busy') {
        await store.release(owner, clientMessageId);
        return tag === 'desktop-busy'
          ? { status: 429, body: { error: 'desktop-busy', clientMessageId }, headers: { 'Retry-After': MOA_WAKE_RETRY_AFTER.desktopBusy } }
          : { status: 503, body: { error: 'desktop-unavailable', clientMessageId } };
      }
      // Sent, and no answer: main may have started the turn.
      return this.finish(store, owner, clientMessageId, 'uncertain', { status: 202, body: { state: 'uncertain', clientMessageId } });
    }
    const result = parseMoaWakeResult(raw);
    if (!result) return this.finish(store, owner, clientMessageId, 'uncertain', { status: 202, body: { state: 'uncertain', clientMessageId } });
    if (result.ok && result.queued) {
      // A queued wake starts no Moa pane: nothing to wait for.
      return this.finish(store, owner, clientMessageId, 'done', { status: 202, body: { state: 'queued', clientMessageId } });
    }
    if (!result.ok && result.code === 'factory_off' && factory) {
      await store.release(owner, clientMessageId);
      return null;
    }
    if (result.ok) {
      const early = this.earlyFailures.get(receiptHash([owner, clientMessageId]));
      if (early) {
        this.earlyFailures.delete(receiptHash([owner, clientMessageId]));
        await store.finish(owner, clientMessageId, 'done', { status: 202, body: { state: 'accepted', clientMessageId } });
        const failed = failureResponse(early, clientMessageId);
        await store.revise(owner, clientMessageId, 'refused', failed);
        return { status: failed.status, body: { ...failed.body, replayed: false } };
      }
      this.starting = { at: this.now(), owner, clientMessageId };
      this.delivered.push({ owner, clientMessageId, text, at: this.now() });
      if (this.delivered.length > DELIVERED_MAX) this.delivered.splice(0, this.delivered.length - DELIVERED_MAX);
      return this.finish(store, owner, clientMessageId, 'done', { status: 202, body: { state: 'accepted', clientMessageId } });
    }
    // A new message naming an upload that is gone: the phone's own answer
    // for it, as the daemon would have given had the file been needed.
    if (!result.ok && result.code === 'attachment_refused' && result.reason === 'missing' && missingAt !== undefined) {
      await store.release(owner, clientMessageId);
      return { status: 400, body: { error: 'attachment-not-found', index: missingAt, effect: 'none', clientMessageId } };
    }
    const { wire, release } = refusalWire(result.code, clientMessageId, result.reason);
    if (release) {
      await store.release(owner, clientMessageId);
      return wire;
    }
    const state = result.code === 'duplicate' ? 'uncertain' : 'refused';
    return this.finish(store, owner, clientMessageId, state, { status: wire.status, body: wire.body });
  }

  private async finish(
    store: AnswerReceiptStore, owner: string, clientMessageId: string,
    state: 'done' | 'refused' | 'uncertain', response: AnswerReceiptResponse,
  ): Promise<MoaWakeWire> {
    await store.finish(owner, clientMessageId, state, response);
    return { status: response.status, body: { ...response.body, replayed: false } };
  }

  /**
   * Main learned after the accept that the brain never took the message
   * (`daemon.moa.wakeResult`). Only an accepted wake can fail this way.
   */
  async recordFailure(owner: string, clientMessageId: string, failure: MoaWakeFailure): Promise<boolean> {
    const store = this.store();
    if (!store) return false;
    if (this.starting?.owner === owner && this.starting.clientMessageId === clientMessageId) this.starting = null;
    this.delivered = this.delivered.filter((d) => !(d.owner === owner && d.clientMessageId === clientMessageId));
    if (await store.revise(owner, clientMessageId, 'refused', failureResponse(failure, clientMessageId))) return true;
    // The accept is still on its way in: hold the failure for wake() to apply.
    if (store.lookup(owner, clientMessageId)?.state !== 'inFlight') return false;
    this.earlyFailures.set(receiptHash([owner, clientMessageId]), failure);
    if (this.earlyFailures.size > DELIVERED_MAX) this.earlyFailures.delete(this.earlyFailures.keys().next().value!);
    return true;
  }

  /** `GET /api/moa/messages/:id`: the owner's own wake, or null when unknown. */
  view(owner: string, clientMessageId: string): MoaWakeView | null {
    const row = this.store()?.lookup(owner, clientMessageId);
    if (!row || row.approvalId !== WAKE_SLOT) return null;
    if (row.state === 'inFlight') return { state: 'pending' };
    const body = row.result?.body;
    if (row.state === 'uncertain' || !body) return { state: 'uncertain' };
    const state = body.state === 'accepted' || body.state === 'queued' || body.state === 'failed' ? body.state : 'uncertain';
    return { state, ...(state === 'failed' && typeof body.code === 'string' ? { code: body.code } : {}) };
  }

  /** The owner's accepted wake texts, for tagging their `/turns` rows. Memory only. */
  deliveredFor(owner: string): ChatDeliveredMessage[] {
    return this.delivered
      .filter((d) => d.owner === owner)
      .map(({ clientMessageId, text, at }) => ({ clientMessageId, text, at }));
  }
}
