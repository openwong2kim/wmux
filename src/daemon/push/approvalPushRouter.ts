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
 * A `press` — a remote answer (phone or desktop pipe), or the one-Esc decline —
 * means the dialog was answered: a push still in its grace is cancelled, a
 * parked one is dropped, and none of them is ever pushed or retracted after.
 *
 * A retraction is sent only while the banner it replaces is still the latest
 * push delivered under that collapse id — a gate or another approval pushed
 * over it since owns the banner now — and it names the approval id that was
 * actually delivered, which a replacement within the episode inherits.
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

/**
 * How long a delivered banner whose record was superseded by a DIFFERENT
 * question waits for the next record in its pane to take it over (push over
 * it, or retract it on ending unpushed) before it retracts itself. Always
 * longer than the grace, so a follow-up that pushes after its grace is never
 * preceded by a retraction of the banner it is about to replace.
 */
export const ORPHAN_RETRACT_MS = 30_000;

export interface ApprovalPushRouterDeps {
  build(request: ApprovalRequest): PushPayload;
  /**
   * The follow-up that replaces a delivered banner once its record is moot.
   * `deliveredApprovalId` is the id of the push actually on the phone.
   */
  buildRetraction(request: ApprovalRequest, deliveredApprovalId: string): PushPayload;
  collapseId(request: ApprovalRequest): string;
  /** True when the push should be held (desktop present). */
  suppress(payload: PushPayload): boolean;
  send(payload: PushPayload, opts: { collapseId: string }): void;
  /** Hold a push; its fate comes back through {@link ApprovalPushRouter.onParkedOutcome}. */
  park(approvalId: string, payload: PushPayload, collapseId: string): void;
  forget(approvalId: string): void;
  log?: (level: 'info' | 'warn', message: string) => void;
  /** Injected for tests; defaults to {@link TERMINAL_PROMPT_PUSH_GRACE_MS}. */
  graceMs?: number;
  /** Injected for tests; defaults to the larger of {@link ORPHAN_RETRACT_MS} and twice the grace. */
  orphanRetractMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The push state of one record.
 *   - grace     waiting out the grace; `request` is the latest record to build from
 *   - parked    held in the park queue under this record's id
 *   - sent      delivered; `deliveredId` is the approval id on the phone
 *   - answered  pressed: never pushed, never retracted
 *   - dropped   the park queue evicted its push unsent: never retracted
 *
 * `superseded` marks an entry kept only for a `create` that may replace it
 * next. Such an entry holds nothing live, so the tracking bound may evict it.
 */
type Tracked =
  | { state: 'grace'; deadline: number; request: ApprovalRequest; timer?: unknown; superseded?: true }
  | { state: 'parked'; superseded?: true }
  | { state: 'sent'; deliveredId: string; superseded?: true }
  | { state: 'answered' }
  | { state: 'dropped' };

interface Orphan {
  /** The approval id of the banner still on the phone. */
  deliveredId: string;
  /** The superseded record that put it there, to build a retraction from. */
  request: ApprovalRequest;
  timer: unknown;
}

/** Records whose push state is remembered at most — a bound, not a policy. */
const MAX_TRACKED = 512;

/** A grace still counting down or a push still in the queue: never evicted. */
function isLive(entry: Tracked): boolean {
  return (entry.state === 'grace' || entry.state === 'parked') && entry.superseded !== true;
}

export class ApprovalPushRouter {
  private readonly state = new Map<string, Tracked>();
  /** Per collapse id, the approval id of the latest push actually delivered. */
  private readonly banners = new Map<string, string>();
  /**
   * Collapse ids whose banner is still on the phone although the record that
   * put it there was superseded by a DIFFERENT question (no `replaces`). The
   * next record in that pane owns the banner: it either pushes over it, or —
   * if it resolves unpushed — retracts it. A gate taking the pane over clears
   * it; with no taker it retracts itself after {@link ORPHAN_RETRACT_MS}.
   */
  private readonly orphans = new Map<string, Orphan>();
  private readonly graceMs: number;
  private readonly orphanRetractMs: number;
  private readonly now: () => number;
  private readonly setTimerImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimerImpl: (handle: unknown) => void;

