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
 *   - it never went out at all → the new record is pushed normally.
 */
import type { PushPayload } from '../../shared/push/pushEnvelope';
import type { ApprovalEvent, ApprovalRequest } from '../approvals/types';

export interface ApprovalPushRouterDeps {
  build(request: ApprovalRequest): PushPayload;
  collapseId(request: ApprovalRequest): string;
  /** True when the push should be held (desktop present). */
  suppress(payload: PushPayload): boolean;
  send(payload: PushPayload, opts: { collapseId: string }): void;
  park(approvalId: string, payload: PushPayload, collapseId: string): void;
  forget(approvalId: string): void;
  /** Is this approval's push still parked (not yet released)? */
  isParked(approvalId: string): boolean;
  log?: (level: 'info' | 'warn', message: string) => void;
}

type PushState = 'sent' | 'parked';

/** Records whose push state is remembered at most — a bound, not a policy. */
const MAX_TRACKED = 512;

export class ApprovalPushRouter {
  private readonly state = new Map<string, PushState>();

  constructor(private readonly deps: ApprovalPushRouterDeps) {}

  onEvent(event: ApprovalEvent): void {
    const r = event.request;
    if (event.type !== 'create') {
      // Remember whether a superseded record's push is still parked, for a
      // `create` that may replace it next; the push itself is moot either way.
      const parked = this.deps.isParked(r.id);
      this.deps.forget(r.id);
      if (event.type === 'supersede') {
        const known = this.state.get(r.id);
        if (known !== undefined) this.remember(r.id, parked ? 'parked' : 'sent');
      } else if (event.type !== 'press') {
        this.state.delete(r.id);
      }
      return;
    }
    if (event.replaces !== undefined) {
      const previous = this.state.get(event.replaces);
      this.state.delete(event.replaces);
      if (previous === 'sent') {
        this.remember(r.id, 'sent');
        return;
      }
      if (previous === 'parked') {
        const payload = this.deps.build(r);
        this.deps.park(r.id, payload, this.deps.collapseId(r));
        this.remember(r.id, 'parked');
        return;
      }
      // Never pushed: this record carries the episode's one push.
    }
    this.push(r);
  }

  private push(r: ApprovalRequest): void {
    const payload = this.deps.build(r);
    const collapseId = this.deps.collapseId(r);
    if (this.deps.suppress(payload)) {
      // The approval id only — never the question, the choices, or anything
      // else the payload carries.
      this.deps.log?.('info', `[push] held for ${r.id}: desktop is present`);
      this.deps.park(r.id, payload, collapseId);
      this.remember(r.id, 'parked');
      return;
    }
    this.deps.send(payload, { collapseId });
    this.remember(r.id, 'sent');
  }

  private remember(id: string, value: PushState): void {
    this.state.delete(id);
    this.state.set(id, value);
    while (this.state.size > MAX_TRACKED) {
      const oldest = this.state.keys().next();
      if (oldest.done) break;
      this.state.delete(oldest.value);
    }
  }
}
