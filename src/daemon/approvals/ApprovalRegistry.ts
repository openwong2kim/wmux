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
//
//     ONE EXCEPTION: `kind:'terminal_prompt'`, the agent's own terminal dialog
//     (Claude Code's "Do you want to proceed?"). It is created from the
//     PermissionRequest hook AND from a confirmed detector attention, and it
//     does not need the hook bar, because its ANSWER never trusts its origin:
//     a remote answer is honoured only from a capable web client, only as a
//     plain Yes/No option, and only after the live screen is re-read, re-parsed
//     and found to be the same active dialog (fingerprint), with the pane
//     unchanged between that read and the one-byte write (see
//     resolveTerminalPrompt). A record whose parse was not whole carries no
//     choices and can never be answered; `resolve` refuses it with
//     `answer-in-terminal` and writes nothing.
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
  boundRecordText,
  isClaudeFamilyAgent,
  TERMINAL_PROMPT_COOLDOWN_MS,
  TERMINAL_PROMPT_SUMMARY_MAX,
} from './terminalPrompt';
import {
  decisionForChoiceLabel,
  dialogMatchesToolCall,
  parseTerminalPrompt,
  terminalPromptAnswerability,
  toolFromDialogTitle,
  type ParsedTerminalPrompt,
} from './terminalPromptParse';
import { commandOfToolInput, type PendingToolUse } from '../transcript/pendingToolUse';
import { terminalPromptTextRisk } from '../push/approvalRisk';
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
  ApprovalResolveFailure,
  ApprovalResolveParams,
  ApprovalResolveResult,
  TerminalPromptNote,
} from './types';
import { TERMINAL_PROMPT_WEB_ANSWER } from './types';

/** The pane's state at one instant: output bytes, key-carrying input, the PTY incarnation. */
export interface PromptScreenMark {
  bytes: number;
  keyInputRevision: number;
  incarnation: string | null;
}

/** No remote answer to a `terminal_prompt` this soon after it appeared (reflex / script guard). */
export const TERMINAL_PROMPT_MIN_ANSWER_AGE_MS = 1_500;
/** Renders an answer may take when the pane keeps moving under it. */
export const TERMINAL_PROMPT_ANSWER_ATTEMPTS = 2;
/** Creation-time screen reads (the hook can land before the dialog is drawn), and the gap between them. */
export const TERMINAL_PROMPT_CREATE_READS = 3;
export const TERMINAL_PROMPT_CREATE_READ_GAP_MS = 400;
/**
 * A record created without a whole parse gets this many later looks, this far
 * apart: the PermissionRequest hook can land well before the dialog is drawn,
 * and a first read that missed it must not leave the whole episode
 * unanswerable.
 */
export const TERMINAL_PROMPT_UPGRADE_READS = 2;
export const TERMINAL_PROMPT_UPGRADE_GAP_MS = 1_500;
/** Quiet time after a key/click before an overtaken record is refreshed. */
export const TERMINAL_PROMPT_REFRESH_SETTLE_MS = 600;
/** At most one refresh per record this often: key auto-repeat must not flood SSE. */
export const TERMINAL_PROMPT_REFRESH_MIN_GAP_MS = 2_000;

/** A screen read, parsed: the active dialog and the pane's state at the read. */
interface DialogRead {
  parsed: ParsedTerminalPrompt;
  mark: PromptScreenMark;
}

