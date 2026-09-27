/**
 * Turns approval lifecycle events into phone pushes: send now, or park while
 * the desktop is present, and drop a parked push once its approval is moot.
 *
 * One rule this owns that a flat "push on create" cannot: a record REPLACED
 * within the same awaiting episode (`create` with `replaces` — a
 * `terminal_prompt` re-parsed after its dialog was drawn or changed) is the
 * same question to the human. Its push is carried over, never repeated and
 * never lost:
 *   - the replaced record's push already went out → nothing more is sent;
 *   - it is still parked → the parked push moves to the new record;
 *   - it is still in its grace period → the new record inherits the REMAINING
 *     grace (the clock is not restarted);
 *   - it never went out at all → the new record is pushed normally.
 *
 * A `terminal_prompt` is the agent's own dialog, and it is usually answered at
 * the desk within seconds — or it vanishes on its own. Pushing it the instant
 * it appears put a banner on the phone for a dialog that was already gone by
 * the time anybody looked. So it waits out {@link TERMINAL_PROMPT_PUSH_GRACE_MS}
 * first, and a record that is answered, cleared or expired inside that window
 * is never pushed at all. After the grace the ordinary rules apply unchanged
 * (presence parking, critical bypassing presence).
 *
 * And if its push did go out, the record resolving later sends a RETRACTION
 * under the same collapse id, which replaces the banner on the phone rather
 * than leaving an "approval needed" for something nobody is waiting on.
 *
 * Gate records (`awaiting_input`, `awaiting_permission`) keep the old
 * behaviour: pushed on create, never retracted. They are wmux's own gates and
 * are routinely answered FROM the phone's lock screen, which already removes
 * the banner; the resolve event cannot tell a phone answer from a desktop one,
 * so a retraction there would mostly re-buzz a phone that just answered.
 */
import type { PushPayload } from '../../shared/push/pushEnvelope';
import type { ApprovalEvent, ApprovalRequest } from '../approvals/types';

/**
 * How long a `terminal_prompt` must stay pending before it reaches the phone.
 *
 * Long enough to cover somebody at the desk reading the dialog and answering
 * it, or the dialog clearing itself; short enough that a genuinely remote
 * approval is not noticeably late — a phone round trip takes longer anyway.
 *
 * Applied whether or not the desktop reports presence. "Absent" is presence's
 * fail-open default (no focus report at all reads as absent: a headless
 * daemon, an older app, suppression turned off), so skipping the grace when
 * absent would drop it in exactly the setups that produced the noise.
 */
export const TERMINAL_PROMPT_PUSH_GRACE_MS = 12_000;

export interface ApprovalPushRouterDeps {
  build(request: ApprovalRequest): PushPayload;
  /** The follow-up that replaces a delivered banner once its record is moot. */
  buildRetraction(request: ApprovalRequest): PushPayload;
  collapseId(request: ApprovalRequest): string;
  /** True when the push should be held (desktop present). */
  suppress(payload: PushPayload): boolean;
  send(payload: PushPayload, opts: { collapseId: string }): void;
  park(approvalId: string, payload: PushPayload, collapseId: string): void;
  forget(approvalId: string): void;
  /** Is this approval's push still parked (not yet released)? */
  isParked(approvalId: string): boolean;
  log?: (level: 'info' | 'warn', message: string) => void;
  /** Injected for tests; defaults to {@link TERMINAL_PROMPT_PUSH_GRACE_MS}. */
  graceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

type PushState = 'grace' | 'sent' | 'parked';

interface Tracked {
  state: PushState;
  /** `grace` only: when the push is due, and the latest record to build it from. */
  deadline?: number;
  request?: ApprovalRequest;
  timer?: unknown;
}

/** Records whose push state is remembered at most — a bound, not a policy. */
const MAX_TRACKED = 512;

export class ApprovalPushRouter {
  private readonly state = new Map<string, Tracked>();
  /**
   * Collapse ids whose banner is still on the phone although the record that
   * put it there was superseded by a DIFFERENT question (no `replaces`). The
   * next record in that pane owns the banner: it either pushes over it, or —
   * if it resolves unpushed — retracts it.
   */
  private readonly outstanding = new Set<string>();
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly setTimerImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerImpl: (handle: unknown) => void;

