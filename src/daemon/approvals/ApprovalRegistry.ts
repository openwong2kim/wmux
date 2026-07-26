// M2 — ApprovalRegistry: the daemon is the process of record for approvals.
//
// M1 made the daemon the hook authority: with the GUI closed a Claude Code
// `AskUserQuestion` PreToolUse still lands here as an `agent.awaiting_input`
// with the full envelope. This module turns that signal into a REQUEST a human
// can answer from somewhere that is not the desktop, and owns the one dangerous
// step that follows — putting a keystroke into somebody's terminal.
//
// ASCII flow:
//
//   Claude Code AskUserQuestion (PreToolUse)
//      │  wmux-bridge.mjs → daemon.hooks.signal
//      ▼
//   HookIngest.handle → decision 'emit', source 'hook'
//      │  noteHookAwaitingInput(...)          [dedup'd signals never get here]
//      ▼
//   ApprovalRegistry   ── create ──▶ approvals.json + 'create' event
//      ▲                                          │
//      │ resolve({id, decision, resolvedBy})      ▼
//   daemon.approvals.resolve / POST /api/approvals/:id     SSE 'approval'
//      │
//      ├─ CAS on (id, state==='pending')  ──▶ 'already-resolved' for the loser
//      ├─ keystroke map (claude only)     ──▶ 'unsupported-agent'
//      ├─ re-read the pane's screen       ──▶ 'prompt-gone' (and EXPIRE it)
//      └─ ONE keystroke into the PTY      ──▶ state 'resolved'
//
// Three rules carry all the safety:
//
//  1. HOOK-ONLY CREATION. A request exists only for `source:'hook'` +
//     `agent.awaiting_input` + `decision:'emit'`. Detector (regex) awaiting_input
//     creates nothing — that is the CommanderEventCoalescer bar (a regex match
//     is a suspicion, and this surface writes bytes), enforced here rather than
//     described in a prompt.
//  2. ONE MUTATION CHAIN. Every state change funnels through `this.chain`, so a
//     read-modify-write can never interleave with another one across the awaits
//     in resolve() (the screen re-read is seconds long). This is the
//     deckDecisionStore lesson: two concurrent resolvers both reading 'pending'
//     is how a human's answer gets lost, and it is a race you cannot test your
//     way out of after the fact.
//  3. NEVER BLIND BYTES. The state says 'pending', but the state is a memory of
//     something that was true when the hook fired. Before writing we re-read the
//     actual screen and refuse unless the thing the keystroke acts on is still
//     visible (see looksLikeApprovalPrompt — biased to refuse).

import crypto from 'node:crypto';
import { hasCriticalRisk } from '../../shared/criticalPatterns';
import { keystrokesForAgent, looksLikeApprovalPrompt } from './approvalKeystrokes';
import {
  formatScreenTail,
  loadApprovalState,
  saveApprovalState,
  sanitizeResolvedBy,
  trimHistory,
  type ApprovalPersistedState,
} from './approvalStore';
import type {
  ApprovalEvent,
  ApprovalEventType,
  ApprovalExpiryReason,
  ApprovalHookSink,
  ApprovalListResult,
  ApprovalRegistryApi,
  ApprovalRequest,
  ApprovalResolveParams,
  ApprovalResolveResult,
} from './types';

/**
 * Copy a record for handing OUT (list results, event payloads). A spread alone
 * is not enough now that `options` is an array: a shallow copy would share it,
 * and a consumer that sorted or pushed to the options it got from `list()`
 * would be editing registry state through the back door.
 */
function copyRequest(r: ApprovalRequest): ApprovalRequest {
  return { ...r, ...(r.options ? { options: [...r.options] } : {}) };
}

export interface ApprovalRegistryDeps {
  /** Suffix-aware wmux data dir — where approvals.json lives. */
  wmuxDir: string;
  /**
   * Plain-text rows of a session's VISIBLE grid, newest last, or null when the
   * session is gone / could not be read. The daemon backs this with the same
   * headless-terminal parse `daemon.readSessionText` uses: the ring buffer is
   * raw PTY bytes and a TUI redraws in place, so stripping ANSI off the ring
   * would describe a screen that never existed. `null` is treated as "no
   * evidence" and refuses the resolve.
   */
  readScreenTail: (sessionId: string) => Promise<string[] | null>;
  /**
   * Write bytes to a live session's PTY. Returns false when the session is gone
   * or the write failed — the registry then refuses rather than claiming a
   * delivery it did not make.
   */
  writeToSession: (sessionId: string, data: string) => boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for test determinism. */
  now?: () => number;
  /** Injected for test determinism. */
  newId?: () => string;
}

