// ─── Wake Moa from the phone (main side of `moa.wake`) ──────────────────────
//
// The daemon forwards a phone's first message to Moa over the desktop bridge
// when no Moa pane exists yet (see src/shared/moaWake.ts). Main runs it as an
// ordinary human turn on the HQ brain and answers on ACCEPT: the bridge times
// out at 15 s and a cold brain start can take longer than that. What happens
// after the accept that the phone must hear about — the brain stopped on a
// startup screen, or never came up — goes back over `daemon.moa.wakeResult`.
//
// The deck handler owns the gate, the managers and the turn, and installs the
// handler here; main/index.ts routes the bridge command to it.

import type { BrainEvent } from './BrainAdapter';
import type { BrainVendor } from '../../shared/types';
import type { CommanderSendResult } from './CommanderSessionManager';
import type { MoaWakeFailure, MoaWakePayload, MoaWakeRefusalCode, MoaWakeResult } from '../../shared/moaWake';

export interface MoaWakeReport {
  actor: string;
  clientMessageId: string;
  failure: MoaWakeFailure;
}

export interface MoaWakePorts {
  /** The gate for a Moa turn: a refusal code, or null when the HQ may run. */
  refuse: () => MoaWakeRefusalCode | null;
  /** The HQ workspace (only read after `refuse` passed). */
  hqWorkspaceId: () => string | null;
  /** The runtime that would serve the HQ's brain. */
  vendor: () => BrainVendor;
  /** ensureManager(hq).getStatus().status === 'idle'. */
  idle: (workspaceId: string) => boolean;
  /** runHumanTurn(hq, text, { source: 'phone', actor, onEvent }). */
  run: (
    workspaceId: string,
    text: string,
    opts: { actor: string; onEvent: (event: BrainEvent) => void },
  ) => Promise<CommanderSendResult>;
  /** Accepted ids main remembers, newest last. Tests shrink it. */
  dedupMax?: number;
}

export type MoaWakeHandler = (payload: MoaWakePayload, report: (r: MoaWakeReport) => void) => MoaWakeResult;

const DEDUP_MAX = 512;

/**
 * The handler the deck installs. Synchronous from the gate to the send on
 * purpose: `CommanderSessionManager.send` flips to busy before its first
 * await, so of two wakes racing here exactly one starts a turn and the other
 * reads busy.
 */
export function createMoaWakeHandler(ports: MoaWakePorts): MoaWakeHandler {
  // Accepted (actor, clientMessageId) pairs. Only accepts are remembered: a
  // refusal ran nothing, so the same id may come back (moa-busy is retryable).
  const accepted = new Set<string>();
  const max = ports.dedupMax ?? DEDUP_MAX;
  return (payload, report) => {
    const refusal = ports.refuse();
    if (refusal) return { ok: false, code: refusal };
    const workspaceId = ports.hqWorkspaceId();
    if (!workspaceId) return { ok: false, code: 'not_hq' };
    const key = `${payload.actor}\0${payload.clientMessageId}`;
    if (accepted.has(key)) return { ok: false, code: 'duplicate' };
    // Only the terminal brain has a pane the phone can then reach.
    if (ports.vendor() !== 'claude-pty') return { ok: false, code: 'unsupported_vendor' };
    if (!ports.idle(workspaceId)) return { ok: false, code: 'busy' };
    // The first error event of this turn says whether the prompt ever reached
    // the brain. Any other error means the turn ran; the accept stands.
    let failure: MoaWakeFailure | null = null;
    let sawError = false;
    const onEvent = (event: BrainEvent): void => {
      if (event.type !== 'error' || sawError) return;
      sawError = true;
      if (event.tuiDialog) failure = 'tui-dialog';
      else if (event.spawnFailed) failure = 'spawn-failed';
    };
    const done = ports.run(workspaceId, payload.text, { actor: payload.actor, onEvent });
    accepted.add(key);
    while (accepted.size > max) accepted.delete(accepted.values().next().value!);
    void done.then(() => {
      if (failure) report({ actor: payload.actor, clientMessageId: payload.clientMessageId, failure });
    }, () => { /* the manager catches its own throws; nothing to report */ });
    return { ok: true, accepted: true };
  };
}

let handler: MoaWakeHandler | null = null;

/** The deck handler's wake, or null on teardown. */
export function setMoaWakeHandler(h: MoaWakeHandler | null): void {
  handler = h;
}

/**
 * The bridge command. A malformed payload throws (the daemon validated it, so
 * this is not a phone-reachable answer); no deck yet answers moa_off.
 */
export function handlePhoneMoaWake(raw: Record<string, unknown>, report: (r: MoaWakeReport) => void): MoaWakeResult {
  const { clientMessageId, text, actor, deviceId } = raw;
  if (typeof clientMessageId !== 'string' || clientMessageId.length === 0 || clientMessageId.length > 128 ||
      typeof text !== 'string' || !text.trim() || typeof actor !== 'string' || actor.length === 0 || actor.length > 256 ||
      (deviceId !== undefined && typeof deviceId !== 'string')) {
    throw new Error('invalid moa.wake payload');
  }
  if (!handler) return { ok: false, code: 'moa_off' };
  return handler({ clientMessageId, text, actor, ...(typeof deviceId === 'string' ? { deviceId } : {}) }, report);
}
