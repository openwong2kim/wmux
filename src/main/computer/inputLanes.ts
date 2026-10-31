// Input lanes: who may send input when (docs/computer-use-design.md, Input
// lanes). Pure: no helper, no clock of its own.
//
//   - ForegroundLease: real (foreground) input moves the user's pointer and
//     front window, so one agent at a time holds it, for INPUT_LOCK_IDLE_MS
//     after its last foreground input. Another agent gets input_busy at once;
//     the lease never waits.
//   - PidLanes: input posted in the background to one app runs in arrival
//     order, one action at a time per target pid; different pids never wait
//     on each other. A stop ends every queued waiter with `aborted`.
//   - foregroundCertain: the actions main knows need real input up front
//     (they take the lease, never a pid slot). It mirrors the Windows
//     helper's Core Background.ActionRefusal; anything else is sent with
//     `foreground: 'refuse'` and upgraded only when the helper answers
//     needs_foreground.
//
// Lock order is always pid slot, then lease. Foreground-first actions take no
// pid slot and the lease never waits, so no cycle can form.

import { ComputerError } from '../../shared/computer/errors';
import type { ComputerControlAction, Modifier, MouseButton } from '../../shared/computer/protocol';

export const INPUT_LOCK_IDLE_MS = 15_000;

/** One agent's hold on real input. */
export class ForegroundLease {
  private holder: { agentKey: string; label: string; lastUsedAt: number } | null = null;

  constructor(private readonly idleMs = INPUT_LOCK_IDLE_MS) {}

  /** Takes (or refreshes) the lease for `agent`; input_busy when another agent used it within idleMs. */
  take(agent: { key: string; label: string }, now: number): void {
    if (this.holder && this.holder.agentKey !== agent.key && now - this.holder.lastUsedAt <= this.idleMs) {
      // The label, never the key: the key carries pane ids.
      throw new ComputerError('input_busy', `${this.holder.label} is using the desktop`);
    }
    this.holder = { agentKey: agent.key, label: agent.label, lastUsedAt: now };
  }

  /** The label of the agent holding it now, or null. */
  label(now: number): string | null {
    if (!this.holder || now - this.holder.lastUsedAt > this.idleMs) return null;
    return this.holder.label;
  }

  clear(): void {
    this.holder = null;
  }
}

/** Gives a pid slot back; calling it more than once is harmless. */
export type ReleaseSlot = () => void;

/**
 * One FIFO chain per target pid. `acquire` resolves when every earlier
 * holder of that pid has released; it waits outside the slot, so a waiter
 * holds nothing. `abortWaiting` (the stop key) rejects every waiter that has
 * not got its slot yet with `aborted`; the chain stays in order behind it.
 */
export class PidLanes {
  private readonly tails = new Map<number, Promise<void>>();
  private stop = PidLanes.stopSignal();

  private static stopSignal(): { fired: Promise<void>; fire: () => void } {
    let fire!: () => void;
    const fired = new Promise<void>((resolve) => { fire = resolve; });
    return { fired, fire };
  }

  acquire(pid: number): Promise<ReleaseSlot> {
    const prev = this.tails.get(pid) ?? Promise.resolve();
    let open!: () => void;
    const mine = new Promise<void>((resolve) => { open = resolve; });
    const tail = prev.then(() => mine);
    this.tails.set(pid, tail);
    void tail.then(() => {
      if (this.tails.get(pid) === tail) this.tails.delete(pid);
    });
    let released = false;
    const release: ReleaseSlot = () => {
      if (released) return;
      released = true;
      open();
    };
    const stop = this.stop;
    return new Promise<ReleaseSlot>((resolve, reject) => {
      let settled = false;
      void prev.then(() => {
        // Stopped while waiting: pass the slot straight on.
        if (settled) return release();
        settled = true;
        resolve(release);
      });
      void stop.fired.then(() => {
        if (settled) return;
        settled = true;
        reject(new ComputerError('aborted', 'computer use was stopped by the user'));
      });
    });
  }

  /** The stop key: every waiter still queued ends `aborted`. */
  abortWaiting(): void {
    this.stop.fire();
    this.stop = PidLanes.stopSignal();
  }

  /** Pids with a holder or a waiter (for tests and status). */
  busyPids(): number[] {
    return [...this.tails.keys()];
  }
}

/**
 * Text a single focus check cannot cover: any control character other than
 * one trailing newline (`\n`, `\r\n` or `\r`). A Tab moves focus, so the rest
 * would land where no check was made; the helper sends such text as real
 * input, which re-checks focus before every chunk. Mirrors Core
 * Background.MovesFocus.
 */
export function textMovesFocus(text: string): boolean {
  let body = text;
  if (body.endsWith('\r\n')) body = body.slice(0, -2);
  else if (body.endsWith('\n') || body.endsWith('\r')) body = body.slice(0, -1);
  for (const ch of body) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export interface LaneRequest {
  action: ComputerControlAction;
  button?: MouseButton;
  clickCount?: number;
  modifiers?: Modifier[];
  text?: string;
}

/**
 * Whether an action certainly needs real input, so it takes the foreground
 * lease up front and no pid slot: any modifiers, a hotkey, a button other
 * than left, more than one click, scroll, openApp, and `type` text that can
 * move focus. setValue is a UIA call (no input, no raise), so it is not.
 */
export function foregroundCertain(req: LaneRequest): boolean {
  switch (req.action) {
    case 'openApp':
    case 'hotkey':
    case 'scroll':
      return true;
    case 'click':
      return (req.modifiers?.length ?? 0) > 0 || (req.button ?? 'left') !== 'left' || (req.clickCount ?? 1) > 1;
    case 'type':
      return typeof req.text === 'string' && textMovesFocus(req.text);
    default:
      return (req.modifiers?.length ?? 0) > 0;
  }
}