export class ApprovalRegistry implements ApprovalRegistryApi, ApprovalHookSink {
  private readonly deps: ApprovalRegistryDeps;
  private readonly now: () => number;
  private readonly newId: () => string;
  private requests: ApprovalRequest[];
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();
  /**
   * The single mutation chain. Every mutator appends to it, so mutations run
   * one at a time in call order even though each one awaits I/O. Kept alive
   * across a rejection so one failure can never wedge every later mutation.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: ApprovalRegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());

    // Load + INVALIDATE. Every pending request that survived to disk is stale
    // by definition: we only get here on a daemon start, the panes are being
    // recovered around us, and a recovered session is a brand-new PTY with a
    // brand-new agent process. Pressing a remembered approval into it would
    // deliver a keystroke to a program that never asked the question. So the
    // recovery rule is unconditional — expire them all, keep them as history.
    //
    // Keep it unconditional. A "the PTY survived, keep the pending" optimisation
    // would look harmless and would quietly remove the guarantee two other things
    // lean on: that a create lost to a crash before its write landed is harmless
    // (the survivor set is emptied anyway), and that no remembered keystroke can
    // ever reach a process that did not ask the question.
    const loaded = loadApprovalState(deps.wmuxDir);
    let invalidated = 0;
    this.requests = trimHistory(
      loaded.requests.map((r) => {
        if (r.state !== 'pending') return r;
        invalidated++;
        return { ...r, state: 'expired' as const, resolvedAt: this.now() };
      }),
    );
    if (invalidated > 0) {
      this.deps.log?.(
        'info',
        `[approvals] invalidated ${invalidated} pending request(s) — a restarted daemon has new PTYs`,
      );
      // No 'expire' events: construction happens before anything can subscribe,
      // and a phone reconnecting fetches the list anyway. Pushed onto the chain
      // rather than fired directly so it cannot race the first real mutation's
      // write over the same file.
      this.chain = this.chain.then(() => this.persist()).catch(() => undefined);
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  list(): ApprovalListResult {
    const pending: ApprovalRequest[] = [];
    const terminal: ApprovalRequest[] = [];
    for (const r of this.requests) {
      (r.state === 'pending' ? pending : terminal).push(copyRequest(r));
    }
    pending.sort((a, b) => a.createdAt - b.createdAt);
    terminal.sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));
    return { pending, recentlyResolved: terminal };
  }

  onEvent(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Hook-sourced lifecycle (called by HookIngest) ─────────────────────────

  /**
   * A hook said this pane is waiting on a human. Fire-and-forget by contract:
   * the caller is on the hook bridge's 2 s budget and must not wait for our
   * disk write. Enqueued on the mutation chain, so it is still strictly
   * ordered against every resolve/expire.
   *
   * One pending request per session: an existing one is SUPERSEDED rather than
   * left beside the new one. A second question on the same pane means the first
   * is no longer what is on screen, and two pending records for one pane would
   * let a phone answer the wrong one.
   *
   * Returns the settled promise ONLY so tests and the dynamic harness can wait
   * for the disk write; `ApprovalHookSink` types it as `void` because no
   * production caller may depend on it (the hook path must not block).
   */
  noteHookAwaitingInput(input: {
    sessionId: string;
    agent: string;
    workspaceId?: string;
    question?: string;
    options?: string[];
  }): Promise<void> {
    // Snapshot BEFORE queuing. `mutate` runs the body after the chain drains,
    // which can be seconds later (a resolve ahead of it is holding the chain
    // through a screen re-read), and the body closed over the caller's object —
    // so a caller that reused or mutated it in the meantime could have this
    // record persisted against the wrong pane or question. Nothing does that
    // today; the contract should not depend on that staying true.
    const snapshot = {
      sessionId: input.sessionId,
      agent: input.agent,
      workspaceId: input.workspaceId,
      question: input.question,
      options: input.options ? [...input.options] : undefined,
    };
    return this.mutate(() => {
      const superseded = this.requests.find(
        (r) => r.state === 'pending' && r.sessionId === snapshot.sessionId,
      );
      const events: ApprovalEvent[] = [];
      if (superseded) {
        superseded.state = 'superseded';
        superseded.resolvedAt = this.now();
        events.push({ type: 'supersede', request: copyRequest(superseded) });
      }
      const created: ApprovalRequest = {
        id: this.newId(),
        sessionId: snapshot.sessionId,
        ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
        agent: snapshot.agent,
        kind: 'awaiting_input',
        // A4 — the question the operator is being asked to answer. Absent when
        // the envelope carried no usable shape; never a reason to skip the
        // request.
        ...(snapshot.question ? { question: snapshot.question } : {}),
        ...(snapshot.options && snapshot.options.length > 0 ? { options: [...snapshot.options] } : {}),
        // Danger HINT for UI step-up, computed once at creation from the same
        // pattern list the PTY critical-action scanner uses. A miss or a false
        // positive changes nothing about whether this request can be answered.
        ...(hasCriticalRisk(snapshot.question, ...(snapshot.options ?? []))
          ? { risk: 'critical' as const }
          : {}),
        createdAt: this.now(),
        state: 'pending',
      };
      this.requests.push(created);
      events.push({ type: 'create', request: copyRequest(created) });
      return events;
    });
  }