  constructor(private readonly deps: ApprovalPushRouterDeps) {
    this.graceMs = deps.graceMs ?? TERMINAL_PROMPT_PUSH_GRACE_MS;
    this.orphanRetractMs = deps.orphanRetractMs ?? Math.max(ORPHAN_RETRACT_MS, 2 * this.graceMs);
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
    switch (event.type) {
      case 'create':
        this.onCreate(r, event.replaces);
        return;
      case 'press':
        this.onPress(r);
        return;
      default:
        this.onEnd(event.type, r);
    }
  }

  /**
   * Take over records that were already pending before this router saw their
   * `create` (it subscribed late). A `terminal_prompt` gets its grace re-armed
   * from `createdAt` — pushed at once if that already passed — and any other
   * record is pushed now.
   */
  adopt(requests: readonly ApprovalRequest[]): void {
    for (const r of requests) {
      if (r.state !== 'pending' || this.state.has(r.id)) continue;
      if (r.pressedAt !== undefined) {
        this.remember(r.id, { state: 'answered' });
      } else if (r.kind === 'terminal_prompt' && this.graceMs > 0) {
        this.startGrace(r, r.createdAt + this.graceMs);
      } else {
        this.push(r);
      }
    }
  }

  /** The park queue's report on a held push: handed to the sender, or evicted unsent. */
  onParkedOutcome(approvalId: string, outcome: 'delivered' | 'dropped', collapseId: string | undefined): void {
    const known = this.state.get(approvalId);
    if (outcome === 'delivered') {
      if (collapseId !== undefined) this.noteDelivered(collapseId, approvalId);
      if (known?.state === 'parked') this.remember(approvalId, { state: 'sent', deliveredId: approvalId });
      return;
    }
    if (known?.state === 'parked') this.remember(approvalId, { state: 'dropped' });
  }

  private onCreate(r: ApprovalRequest, replaces: string | undefined): void {
    if (replaces !== undefined) {
      const previous = this.state.get(replaces);
      this.state.delete(replaces);
      if (previous?.state === 'sent') {
        // The banner is this record's now, not an orphan — under the id that
        // was actually delivered.
        this.clearOrphan(this.deps.collapseId(r));
        this.remember(r.id, { state: 'sent', deliveredId: previous.deliveredId });
        return;
      }
      if (previous?.state === 'parked') {
        this.deps.park(r.id, this.deps.build(r), this.deps.collapseId(r));
        this.remember(r.id, { state: 'parked' });
        return;
      }
      if (previous?.state === 'grace') {
        this.startGrace(r, previous.deadline);
        return;
      }
      // Never pushed, or its push was dropped: this record carries the
      // episode's one push.
    }
    if (r.kind === 'terminal_prompt' && this.graceMs > 0) {
      this.startGrace(r, this.now() + this.graceMs);
      return;
    }
    this.push(r);
  }

  /** Answered: whatever is pending for it is cancelled, and nothing is ever retracted. */
  private onPress(r: ApprovalRequest): void {
    this.deps.forget(r.id);
    this.remember(r.id, { state: 'answered' });
  }

  private onEnd(type: 'resolve' | 'expire' | 'supersede', r: ApprovalRequest): void {
    // The push is moot either way.
    this.deps.forget(r.id);
    const known = this.state.get(r.id);
    if (known?.state === 'grace' && known.timer !== undefined) {
      this.clearTimerImpl(known.timer);
      delete known.timer;
    }
    const collapseId = this.deps.collapseId(r);
    if (type === 'supersede') {
      // Kept, holding nothing live, for a `create` that may replace it in the
      // same batch. With none following it simply ages out of the bound.
      if (known === undefined) return;
      if (known.state === 'grace' || known.state === 'parked') {
        this.remember(r.id, { ...known, superseded: true });
      } else if (known.state === 'sent') {
        this.remember(r.id, { ...known, superseded: true });
        // Gate banners are never retracted (see the header), orphaned or not.
        if (r.kind === 'terminal_prompt') this.markOrphan(collapseId, known.deliveredId, r);
      }
      return;
    }
    // resolve / expire: the record is over.
    this.state.delete(r.id);
    if (r.kind !== 'terminal_prompt') return;
    // An answer from a remote client, or a push the queue dropped: nothing of
    // this record's is on the phone to take down. Checked before touching an
    // orphan, which stays to be retracted by its own bound.
    if (known?.state === 'answered' || known?.state === 'dropped' || r.pressedAt !== undefined) return;
    if (known?.state === 'sent') {
      this.retract(r, collapseId, known.deliveredId);
      return;
    }
    const orphan = this.orphans.get(collapseId);
    if (orphan === undefined) return;
    this.clearOrphan(collapseId);
    this.retract(r, collapseId, orphan.deliveredId);
  }