  constructor(private readonly deps: ApprovalPushRouterDeps) {
    this.graceMs = deps.graceMs ?? TERMINAL_PROMPT_PUSH_GRACE_MS;
    this.now = deps.now ?? Date.now;
    this.setTimerImpl =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A pending notification must never be the reason a daemon stays up.
        t.unref?.();
        return t;
      });
    this.clearTimerImpl = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  onEvent(event: ApprovalEvent): void {
    const r = event.request;
    if (event.type !== 'create') {
      if (event.type === 'press') return;
      // Remember whether a superseded record's push is still parked, for a
      // `create` that may replace it next; the push itself is moot either way.
      const parked = this.deps.isParked(r.id);
      this.deps.forget(r.id);
      const known = this.state.get(r.id);
      if (known?.timer !== undefined) {
        this.clearTimerImpl(known.timer);
        delete known.timer;
      }
      const delivered = known?.state === 'sent' || (known?.state === 'parked' && !parked);
      if (event.type === 'supersede') {
        if (known !== undefined) {
          // A `grace` entry keeps its deadline, timer-less, for the replacing
          // `create` that follows in the same batch. With none following it is
          // simply never pushed and ages out of the bound.
          this.remember(r.id, known.state === 'grace'
            ? { state: 'grace', ...(known.deadline !== undefined ? { deadline: known.deadline } : {}) }
            : { state: parked ? 'parked' : 'sent' });
          if (delivered) this.markOutstanding(this.deps.collapseId(r));
        }
        return;
      }
      // resolve / expire: the record is over.
      this.state.delete(r.id);
      if (r.kind === 'terminal_prompt') this.retractIfShown(r, delivered);
      return;
    }
    if (event.replaces !== undefined) {
      const previous = this.state.get(event.replaces);
      this.state.delete(event.replaces);
      if (previous?.state === 'sent') {
        // The banner is this record's now, not an orphan.
        this.outstanding.delete(this.deps.collapseId(r));
        this.remember(r.id, { state: 'sent' });
        return;
      }
      if (previous?.state === 'parked') {
        const payload = this.deps.build(r);
        this.deps.park(r.id, payload, this.deps.collapseId(r));
        this.remember(r.id, { state: 'parked' });
        return;
      }
      if (previous?.state === 'grace' && previous.deadline !== undefined) {
        this.startGrace(r, previous.deadline);
        return;
      }
      // Never pushed: this record carries the episode's one push.
    }
    if (r.kind === 'terminal_prompt' && this.graceMs > 0) {
      this.startGrace(r, this.now() + this.graceMs);
      return;
    }
    this.push(r);
  }

  private startGrace(r: ApprovalRequest, deadline: number): void {
    const entry: Tracked = { state: 'grace', deadline, request: r };
    entry.timer = this.setTimerImpl(() => {
      const current = this.state.get(r.id);
      // Resolved, superseded or evicted meanwhile: nothing to push.
      if (current !== entry) return;
      delete entry.timer;
      this.push(entry.request ?? r);
    }, Math.max(0, deadline - this.now()));
    this.remember(r.id, entry);
  }

  private push(r: ApprovalRequest): void {
    const payload = this.deps.build(r);
    const collapseId = this.deps.collapseId(r);
    if (this.deps.suppress(payload)) {
      // The approval id only — never the question, the choices, or anything
      // else the payload carries.
      this.deps.log?.('info', `[push] held for ${r.id}: desktop is present`);
      this.deps.park(r.id, payload, collapseId);
      this.remember(r.id, { state: 'parked' });
      return;
    }
    this.deps.send(payload, { collapseId });
    this.outstanding.delete(collapseId);
    this.remember(r.id, { state: 'sent' });
  }

  /**
   * Replace a banner that is still on the phone for a record that just ended.
   *
   * Not when the record was answered through `press` — that answer came from a
   * remote client, which is where the banner was, and tapping it already took
   * it down.
   */
  private retractIfShown(r: ApprovalRequest, delivered: boolean): void {
    const collapseId = this.deps.collapseId(r);
    const orphaned = this.outstanding.delete(collapseId);
    if (!delivered && !orphaned) return;
    if (r.pressedAt !== undefined) return;
    this.deps.log?.('info', `[push] retracting the push for ${r.id}: ${r.state}`);
    this.deps.send(this.deps.buildRetraction(r), { collapseId });
  }

  private markOutstanding(collapseId: string): void {
    this.outstanding.delete(collapseId);
    this.outstanding.add(collapseId);
    while (this.outstanding.size > MAX_TRACKED) {
      const oldest = this.outstanding.values().next();
      if (oldest.done) break;
      this.outstanding.delete(oldest.value);
    }
  }

  private remember(id: string, value: Tracked): void {
    const previous = this.state.get(id);
    if (previous !== undefined && previous !== value && previous.timer !== undefined) {
      this.clearTimerImpl(previous.timer);
    }
    this.state.delete(id);
    this.state.set(id, value);
    while (this.state.size > MAX_TRACKED) {
      const oldest = this.state.entries().next();
      if (oldest.done) break;
      const [oldId, entry] = oldest.value;
      if (entry.timer !== undefined) this.clearTimerImpl(entry.timer);
      this.state.delete(oldId);
    }
  }
}