/** The tool call a dialog is bound to (transcript, or the PermissionRequest hook). */
interface ToolCallBinding {
  /** The transcript `tool_use` id; absent for a hook-only binding without one. */
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A dialog's fingerprint bound to one tool call instance AND to the pane's
 * input epoch (the fence revision it was read at). A key or click since the
 * phone's read therefore always shows up as a different fingerprint: the
 * refreshed record the phone must re-confirm.
 */
function bindFingerprint(screen: string, toolUseId: string | undefined, keyRevision: number | undefined): string {
  return crypto
    .createHash('sha256')
    .update(`${screen}|${toolUseId ?? ''}|${keyRevision ?? ''}`)
    .digest('hex')
    .slice(0, screen.length);
}

/** One line of log-safe text: control characters gone, capped. */
function logText(raw: string | undefined, max = 160): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const flat = (raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

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
  /**
   * Upper bound on one `authorize` call (see ApprovalResolveParams). It runs
   * inside the single mutation link, so a check that never settles would stall
   * every resolve, hook and expiry behind it. Default 2000 ms.
   */
  authorizeTimeoutMs?: number;
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
  /**
   * `terminal_prompt` — the pane's visible grid, with the pane's state
   * captured at the SAME instant the grid was read. Null when the pane is gone
   * or the grid cannot be read at its live geometry. Absent ⇒ records are
   * created without a parse and can never be answered.
   */
  readPromptScreen?: (
    sessionId: string,
  ) => Promise<{ rows: readonly string[]; mark: PromptScreenMark; cols?: number } | null>;
  /**
   * `terminal_prompt` — the latest `tool_use` in the pane's own transcript
   * that has no `tool_result` yet, or null. A record is answerable only when
   * its dialog binds to this call (or to the PermissionRequest hook's input).
   */
  pendingToolUse?: (sessionId: string) => PendingToolUse | null;
  /** `terminal_prompt` — the pane's state right now, read synchronously just before the write. */
  promptScreenMark?: (sessionId: string) => PromptScreenMark | null;
  /** Injected for tests: the wait between creation-time screen reads. */
  promptReadDelay?: (ms: number) => Promise<void>;
  /** Injected for tests: the timer behind the refresh after a key/click. */
  schedule?: (fn: () => void, ms: number) => () => void;
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
  /**
   * Per pane: the dialog the screen check just released, and until when a
   * detector-found `terminal_prompt` for that SAME dialog is not re-created. A
   * different dialog (another fingerprint or tool_use) is not affected, and the
   * PermissionRequest hook path is exempt. In memory only.
   */
  private readonly terminalPromptQuiet = new Map<string, { until: number; dialogKey: string }>();
  /** Panes with a `terminal_prompt` creation (screen read) in flight. */
  private readonly terminalPromptReads = new Set<string>();
  /**
   * Per pane, bumped by every `expireForSession` (pane-gone included — never
   * deleted, so a creation that straddled the pane's death can never match
   * again). A creation whose screen read straddled a sweep is dropped rather
   * than raising a card for a dialog that is already gone.
   */
  private readonly sweepSeq = new Map<string, number>();
  /** Per pane: the pending refresh after a key/click (see noteFenceInput). */
  private readonly refreshTimers = new Map<string, () => void>();

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
        // A terminal_prompt whose answer was already written counts as
        // resolved: the key reached the old PTY.
        return { ...r, state: r.pressedAt !== undefined ? 'resolved' as const : 'expired' as const, resolvedAt: this.now() };
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
   * The agent's own terminal dialog is on this pane (Claude Code's permission
   * prompt — a PermissionRequest hook, or detector attention that survived its
   * confirmation window). Reads the screen, parses the dialog, binds it to the
   * tool call it is for, and records it as `kind:'terminal_prompt'`.
   *
   * ANSWERABLE only when all of it lines up: a whole, active dialog with a
   * plain Yes, bound to the pane's pending tool call — the transcript's latest
   * unanswered `tool_use` (or the PermissionRequest hook's own input) with the
   * same tool and exactly the command the dialog shows. Then the record carries
   * `question`, `reason`, the plain Yes/No `choices` and a `promptFingerprint`
   * that includes the `tool_use` id. Anything else — detector-only with no
   * binding, a command that does not match — is informational for everyone.
   *
   * Created only when nothing is pending on the pane; never supersedes. A
   * detector-found record is also refused for the same dialog the screen check
   * released within the cooldown. Never rejects: failures are logged.
   */
  async noteTerminalPrompt(input: TerminalPromptNote): Promise<void> {
    try {
      await this.noteTerminalPromptInner({ ...input });
    } catch (err) {
      this.deps.log?.('warn', `[approvals] terminal prompt record failed for ${input.sessionId}: ${String(err)}`);
    }
  }

  private async noteTerminalPromptInner(note: TerminalPromptNote): Promise<void> {
    const { sessionId } = note;
    if (!isClaudeFamilyAgent(note.agent)) return;
    if (this.terminalPromptReads.has(sessionId) || this.hasPending(sessionId)) return;
    this.terminalPromptReads.add(sessionId);
    const seq = this.sweepSeq.get(sessionId) ?? 0;
    try {
      const read = await this.readDialogForCreation(sessionId);
      const binding = this.bindingFor(sessionId, note);
      let created: ApprovalRequest | null = null;
      await this.mutate(() => {
        if (this.hasPending(sessionId)) return [];
        if ((this.sweepSeq.get(sessionId) ?? 0) !== seq) return [];
        // The pane must still be alive at the moment the record is minted.
        if (this.deps.promptScreenMark && this.deps.promptScreenMark(sessionId) === null) return [];
        const record = this.buildTerminalPrompt(note, read, binding);
        if (note.source !== 'hook' && this.inCooldown(sessionId, record.dialogKey)) return [];
        this.requests.push(record);
        created = record;
        return [{ type: 'create', request: copyRequest(record) }];
      });
      const record: ApprovalRequest | null = created;
      if (record && !(record as ApprovalRequest).promptFingerprint && this.deps.readPromptScreen) {
        this.upgradeTerminalPromptLater(note, (record as ApprovalRequest).id).catch((err: unknown) => {
          this.deps.log?.('warn', `[approvals] terminal prompt upgrade failed for ${sessionId}: ${String(err)}`);
        });
      }
    } finally {
      this.terminalPromptReads.delete(sessionId);
    }
  }

  /**
   * Look again at a pane whose record was created without an answerable
   * parse: the PermissionRequest hook can land before the dialog is drawn.
   * When it is now answerable, the record is replaced — `create` with
   * `replaces`, so the push carries over rather than firing twice.
   */
  private async upgradeTerminalPromptLater(note: TerminalPromptNote, id: string): Promise<void> {
    const delay = this.deps.promptReadDelay
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    const stillStale = (): ApprovalRequest | undefined => this.requests.find(
      (r) => r.id === id && r.state === 'pending' && !r.promptFingerprint && r.pressedAt === undefined,
    );
    for (let attempt = 0; attempt < TERMINAL_PROMPT_UPGRADE_READS; attempt++) {
      await delay(TERMINAL_PROMPT_UPGRADE_GAP_MS);
      if (!stillStale()) return;
      const read = await this.readActiveDialog(note.sessionId);
      if (!read) continue;
      const fresh = this.buildTerminalPrompt(note, read, this.bindingFor(note.sessionId, note));
      if (!fresh.promptFingerprint) continue;
      await this.mutate(() => {
        const stale = stillStale();
        if (!stale) return [];
        stale.state = 'superseded';
        stale.resolvedAt = this.now();
        fresh.createdAt = this.now();
        this.requests.push(fresh);
        return [
          { type: 'supersede', request: copyRequest(stale) },
          { type: 'create', request: copyRequest(fresh), replaces: stale.id },
        ];
      });
      return;
    }
  }

  /**
   * A key, click, release or wheel reached this pane. A pending answerable
   * `terminal_prompt` it overtook is refreshed once the input settles, so the
   * phone's list is current BEFORE anyone taps: a new record (new id, new
   * fingerprint, the reflex guard restarted) replaces it, provided the same
   * dialog is still up. At most one refresh per record every
   * TERMINAL_PROMPT_REFRESH_MIN_GAP_MS, so key auto-repeat cannot flood SSE.
   * Cheap for every other pane: one scan of the pending records.
   */
  noteFenceInput(sessionId: string): void {
    if (!this.answerablePrompt(sessionId)) return;
    this.scheduleRefresh(sessionId, TERMINAL_PROMPT_REFRESH_SETTLE_MS);
  }

  private answerablePrompt(sessionId: string): ApprovalRequest | undefined {
    return this.requests.find((r) => r.state === 'pending' && r.sessionId === sessionId
      && r.kind === 'terminal_prompt' && !!r.promptFingerprint && r.pressedAt === undefined);
  }

  private scheduleRefresh(sessionId: string, delayMs: number): void {
    this.refreshTimers.get(sessionId)?.();
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });
    this.refreshTimers.set(sessionId, schedule(() => {
      this.refreshTimers.delete(sessionId);
      this.refreshTerminalPrompt(sessionId).catch((err: unknown) => {
        this.deps.log?.('warn', `[approvals] terminal prompt refresh failed for ${sessionId}: ${String(err)}`);
      });
    }, delayMs));
  }

  private async refreshTerminalPrompt(sessionId: string): Promise<void> {
    const record = this.answerablePrompt(sessionId);
    if (!record) return;
    const age = this.now() - record.createdAt;
    if (age < TERMINAL_PROMPT_REFRESH_MIN_GAP_MS) {
      this.scheduleRefresh(sessionId, TERMINAL_PROMPT_REFRESH_MIN_GAP_MS - age);
      return;
    }
    const current = this.deps.promptScreenMark?.(sessionId) ?? null;
    if (!current || current.keyInputRevision === record.keyRevisionAtCreate) return;
    // Only a dialog still up is refreshed; one the input dismissed is left to
    // the answered path and the screen check, as before.
    const live = await this.readActiveDialog(sessionId);
    if (!live) return;
    await this.supersedeWithFresh(record, live);
  }

  private hasPending(sessionId: string): boolean {
    return this.requests.some((r) => r.state === 'pending' && r.sessionId === sessionId);
  }

  private inCooldown(sessionId: string, dialogKey: string | undefined): boolean {
    const quiet = this.terminalPromptQuiet.get(sessionId);
    return !!quiet && this.now() < quiet.until && quiet.dialogKey === (dialogKey ?? '');
  }

  /**
   * The tool call the dialog should be for: the transcript's pending
   * `tool_use` first (it is the agent's own record, and its id binds one
   * dialog instance), else the PermissionRequest hook's `tool_input`.
   */
  private bindingFor(sessionId: string, note: TerminalPromptNote): ToolCallBinding | null {
    let pending: PendingToolUse | null = null;
    try {
      pending = this.deps.pendingToolUse?.(sessionId) ?? null;
    } catch (err) {
      this.deps.log?.('warn', `[approvals] transcript read failed for ${sessionId}: ${String(err)}`);
    }
    if (pending) return { id: pending.id, name: pending.name, input: pending.input };
    if (note.toolInput && note.toolName) {
      return { ...(note.toolUseId ? { id: note.toolUseId } : {}), name: note.toolName, input: note.toolInput };
    }
    return null;
  }

  /**
   * The ACTIVE dialog on the pane's screen, or null. Read a few times: the
   * PermissionRequest hook can land before the dialog is drawn.
   */
  private async readDialogForCreation(sessionId: string): Promise<DialogRead | null> {
    if (!this.deps.readPromptScreen) return null;
    const delay = this.deps.promptReadDelay
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    for (let attempt = 1; attempt <= TERMINAL_PROMPT_CREATE_READS; attempt++) {
      const read = await this.readActiveDialog(sessionId);
      if (read) return read;
      if (attempt < TERMINAL_PROMPT_CREATE_READS) await delay(TERMINAL_PROMPT_CREATE_READ_GAP_MS);
    }
    return null;
  }

  /** One screen read, parsed. Outside the mutation chain: a render can take seconds. */
  private async readActiveDialog(sessionId: string): Promise<DialogRead | null> {
    let screen: { rows: readonly string[]; mark: PromptScreenMark; cols?: number } | null = null;
    try {
      screen = (await this.deps.readPromptScreen?.(sessionId)) ?? null;
    } catch (err) {
      this.deps.log?.('warn', `[approvals] prompt screen read failed for ${sessionId}: ${String(err)}`);
    }
    if (!screen) return null;
    const parsed = parseTerminalPrompt(screen.rows, screen.cols ? { cols: screen.cols } : {});
    return parsed && parsed.active ? { parsed, mark: screen.mark } : null;
  }

  /** A fresh `terminal_prompt` record from what was read and what it binds to. */
  private buildTerminalPrompt(
    note: TerminalPromptNote,
    read: DialogRead | null,
    binding: ToolCallBinding | null,
  ): ApprovalRequest {
    const parsed = read?.parsed ?? null;
    const command = binding ? commandOfToolInput(binding.name, binding.input) : undefined;
    const description = typeof binding?.input['description'] === 'string' ? binding.input['description'] : undefined;
    const toolName = binding?.name ?? note.toolName ?? toolFromDialogTitle(parsed?.title);
    // The call's own input is the source of the summary; the screen only when
    // there is no call to read it from.
    const summary = boundRecordText(command, TERMINAL_PROMPT_SUMMARY_MAX)
      ?? (parsed ? boundRecordText(parsed.commandText, TERMINAL_PROMPT_SUMMARY_MAX) : undefined)
      ?? note.summary;
    const bound = !!parsed && !!binding && !!command
      && command.length <= TERMINAL_PROMPT_SUMMARY_MAX
      && dialogMatchesToolCall(parsed, { name: binding.name, command, ...(description ? { description } : {}) });
    const answer = bound ? terminalPromptAnswerability(parsed, TERMINAL_PROMPT_SUMMARY_MAX) : null;
    const answerable = !!answer?.answerable;
    const risky = terminalPromptTextRisk(command, summary, parsed?.reason);
    return {
      id: this.newId(),
      sessionId: note.sessionId,
      ...(note.workspaceId ? { workspaceId: note.workspaceId } : {}),
      agent: note.agent,
      kind: 'terminal_prompt',
      ...(toolName ? { toolName } : {}),
      ...(summary ? { summary } : {}),
      ...(risky ? { risk: 'critical' as const } : {}),
      ...(answerable && parsed && read
        ? {
            question: parsed.question,
            ...(parsed.reason ? { reason: parsed.reason } : {}),
            choices: answer!.choices,
            promptFingerprint: bindFingerprint(parsed.fingerprint, binding?.id, read.mark.keyInputRevision),
            ...(binding?.id ? { toolUseId: binding.id } : {}),
            keyRevisionAtCreate: read.mark.keyInputRevision,
          }
        : {}),
      dialogKey: `${parsed?.fingerprint ?? '-'}|${binding?.id ?? '-'}`,
      createdAt: this.now(),
      state: 'pending',
    };
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
    // Stamped at call time. The cooldown remembers WHICH dialog was released,
    // so only a repeat of that same dialog is held back.
    this.sweepSeq.set(sessionId, (this.sweepSeq.get(sessionId) ?? 0) + 1);
    if (reason === 'screen-cleared') {
      const released = this.requests.find(
        (r) => r.state === 'pending' && r.sessionId === sessionId && r.kind === 'terminal_prompt',
      );
      const previous = this.terminalPromptQuiet.get(sessionId);
      const stillQuiet = previous && this.now() < previous.until ? previous.dialogKey : undefined;
      this.terminalPromptQuiet.set(sessionId, {
        until: this.now() + TERMINAL_PROMPT_COOLDOWN_MS,
        // No record to name (its re-creation was the one held back): keep the
        // dialog the window is already about.
        dialogKey: released?.dialogKey ?? stillQuiet ?? '',
      });
    } else if (reason === 'pane-gone') {
      this.terminalPromptQuiet.delete(sessionId);
      this.refreshTimers.get(sessionId)?.();
      this.refreshTimers.delete(sessionId);
    }
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
    // The agent's own terminal dialog: its screen read happens OUTSIDE the
    // mutation chain (a render can take seconds and would hold every other
    // resolve, hook and expiry); only the CAS, the fence and the write run in it.
    const peek = this.requests.find((r) => r.id === params.id);
    if (peek?.kind === 'terminal_prompt') return this.resolveTerminalPrompt(params, peek);
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


      // The caller's authority, re-checked inside the chain before ANY
      // mutation — including the prompt-gone expiry below.
      const refusedEarly = await this.reauthorize(params, record);
      if (refusedEarly) return { result: refusedEarly };

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
        // Last check before the waiter wakes and the tool runs. Nothing awaits
        // between this and the entry check today; it stays so that a future
        // await added above cannot silently reopen the window.
        const refusedGate = await this.reauthorize(params, record);
        if (refusedGate) return { result: refusedGate };
        // A pending gate is held by the hook, not displayed on a terminal.
        // Read current autonomy AFTER the last awaited authority check so a
        // policy change during that check cannot release the blocked tool.
        const pressRefusal = this.refuseOutOfScopePress(params, record, true);
        if (pressRefusal) return { result: pressRefusal };
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

      const pressRefusal = this.refuseOutOfScopePress(params, record,
        !!rows && rows.length > 0 && looksLikeApprovalPrompt(rows));
      if (pressRefusal) return { result: pressRefusal };

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

      // Last check before the bytes: the screen re-read above can take seconds.
      const refusedWrite = await this.reauthorize(params, record);
      if (refusedWrite) return { result: refusedWrite };
      // Policy again, after the last await: the operator may have turned
      // autonomy or approval pressing off while reauthorize ran, and the scope
      // read above predates that. Same rule the gate branch follows.
      const lateRefusal = this.refuseOutOfScopePress(params, record, true);
      if (lateRefusal) return { result: lateRefusal };

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

  /**
   * Answer the agent's own terminal dialog from a phone. Fails closed at every
   * step; the only success writes ONE byte — the chosen option's digit, never
   * Enter — and only once per record.
   *
   * Outside the mutation chain (reads only, nothing changes):
   *   1. one answer per record: `pressedAt` set → `already-answered`
   *   2. who: a human through the web route from a capable client (the route's
   *      Symbol marker — JSON callers such as the pipe RPC or MCP
   *      `approval_press` cannot carry it) → else `answer-in-terminal`; so is a
   *      record that was never bound and parsed whole (no choices/fingerprint)
   *   3. what: `choiceKey` one of the stored choices and `decision` matching
   *      its label, a fingerprint echoed → else `invalid-choice`; the echoed
   *      fingerprint equal to the record's → else `prompt-changed`
   *   4. when: not within TERMINAL_PROMPT_MIN_ANSWER_AGE_MS of creation
   *   5. the call: the transcript's pending `tool_use` is still the record's
   *   6. the screen: re-read and re-parsed with the pane's state captured at
   *      that instant; the dialog must be ACTIVE and hash (with the tool_use
   *      id) to the same fingerprint, and no key or click may have reached the
   *      pane since the record was created. Changed content supersedes the
   *      record with a fresh one (the phone re-reads it off SSE).
   * Inside the chain, synchronously up to the write: the CAS (still pending,
   * not pressed) and the fence — no key/click and no new PTY since the read
   * (refused at once: a human may just have answered), and no output (read
   * again, up to TERMINAL_PROMPT_ANSWER_ATTEMPTS).
   *
   * Every outcome is audited in one log line: who, which record and pane,
   * which tool and choice, the fingerprint's first 8 characters. Never the
   * command or the reason line.
   */
  private async resolveTerminalPrompt(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
  ): Promise<ApprovalResolveResult> {
    const choice = record.choices?.find((c) => c.key === params.choiceKey);
    const audit = (outcome: string): void => {
      this.deps.log?.(
        'info',
        `[approvals] terminal-prompt answer outcome=${outcome} record=${record.id} session=${record.sessionId} ` +
          `by="${logText(sanitizeResolvedBy(params.resolvedBy))}" tool=${logText(record.toolName, 40) || '-'} ` +
          `choice=${params.choiceKey !== undefined ? logText(params.choiceKey, 4) : '-'}` +
          `${choice ? `:${logText(choice.label, 40)}` : ''} ` +
          `fp=${(record.promptFingerprint ?? '').slice(0, 8) || '-'}`,
      );
    };
    const refuse = (reason: ApprovalResolveFailure): ApprovalResolveResult => {
      audit(reason);
      return { ok: false, reason, request: copyRequest(record) };
    };

    if (record.state !== 'pending') {
      const reason = record.state === 'resolved' ? 'already-resolved' : 'expired';
      audit(reason);
      return {
        ok: false,
        reason,
        ...(record.resolvedBy !== undefined ? { resolvedBy: record.resolvedBy } : {}),
        request: copyRequest(record),
      };
    }
    if (record.pressedAt !== undefined) return refuse('already-answered');
    if (
      (params.resolver ?? 'human') !== 'human'
      || params.terminalPromptAnswer !== TERMINAL_PROMPT_WEB_ANSWER
      || !record.promptFingerprint
      || !record.choices?.length
    ) {
      return refuse('answer-in-terminal');
    }
    if (!choice || !params.promptFingerprint) return refuse('invalid-choice');
    const expected = decisionForChoiceLabel(choice.label);
    if (expected === null || params.decision !== expected) return refuse('invalid-choice');
    if (params.promptFingerprint !== record.promptFingerprint) return refuse('prompt-changed');
    if (this.now() - record.createdAt < TERMINAL_PROMPT_MIN_ANSWER_AGE_MS) return refuse('answer-too-soon');

    const refusedEarly = await this.reauthorize(params, record);
    if (refusedEarly) {
      audit(refusedEarly.ok ? 'ok' : refusedEarly.reason);
      return refusedEarly;
    }

    for (let attempt = 1; attempt <= TERMINAL_PROMPT_ANSWER_ATTEMPTS; attempt++) {
      // The call the dialog is for must still be the one pending.
      let callChanged = false;
      if (record.toolUseId) {
        let pending: PendingToolUse | null = null;
        try {
          pending = this.deps.pendingToolUse?.(record.sessionId) ?? null;
        } catch {
          pending = null;
        }
        callChanged = !pending || pending.id !== record.toolUseId;
      }
      const live = await this.readActiveDialog(record.sessionId);
      if (!live) return refuse('prompt-changed');
      if (callChanged) {
        // Another call's dialog is up (or none is pending): replace the record
        // with what is there now, and refuse this answer.
        const superseded = await this.supersedeWithFresh(record, live);
        audit('prompt-changed');
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      // A key or click since the record appeared: a human is at the terminal,
      // and what the phone confirmed may no longer be what is selected. Never
      // pressed through — but the record is refreshed from this read (a new id
      // and fingerprint, the reflex guard restarted), so the phone re-reads and
      // can confirm the dialog as it is now.
      if (record.keyRevisionAtCreate !== undefined && live.mark.keyInputRevision !== record.keyRevisionAtCreate) {
        const superseded = await this.supersedeWithFresh(record, live);
        audit('prompt-changed');
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      if (bindFingerprint(live.parsed.fingerprint, record.toolUseId, record.keyRevisionAtCreate) !== record.promptFingerprint) {
        const superseded = await this.supersedeWithFresh(record, live);
        audit('prompt-changed');
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      const stillAnswerable = terminalPromptAnswerability(live.parsed, TERMINAL_PROMPT_SUMMARY_MAX);
      if (!stillAnswerable.choices.some((c) => c.key === choice.key && c.label === choice.label)) {
        return refuse('prompt-changed');
      }

      const refusedWrite = await this.reauthorize(params, record);
      if (refusedWrite) {
        audit(refusedWrite.ok ? 'ok' : refusedWrite.reason);
        return refusedWrite;
      }

      let keyMoved = false;
      const outcome = await this.mutate<'retry' | ApprovalResolveResult>(() => {
        // ── Synchronous from here to the write: nothing can move in between. ──
        if (record.state !== 'pending') {
          return { result: { ok: false, reason: record.state === 'resolved' ? 'already-resolved' : 'expired', request: copyRequest(record) } };
        }
        if (record.pressedAt !== undefined) {
          return { result: { ok: false, reason: 'already-answered', request: copyRequest(record) } };
        }
        const now = this.deps.promptScreenMark?.(record.sessionId) ?? null;
        if (!now || now.incarnation !== live.mark.incarnation || now.keyInputRevision !== live.mark.keyInputRevision) {
          // Never retried: a human may just have answered in the pane.
          keyMoved = !!now && now.incarnation === live.mark.incarnation;
          return { result: { ok: false, reason: 'prompt-changed', request: copyRequest(record) } };
        }
        if (now.bytes !== live.mark.bytes) return { result: 'retry' };
        // The CAS: one write per record, ever.
        record.pressedAt = this.now();
        let delivered = false;
        try {
          delivered = this.deps.writeToSession(record.sessionId, choice.key);
        } catch (err) {
          this.deps.log?.('warn', `[approvals] write failed for ${record.sessionId}: ${String(err)}`);
        }
        if (!delivered) {
          delete record.pressedAt;
          record.state = 'expired';
          record.resolvedAt = this.now();
          return {
            events: [{ type: 'expire', request: copyRequest(record) }],
            result: { ok: false, reason: 'prompt-gone', request: copyRequest(record) },
          };
        }
        record.decision = expected;
        record.selectedChoiceKey = choice.key;
        record.resolvedBy = sanitizeResolvedBy(params.resolvedBy);
        return {
          events: [{ type: 'press', request: copyRequest(record) }],
          result: { ok: true, request: copyRequest(record), durable: true },
        };
      }, (result, durable) => (result !== 'retry' && result.ok ? { ...result, durable } : result));
      if (outcome === 'retry') continue;
      if (keyMoved) {
        // A key or click landed between the read and the write: refresh the
        // record from a fresh read, as above, so the phone can re-confirm.
        const again = await this.readActiveDialog(record.sessionId);
        const superseded = again ? await this.supersedeWithFresh(record, again) : null;
        audit('prompt-changed');
        return { ok: false, reason: 'prompt-changed', request: superseded ?? copyRequest(record) };
      }
      audit(outcome.ok ? 'pressed' : outcome.reason);
      return outcome;
    }
    return refuse('prompt-changed');
  }

  /**
   * The dialog on screen changed under an answer: replace the record with one
   * built from what is there now (a new id and fingerprint), so the phone
   * re-reads and can answer the dialog that is actually up. `create` carries
   * `replaces`, so the push carries over rather than firing again.
   */
  private async supersedeWithFresh(record: ApprovalRequest, live: DialogRead): Promise<ApprovalRequest | null> {
    const note: TerminalPromptNote = {
      sessionId: record.sessionId,
      agent: record.agent,
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.toolName ? { toolName: record.toolName } : {}),
      source: 'detector',
    };
    const fresh = this.buildTerminalPrompt(note, live, this.bindingFor(record.sessionId, note));
    return this.mutate<ApprovalRequest | null>(() => {
      if (record.state !== 'pending' || record.pressedAt !== undefined) return { result: null };
      record.state = 'superseded';
      record.resolvedAt = this.now();
      fresh.createdAt = this.now();
      this.requests.push(fresh);
      return {
        events: [
          { type: 'supersede', request: copyRequest(record) },
          { type: 'create', request: copyRequest(fresh), replaces: record.id },
        ],
        result: copyRequest(record),
      };
    });
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
      // A terminal_prompt whose remote answer was written RESOLVES when its
      // dialog is gone (the answered path, the screen check, the turn's end).
      if (r.pressedAt !== undefined) {
        r.state = 'resolved';
        r.resolvedAt = this.now();
        events.push({ type: 'resolve', request: copyRequest(r) });
        continue;
      }
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

  /** Shared policy for both screen presses and permission-hook verdicts. */
  private refuseOutOfScopePress(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
    stillOnScreen: boolean,
  ): ApprovalResolveResult | null {
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
      stillOnScreen,
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
      } as ApprovalResolveResult;
    }

    return null;
  }

  /**
   * Run the caller's `authorize` (see ApprovalResolveParams). Returns the
   * refusal to answer with, or null when the caller may proceed. A throw, a
   * rejection or an unknown verdict fails closed as `unauthorized`; a check
   * that does not settle within `authorizeTimeoutMs` fails closed as
   * `authorization-unconfirmed` (retryable — the credential may be fine). The
   * record is left exactly as it was: no state change, no event, no persist.
   */
  private async reauthorize(
    params: ApprovalResolveParams,
    record: ApprovalRequest,
  ): Promise<ApprovalResolveResult | null> {
    const authorize = params.authorize;
    if (!authorize) return null;
    let verdict: 'ok' | 'expired' | 'read-only' | 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      verdict = await Promise.race([
        authorize(copyRequest(record)),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.deps.authorizeTimeoutMs ?? 2000);
        }),
      ]);
    } catch (err) {
      this.deps.log?.('warn', `[approvals] authorize threw for ${record.id}: ${String(err)}`);
      verdict = 'expired';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (verdict === 'ok') return null;
    if (verdict === 'timeout') {
      this.deps.log?.('warn', `[approvals] authorize timed out for ${record.id}`);
    }
    return {
      ok: false,
      reason: verdict === 'read-only' ? 'input-revoked'
        : verdict === 'timeout' ? 'authorization-unconfirmed'
        : 'unauthorized',
      request: copyRequest(record),
    };
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