  /**
   * The turn this pane was blocked on is over (hook `agent.stop`), the pane
   * started a fresh session (`agent.session_start`), or the pane is gone. Any
   * pending request on it is answered-or-abandoned either way — nobody is
   * waiting on that keystroke anymore.
   *
   * `agent.subagent_stop` deliberately does NOT expire: a subagent finishing
   * says nothing about the main agent's question still sitting on screen.
   *
   * Returns the settled promise for the same reason noteHookAwaitingInput does.
   */
  expireForSession(sessionId: string, reason: ApprovalExpiryReason): Promise<void> {
    return this.mutate(() => this.expirePendingWhere((r) => r.sessionId === sessionId, reason));
  }

  // ── Resolution ───────────────────────────────────────────────────────────

  async resolve(params: ApprovalResolveParams): Promise<ApprovalResolveResult> {
    // The WHOLE decision runs inside one link of the chain — CAS, screen
    // re-read, PTY write and the state flip. A concurrent resolver waits for
    // this to finish and then reads a state that is no longer 'pending', which
    // is exactly the 409 the second phone should get.
    return this.mutate(async () => {
      const record = this.requests.find((r) => r.id === params.id);
      if (!record) return { result: { ok: false, reason: 'not-found' } as ApprovalResolveResult };

      // CAS on (id, state === 'pending').
      if (record.state !== 'pending') {
        const reason = record.state === 'resolved' ? 'already-resolved' : 'expired';
        return {
          result: {
            ok: false,
            reason,
            ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
            request: copyRequest(record),
          } as ApprovalResolveResult,
        };
      }

      const keys = keystrokesForAgent(record.agent);
      if (!keys) {
        // NOT an expiry: the request is still live and a human at the desktop
        // can still answer it. We simply have no mapping we would trust.
        return {
          result: {
            ok: false,
            reason: 'unsupported-agent',
            request: copyRequest(record),
          } as ApprovalResolveResult,
        };
      }

      const rows = await this.safeReadScreen(record.sessionId);
      if (!rows || rows.length === 0 || !looksLikeApprovalPrompt(rows)) {
        // Refusal expires the request: whatever the pane is showing now, it is
        // not the prompt this record was minted for, so leaving it pending would
        // just invite the same refusal on the next tap.
        record.state = 'expired';
        record.resolvedAt = this.now();
        if (rows && rows.length > 0) record.screenTail = formatScreenTail(rows);
        this.deps.log?.(
          'info',
          `[approvals] refused ${record.id} on ${record.sessionId}: no answerable prompt on screen`,
        );
        return {
          events: [{ type: 'expire' as ApprovalEventType, request: copyRequest(record) }],
          result: { ok: false, reason: 'prompt-gone', request: copyRequest(record) } as ApprovalResolveResult,
        };
      }

      const data = params.decision === 'approve' ? keys.approve : keys.deny;
      let delivered = false;
      try {
        delivered = this.deps.writeToSession(record.sessionId, data);
      } catch (err) {
        this.deps.log?.(
          'warn',
          `[approvals] write failed for ${record.sessionId}: ${String(err)}`,
        );
      }
      if (!delivered) {
        // The pane died between the screen read and the write. Same answer as a
        // vanished prompt — there is nothing to press.
        record.state = 'expired';
        record.resolvedAt = this.now();
        record.screenTail = formatScreenTail(rows);
        return {
          events: [{ type: 'expire' as ApprovalEventType, request: copyRequest(record) }],
          result: { ok: false, reason: 'prompt-gone', request: copyRequest(record) } as ApprovalResolveResult,
        };
      }

      // Bytes are out. The flip is last so a failed write never consumes the
      // request, and it is safe to be last because nothing else can run between
      // the two: we hold the chain.
      record.state = 'resolved';
      record.decision = params.decision;
      // Sanitized at the chokepoint, not at the caller — see sanitizeResolvedBy.
      record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
      record.resolvedAt = this.now();
      record.screenTail = formatScreenTail(rows);
      this.deps.log?.(
        'info',
        // The SANITIZED value, not the raw param. Sanitizing only what gets
        // stored left the log line taking a CR/LF straight from the caller,
        // which is the forged-log-line injection sanitizeResolvedBy exists to
        // prevent — the field was clean on disk and dirty in the log.
        `[approvals] ${params.decision} ${record.id} on ${record.sessionId} by ${record.resolvedBy || 'unknown'}`,
      );
      return {
        events: [{ type: 'resolve' as ApprovalEventType, request: copyRequest(record) }],
        // `durable` is stamped by the finalize below; the body cannot know it.
        result: { ok: true, request: copyRequest(record), durable: true } as ApprovalResolveResult,
      };
    },
    // The bytes are in the PTY either way, so a failed write does not fail the
    // call — it changes what we can honestly claim about it.
    (result, durable) => (result.ok ? { ...result, durable } : result));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Run one mutation with exclusive access to `this.requests`, then persist and
   * fan out its events. Every mutator goes through here; nothing mutates
   * `this.requests` outside a `mutate` body.
   */
  private mutate<R = void>(
    body: () => ApprovalEvent[] | { events?: ApprovalEvent[]; result: R } | Promise<
      ApprovalEvent[] | { events?: ApprovalEvent[]; result: R }
    >,
    /**
     * Last look at the result, once the write outcome is known. The body cannot
     * know it — the persist happens after the body returns — so a caller that
     * needs to report durability folds it in here.
     */
    finalize?: (result: R, durable: boolean) => R,
  ): Promise<R> {
    const run = this.chain.then(async () => {
      const out = await body();
      const events = Array.isArray(out) ? out : (out.events ?? []);
      const result = Array.isArray(out) ? (undefined as unknown as R) : out.result;
      // No events means nothing changed, so nothing had to be written.
      let durable = true;
      if (events.length > 0) {
        this.requests = trimHistory(this.requests);
        durable = await this.persist();
        for (const event of events) this.emit(event);
      }
      return finalize ? finalize(result, durable) : result;
    });
    // Keep the chain alive across a rejection (deckDecisionStore does the same):
    // one throwing mutation must not wedge every later one.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Flip every pending record matching `match`. Returns the events to fan out. */
  private expirePendingWhere(
    match: (r: ApprovalRequest) => boolean,
    reason: ApprovalExpiryReason,
  ): ApprovalEvent[] {
    const events: ApprovalEvent[] = [];
    for (const r of this.requests) {
      if (r.state !== 'pending' || !match(r)) continue;
      r.state = 'expired';
      r.resolvedAt = this.now();
      events.push({ type: 'expire', request: copyRequest(r) });
    }
    if (events.length > 0) {
      this.deps.log?.(
        'info',
        `[approvals] expired ${events.length} pending request(s) (${reason})`,
      );
    }
    return events;
  }

  private async safeReadScreen(sessionId: string): Promise<string[] | null> {
    try {
      return await this.deps.readScreenTail(sessionId);
    } catch (err) {
      // An unreadable screen is not evidence of a prompt — refuse.
      this.deps.log?.('warn', `[approvals] screen read failed for ${sessionId}: ${String(err)}`);
      return null;
    }
  }

  /** True when the write landed. Callers decide what a false means. */
  private async persist(): Promise<boolean> {
    const state: ApprovalPersistedState = { version: 1, requests: this.requests };
    const ok = await saveApprovalState(this.deps.wmuxDir, state);
    if (!ok) {
      this.deps.log?.('warn', '[approvals] could not persist approvals.json');
    }
    return ok;
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A broken subscriber (a dead SSE response) must never take down the
        // mutation that produced the event.
        this.deps.log?.('warn', `[approvals] listener threw: ${String(err)}`);
      }
    }
  }
}

export { RESOLVED_BY_MAX, sanitizeResolvedBy } from './approvalStore';