  private startGrace(r: ApprovalRequest, deadline: number): void {
    const entry: Tracked = { state: 'grace', deadline, request: r };
    entry.timer = this.setTimerImpl(() => {
      // Answered, resolved, superseded or replaced meanwhile: nothing to push.
      if (this.state.get(r.id) !== entry) return;
      delete entry.timer;
      if (entry.request.pressedAt !== undefined) {
        this.remember(r.id, { state: 'answered' });
        return;
      }
      this.push(entry.request);
    }, Math.max(0, deadline - this.now()));
    this.remember(r.id, entry);
  }

  private push(r: ApprovalRequest): void {
    const payload = this.deps.build(r);
    const collapseId = this.deps.collapseId(r);
    // A gate takes the pane's banner over, sent or held: an orphan there is
    // not a `terminal_prompt`'s to retract any more.
    if (r.kind !== 'terminal_prompt') this.clearOrphan(collapseId);
    if (this.deps.suppress(payload)) {
      // The approval id only — never the question, the choices, or anything
      // else the payload carries.
      this.deps.log?.('info', `[push] held for ${r.id}: desktop is present`);
      this.deps.park(r.id, payload, collapseId);
      this.remember(r.id, { state: 'parked' });
      return;
    }
    this.deps.send(payload, { collapseId });
    this.noteDelivered(collapseId, r.id);
    this.remember(r.id, { state: 'sent', deliveredId: r.id });
  }

  /**
   * Replace a banner that is still on the phone, named by the approval id it
   * was delivered under — only while it is still the latest push under that
   * collapse id. A gate or another approval pushed over it owns the banner now.
   */
  private retract(r: ApprovalRequest, collapseId: string, deliveredId: string): void {
    if (this.banners.get(collapseId) !== deliveredId) return;
    this.banners.delete(collapseId);
    this.deps.log?.('info', `[push] retracting the push for ${deliveredId}: ${r.state}`);
    this.deps.send(this.deps.buildRetraction(r, deliveredId), { collapseId });
  }

  private noteDelivered(collapseId: string, approvalId: string): void {
    this.clearOrphan(collapseId);
    this.banners.delete(collapseId);
    this.banners.set(collapseId, approvalId);
    while (this.banners.size > MAX_TRACKED) {
      const oldest = this.banners.keys().next();
      if (oldest.done) break;
      this.banners.delete(oldest.value);
    }
  }

  private markOrphan(collapseId: string, deliveredId: string, request: ApprovalRequest): void {
    this.clearOrphan(collapseId);
    // Already replaced on the phone by something newer: not an orphan.
    if (this.banners.get(collapseId) !== deliveredId) return;
    const orphan: Orphan = { deliveredId, request, timer: undefined };
    orphan.timer = this.setTimerImpl(() => {
      if (this.orphans.get(collapseId) !== orphan) return;
      this.orphans.delete(collapseId);
      this.retract(request, collapseId, deliveredId);
    }, this.orphanRetractMs);
    this.orphans.set(collapseId, orphan);
    while (this.orphans.size > MAX_TRACKED) {
      const oldest = this.orphans.keys().next();
      if (oldest.done) break;
      this.clearOrphan(oldest.value);
    }
  }

  private clearOrphan(collapseId: string): void {
    const orphan = this.orphans.get(collapseId);
    if (orphan === undefined) return;
    this.clearTimerImpl(orphan.timer);
    this.orphans.delete(collapseId);
  }

  private remember(id: string, value: Tracked): void {
    const previous = this.state.get(id);
    if (previous !== undefined && previous !== value && previous.state === 'grace' && previous.timer !== undefined) {
      this.clearTimerImpl(previous.timer);
    }
    this.state.delete(id);
    this.state.set(id, value);
    if (this.state.size <= MAX_TRACKED) return;
    // Oldest first, skipping anything still live: evicting a grace or a parked
    // push would lose the push or its retraction. If everything is live the map
    // stays over the bound — it is sized by pending records then, which the
    // registry bounds.
    for (const [oldId, entry] of this.state) {
      if (this.state.size <= MAX_TRACKED) break;
      if (isLive(entry)) continue;
      if (entry.state === 'grace' && entry.timer !== undefined) this.clearTimerImpl(entry.timer);
      this.state.delete(oldId);
    }
  }
}
