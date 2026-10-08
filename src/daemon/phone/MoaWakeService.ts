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
  MOA_WAKE_COMMAND, parseMoaWakeResult,
  type MoaWakeFailure, type MoaWakePayload, type MoaWakeRefusalCode,
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

export type MoaWakeState = 'pending' | 'accepted' | 'failed' | 'uncertain';

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
function refusalWire(code: MoaWakeRefusalCode, clientMessageId: string): { wire: MoaWakeWire; release: boolean } {
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
  }
}

export class MoaWakeService {
  private readonly now: () => number;
  private starting: { at: number; owner: string; clientMessageId: string } | null = null;
  private delivered: Array<ChatDeliveredMessage & { owner: string }> = [];

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
  peek(owner: string, clientMessageId: string, text: string): MoaWakeWire | null {
    const seen = this.store()?.peek(owner, clientMessageId, WAKE_SLOT, receiptHash(['moa-wake', text])) ?? null;
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
    const { owner, clientMessageId, text } = input;
    const desktop = this.deps.desktop();
    if (!desktop?.available || !desktop.supports(MOA_WAKE_COMMAND)) {
      return { status: 503, body: { error: 'desktop-unavailable', clientMessageId } };
    }
    const store = this.store();
    if (!store) return { status: 500, body: { error: 'chat-persist-failed', clientMessageId } };
    const bodyHash = receiptHash(['moa-wake', text]);
    let begun;
    try {
      begun = await store.begin(owner, clientMessageId, WAKE_SLOT, bodyHash);
    } catch {
      return { status: 500, body: { error: 'chat-persist-failed', clientMessageId } };
    }
    if (begun.kind === 'full') return { status: 409, body: { error: 'message-history-full', clientMessageId } };
    if (begun.kind !== 'new') return this.peek(owner, clientMessageId, text) ?? { status: 202, body: { state: 'uncertain', clientMessageId } };

    const payload: MoaWakePayload = { clientMessageId, text, actor: owner, ...(input.deviceId ? { deviceId: input.deviceId } : {}) };
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
    if (result.ok) {
      this.starting = { at: this.now(), owner, clientMessageId };
      this.delivered.push({ owner, clientMessageId, text, at: this.now() });
      if (this.delivered.length > DELIVERED_MAX) this.delivered.splice(0, this.delivered.length - DELIVERED_MAX);
      return this.finish(store, owner, clientMessageId, 'done', { status: 202, body: { state: 'accepted', clientMessageId } });
    }
    const { wire, release } = refusalWire(result.code, clientMessageId);
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
    return store.revise(owner, clientMessageId, 'refused', {
      status: 409,
      body: { state: 'failed', error: 'moa-wake-failed', code: failure, clientMessageId },
    });
  }

  /** `GET /api/moa/messages/:id`: the owner's own wake, or null when unknown. */
  view(owner: string, clientMessageId: string): MoaWakeView | null {
    const row = this.store()?.lookup(owner, clientMessageId);
    if (!row || row.approvalId !== WAKE_SLOT) return null;
    if (row.state === 'inFlight') return { state: 'pending' };
    const body = row.result?.body;
    if (row.state === 'uncertain' || !body) return { state: 'uncertain' };
    const state = body.state === 'accepted' || body.state === 'failed' ? body.state : 'uncertain';
    return { state, ...(state === 'failed' && typeof body.code === 'string' ? { code: body.code } : {}) };
  }

  /** The owner's accepted wake texts, for tagging their `/turns` rows. Memory only. */
  deliveredFor(owner: string): ChatDeliveredMessage[] {
    return this.delivered
      .filter((d) => d.owner === owner)
      .map(({ clientMessageId, text, at }) => ({ clientMessageId, text, at }));
  }
}
