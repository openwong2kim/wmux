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
import {
  decideApprovalPress,
  keystrokesForAgent,
  looksLikeApprovalPrompt,
  looksLikeChoiceOnScreen,
  type ApprovalPressFacts,
} from './approvalKeystrokes';
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
  return {
    ...r,
    ...(r.options ? { options: [...r.options] } : {}),
    ...(r.choices ? { choices: r.choices.map((c) => ({ ...c })) } : {}),
  };
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
  /**
   * The workspace-shaped half of the press scope (see `decideApprovalPress`):
   * is this workspace a WorkTask task workspace, and what is its deck autonomy
   * mode. Both facts live in the MAIN process, so the daemon can only be told
   * them (see approvals/workspaceFacts.ts).
   *
   * Three answers, and they are NOT the same refusal. `undefined` (the dep is
   * absent) and `null` (wired, but main has never published) both mean the
   * source of truth is unreachable — reported as `scope-unavailable`, which is
   * the one that says "the integration is missing", not "policy said no". An
   * OBJECT is an answer from main, and `{}` inside it is main declining to
   * classify this workspace, which refuses as `workspace-unknown`. Every branch
   * refuses; what differs is what an operator is told to go and fix.
   */
  pressScope?: (workspaceId: string) => Pick<ApprovalPressFacts, 'isTaskWorkspace' | 'autonomyMode'> | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Injected for test determinism. */
  now?: () => number;
  /** Injected for test determinism. */
  newId?: () => string;
  /**
   * #783 — wake the GateBroker waiter when a `kind:'awaiting_permission'`
   * record is resolved. The broker holds the bridge RPC response open; this
   * call is what closes it. Optional: tests that don't exercise the gate path
   * leave it absent, and a gate resolve without a broker is a no-op for the
   * waiter (the record still flips to 'resolved' for /api/approvals).
   */
  notifyGateResolved?: (gateId: string, decision: 'approve' | 'deny') => void;
  /**
   * #783 — cancel the GateBroker waiter when a gate record is expired or
   * superseded (turn ended, session died, newer gate superseded this one, etc).
   * The waiter would otherwise hang until its own deadline; this tells it to
   * defer immediately so the bridge falls back to the local permission flow.
   */
  notifyGateDropped?: (gateId: string) => void;
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

  /** Count only — skips the copy+sort `list()` does for callers that just need a number. */
  pendingCount(): number {
    let count = 0;
    for (const r of this.requests) if (r.state === 'pending') count++;
    return count;
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
    choices?: Array<{ key: string; label: string }>;
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
      choices: input.choices ? input.choices.map((c) => ({ ...c })) : undefined,
    };
    return this.mutate(() => {
      const superseded = this.requests.find(
        (r) => r.state === 'pending' && r.sessionId === snapshot.sessionId,
      );
      const events: ApprovalEvent[] = [];
      if (superseded) {
        superseded.state = 'superseded';
        superseded.resolvedAt = this.now();
        if (superseded.kind === 'awaiting_permission') {
          this.deps.notifyGateDropped?.(superseded.id);
        }
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
        ...(snapshot.choices && snapshot.choices.length > 0 ? { choices: snapshot.choices.map((c) => ({ ...c })) } : {}),
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
   * #783 — create a pending permission-gate record. Same supersede rule as
   * `noteHookAwaitingInput`: one pending record per session, so a new gate
   * supersedes an existing one (the old tool call is moot once a new one is
   * pending). Returns the id SYNCHRONOUSLY so the caller can register the
   * GateBroker waiter before the mutation even reaches disk.
   */
  noteGateAwaiting(input: {
    sessionId: string;
    agent: string;
    workspaceId?: string;
    toolName: string;
    toolInputSummary?: string;
  }): string {
    const id = this.newId();
    const snapshot = {
      id,
      sessionId: input.sessionId,
      agent: input.agent,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      toolInputSummary: input.toolInputSummary,
    };
    this.mutate(() => {
      // One-pending-per-session holds for SCREEN-backed prompts: a pane shows
      // one question at a time, so a newer one replaced the older. Gates are
      // different — the agent can call several gated tools in one turn, and
      // each blocks its own bridge process. Superseding one would silently drop
      // that tool to the local prompt while the phone operator, watching only
      // the phone, sees nothing (review: Claude). So a gate never supersedes
      // another gate; it only replaces a screen-backed prompt.
      const superseded = this.requests.find(
        (r) => r.state === 'pending'
          && r.sessionId === snapshot.sessionId
          && r.kind !== 'awaiting_permission',
      );
      const events: ApprovalEvent[] = [];
      if (superseded) {
        superseded.state = 'superseded';
        superseded.resolvedAt = this.now();
        events.push({ type: 'supersede', request: copyRequest(superseded) });
      }
      const created: ApprovalRequest = {
        id: snapshot.id,
        sessionId: snapshot.sessionId,
        ...(snapshot.workspaceId ? { workspaceId: snapshot.workspaceId } : {}),
        agent: snapshot.agent,
        kind: 'awaiting_permission',
        toolName: snapshot.toolName,
        ...(snapshot.toolInputSummary ? { toolInputSummary: snapshot.toolInputSummary } : {}),
        createdAt: this.now(),
        // No `deadlineAt` here on purpose. The record is created BEFORE the
        // broker arms its timer, and that timer runs for min(the bridge's own
        // remaining budget, the cap) — so a deadline invented here would be a
        // countdown to a moment nothing happens at. The broker reports the real
        // one through `noteGateDeadline`.
        state: 'pending',
      };
      this.requests.push(created);
      events.push({ type: 'create', request: copyRequest(created) });
      return events;
    });
    return id;
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
   * `kind` narrows the sweep to one record kind. A locally answered
   * AskUserQuestion says nothing about a permission gate the same turn opened
   * in parallel, and expiring one drops its waiter (see expirePendingWhere) —
   * the tool falls back to the local prompt while the phone operator, watching
   * only the phone, sees the card vanish. That is the exact harm the supersede
   * rule in noteHookAwaitingInput already refuses to cause; the sweep has to
   * refuse it too. Omitted ⇒ every kind, which is what the turn/pane-lifecycle
   * callers want.
   *
   * Returns the settled promise for the same reason noteHookAwaitingInput does.
   */
  expireForSession(
    sessionId: string,
    reason: ApprovalExpiryReason,
    kind?: ApprovalRequest['kind'],
  ): Promise<void> {
    return this.mutate(() => this.expirePendingWhere(
      (r) => r.sessionId === sessionId && (kind === undefined || r.kind === kind),
      reason,
    ));
  }

  /**
   * Expire ONE record by id. The gate broker calls this when it defers a gate
   * (#783): the tool has already fallen through to the local prompt, so the
   * card must stop being answerable — otherwise a late tap gets a success
   * receipt for a decision that changed nothing. Runs through the same
   * serialized CAS, so a phone answer that already won finds nothing pending.
   */
  expireById(id: string, reason: ApprovalExpiryReason): Promise<void> {
    return this.mutate(() => this.expirePendingWhere((r) => r.id === id, reason));
  }

  /**
   * Stamp the deadline the GateBroker ACTUALLY armed onto a gate record, so a
   * surface can count down to the moment the tool really gives up rather than
   * to an invented one (see `ApprovalRequest.deadlineAt`).
   *
   * Goes through `mutate` for ORDERING, not for durability: `noteGateAwaiting`
   * queues the record's creation on the same chain, so a deadline reported in
   * the very next statement would otherwise land before the record exists. It
   * returns no events on purpose — this is an advisory annotation on a record
   * whose creation was already persisted, and the broker's timer does not
   * survive a restart either, so a re-write to disk would buy nothing.
   *
   * A no-op for an unknown or already-settled id.
   */
  noteGateDeadline(id: string, deadlineAt: number): Promise<void> {
    return this.mutate(() => {
      const record = this.requests.find((r) => r.id === id && r.state === 'pending');
      if (record) record.deadlineAt = deadlineAt;
      return [];
    });
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

      // #783 — gate records resolve through the GateBroker, not the PTY. There
      // is no screen to re-read (the gate blocks inside the bridge process, not
      // on the pane's TUI) and no keystroke to send. The CAS above already
      // guarantees first-write-wins; notifyGateResolved wakes the waiter and
      // the bridge returns the verdict to Claude Code.
      if (record.kind === 'awaiting_permission') {
        // choiceKey is meaningless for a gate — there are no on-screen options.
        if (params.choiceKey !== undefined) {
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        record.state = 'resolved';
        record.decision = params.decision;
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        record.resolvedAt = this.now();
        this.deps.notifyGateResolved?.(record.id, params.decision);
        this.deps.log?.(
          'info',
          `[approvals] gate ${params.decision} ${record.id} on ${record.sessionId} by ${record.resolvedBy || 'unknown'}`,
        );
        return {
          events: [{ type: 'resolve' as ApprovalEventType, request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true } as ApprovalResolveResult,
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

      // ── choiceKey validation ──────────────────────────────────────────────
      // When present, the caller is selecting a specific option rather than the
      // default first-option mapping. Validate that the key belongs to this
      // request's stored choices — fail closed on any mismatch.
      let choiceDigit: string | null = null;
      let choiceLabel: string | null = null;
      if (params.choiceKey !== undefined) {
        // Only an affirmative can select an option. Empty is malformed rather
        // than "absent": silently defaulting it would press option 1.
        if (params.decision !== 'approve' || params.choiceKey === '') {
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        if (!record.choices || record.choices.length === 0) {
          // choiceKey sent for a request that has no choices — invalid.
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        const match = record.choices.find((c) => c.key === params.choiceKey);
        if (!match) {
          // choiceKey not in the stored set — fail closed.
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
        choiceDigit = match.key;
        choiceLabel = match.label;
      }

      const rows = await this.safeReadScreen(record.sessionId);

      // ── Press scope ───────────────────────────────────────────────────────
      // "Can these bytes be pressed" and "may this pane be pressed at all" are
      // different questions. `decideApprovalPress` answers the second — for an
      // AUTOMATED approve only.
      //
      // A human answering from the phone or the web is looking at the prompt;
      // gating them behind a workspace classification would just be a broken
      // button, and a refused DENY (from anyone) would keep a pane blocked in
      // the name of safety. Both bypass, inside the decision, so the reasoning
      // lives in one place. `resolver` therefore defaults to 'human': every
      // caller that exists today is a person tapping, and an automated presser
      // has to say so — at which point it faces the full check.
      //
      // For that automated caller the check FAILS CLOSED: a pane whose
      // workspace we cannot classify, or whose autonomy setting we cannot read,
      // is refused rather than assumed delegated. Those facts live in main;
      // `pressScope` is the seam that supplies them, and its ABSENCE reports
      // `scope-unavailable` — distinct from a workspace that answered "no", so
      // the missing integration wiring is visible instead of looking like
      // policy.
      // Three distinct ways to have no scope, and an operator fixes each one
      // differently: no feed wired at all, a feed that has never published, and
      // a RECORD with no workspace to ask about (a hook envelope that carried
      // none). Collapsing them sent people to look at the integration wiring
      // for a problem in the hook payload.
      type NoScopeCause = 'unwired' | 'unpublished' | 'record-has-no-workspace';
      const noScopeCause: NoScopeCause | null = !this.deps.pressScope
        ? 'unwired'
        : !record.workspaceId
          ? 'record-has-no-workspace'
          : null;
      const published =
        noScopeCause === null && this.deps.pressScope
          ? this.deps.pressScope(record.workspaceId as string)
          : null;
      // Wired AND answering. A wired feed that has never been published is as
      // unavailable as no feed at all — see the ApprovalRegistryDeps note.
      const scopeAvailable = published !== null;
      const scope = published ?? {};
      const pressDecision = decideApprovalPress({
        resolver: params.resolver ?? 'human',
        decision: params.decision,
        scopeAvailable,
        ...scope,
        // Only hook-sourced requests are ever created (see the header), so the
        // record's own existence is the origin evidence.
        origin: 'hook',
        stillOnScreen: !!rows && rows.length > 0 && looksLikeApprovalPrompt(rows),
      });
      if (!pressDecision.press && pressDecision.reason !== 'prompt-gone') {
        // NOT an expiry: the request is live and a human at the desktop can
        // still answer it. We simply may not press on their behalf.
        const SCOPE_CAUSE_DETAIL: Record<NoScopeCause, string> = {
          unwired: 'ApprovalRegistryDeps.pressScope is not wired',
          unpublished: 'the main process has not published its workspace fact table yet',
          'record-has-no-workspace': 'this request carries no workspaceId, so there is nothing to classify',
        };
        const cause = noScopeCause ?? (scopeAvailable ? null : 'unpublished');
        this.deps.log?.(
          pressDecision.reason === 'scope-unavailable' ? 'warn' : 'info',
          pressDecision.reason === 'scope-unavailable'
            ? `[approvals] refused ${record.id} on ${record.sessionId}: automated press has no ` +
              `workspace scope source (${SCOPE_CAUSE_DETAIL[cause ?? 'unwired']}) — ` +
              'a human can still answer this request'
            : `[approvals] refused ${record.id} on ${record.sessionId}: out of press scope (${pressDecision.reason})`,
        );
        return {
          result: {
            ok: false,
            reason: 'out-of-scope',
            // The condition that actually refused. 'out-of-scope' is one
            // bucket in the closed wire vocabulary the web layer maps to
            // status codes; a relay that has to turn the refusal into a hint —
            // or decide whether the operator's policy said no, as opposed to
            // the daemon not knowing — cannot act on a bucket. See
            // ApprovalResolveResult.pressRefusal.
            pressRefusal: pressDecision.reason,
            request: copyRequest(record),
          } as ApprovalResolveResult,
        };
      }

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

      // ── choiceKey screen re-verify ────────────────────────────────────────
      // When resolving with a specific choiceKey, verify that the option row
      // matching that key+label is visible on screen. This prevents stale
      // choices from typing digits into a prompt that has redrawn with different
      // options. The check looks for `<digit>. <label-substring>` or
      // `<digit>) <label-substring>` on a row that also has the selection cursor.
      if (choiceDigit && choiceLabel) {
        if (!looksLikeChoiceOnScreen(rows, choiceDigit, choiceLabel)) {
          // The option is not visible — fail closed without expiring. The prompt
          // may still be valid for a default approve/deny, just not for this
          // specific choice (e.g. a re-render reordered options).
          this.deps.log?.(
            'info',
            `[approvals] refused choiceKey '${choiceDigit}' on ${record.id}: option not visible on screen`,
          );
          return {
            result: {
              ok: false,
              reason: 'invalid-choice-key',
              request: copyRequest(record),
            } as ApprovalResolveResult,
          };
        }
      }

      // Determine the data to send: choiceKey overrides the default mapping.
      // When choiceKey is set, we send exactly that digit — no CR.
      // When absent, existing behaviour: approve → '1', deny → ESC.
      const data = params.decision === 'deny'
        ? keys.deny
        : (choiceDigit ?? keys.approve);
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
      // Persist which specific choice was selected (if any).
      if (choiceDigit) record.selectedChoiceKey = choiceDigit;
      this.deps.log?.(
        'info',
        // The SANITIZED value, not the raw param. Sanitizing only what gets
        // stored left the log line taking a CR/LF straight from the caller,
        // which is the forged-log-line injection sanitizeResolvedBy exists to
        // prevent — the field was clean on disk and dirty in the log.
        `[approvals] ${params.decision} ${record.id} on ${record.sessionId} by ${record.resolvedBy || 'unknown'}${choiceDigit ? ` (choice ${choiceDigit})` : ''}`,
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
      // #783 — cancel the broker waiter so the bridge defers immediately.
      if (r.kind === 'awaiting_permission') {
        this.deps.notifyGateDropped?.(r.id);
      }
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
