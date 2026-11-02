// External sessions (shared/externalSessions.ts): coding agents started outside
// wmux — tmux, screen, zellij, ssh into this machine, another terminal app —
// whose hooks reach the daemon but route to no pane. HookIngest hands over each
// such signal; this keeps one status row per agent conversation (running,
// needs-you, idle, ended) and nothing more. wmux never shows or types into
// their terminal, so a row is never a target for input.
//
// A signal's text is untrusted (any holder of the pipe token can send one), so
// only derived, capped, control-free fields are stored: the payload itself is
// never kept and its transcript path is never opened.

import {
  EXTERNAL_SESSION_LIMITS,
  type ExternalSession,
  type ExternalSessionState,
  type ExternalSessionWhere,
} from '../../shared/externalSessions';
import { isFreshSessionSource, type AgentSignal } from '../../shared/hooks/signal-types';
import { containsControlChars } from '../../shared/cwdShape';
import { sanitizeRemoteText } from '../../shared/a2aRemoteDelivery';
import { extractAskUserQuestion } from '../approvals/askUserQuestion';
import { isStaleInterruptedStop } from '../../shared/hooks/CompletionAlarm';
import { classifyEntrypoint, signalAgentPid, signalEntrypoint, summarizeToolInput } from '../hooks/HookIngest';

/** A burst of signals (a turn's tool calls) leaves as one push. */
const CHANGE_COALESCE_MS = 250;
/** TTLs and process liveness are re-checked this often while any row exists. */
const SWEEP_MS = 30_000;
/**
 * A running row with no pid to check goes idle after this much silence: a
 * process that died mid-turn sends nothing. needs-you never times out (a
 * question can wait for hours); SessionEnd covers a session that closed.
 */
const RUNNING_SILENT_MS = 10 * 60 * 1000;
/** Bounds for the two keys the contract leaves uncapped; a signal past either is dropped. */
const SESSION_ID_MAX = 128;
const CWD_MAX = 4096;
const TOOL_NAME_MAX = 64;

// Bidi overrides and isolates: invisible, and able to reorder what a row reads.
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/** One line of untrusted text: escapes, controls and bidi gone, whitespace folded, capped. */
export function externalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = sanitizeRemoteText(value).replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  if (line.length <= max) return line;
  let cut = line.slice(0, max - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const WHERE_TEXT_FIELDS = ['session', 'window', 'label', 'wslDistro'] as const;

function cleanWhere(where: ExternalSessionWhere | undefined): Partial<ExternalSessionWhere> {
  if (!where) return {};
  const out: Partial<ExternalSessionWhere> = where.kind === 'unknown' ? {} : { kind: where.kind };
  for (const key of WHERE_TEXT_FIELDS) {
    const text = externalText(where[key], EXTERNAL_SESSION_LIMITS.whereField);
    if (text) out[key] = text;
  }
  return out;
}

/** "Read src/app.ts": the tool and what it touches, when the payload names a tool. */
function toolLine(payload: Record<string, unknown>, max: number): string | undefined {
  const tool = externalText(payload['tool_name'], TOOL_NAME_MAX);
  if (!tool) return undefined;
  const summary = summarizeToolInput(payload);
  return externalText(summary ? `${tool} ${summary}` : tool, max);
}

/** A real subagent's id (both ids set), or undefined for the lead: its tools can run while another agent waits on the user. */
function subagentId(payload: Record<string, unknown>): string | undefined {
  const id = payload['agent_id'];
  const type = payload['agent_type'];
  return typeof id === 'string' && id.length > 0 && typeof type === 'string' && type.length > 0 ? id : undefined;
}

interface Entry {
  session: ExternalSession;
  /** The agent's own pid, when its bridge reports one (macOS only). */
  agentPid?: number;
  /** What the latest permission dialog asks; shown once it is confirmed waiting. */
  permissionText?: string;
  /** The subagent that latest permission dialog belongs to; undefined for the lead. */
  permissionAgentId?: string;
  /** The subagent a needs-you row waits on; undefined for the lead. */
  pendingAgentId?: string;
  /** Ended by SessionEnd: a late signal from the same session (its Stop losing
   *  the race to the exit) must not bring the row back. */
  closed?: boolean;
  /** When the latest prompt was submitted: an interrupted turn's Stop older than it is stale. */
  lastPromptAt?: number;
}

export interface ExternalSessionRegistryDeps {
  now?: () => number;
  /** Fresh liveness of a pid. Without it a row ends only by going silent. */
  isPidRunning?: (pid: number) => boolean;
  /** The full list after a change, coalesced. */
  onChanged?: (sessions: ExternalSession[]) => void;
}

export class ExternalSessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ExternalSessionRegistryDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * A hook signal that reached no pane. Never called for a routed one, so a
   * pane's own agent never shows up here as well.
   */
  note(signal: AgentSignal): void {
    // A hook naming a wmux pane runs inside one. Its pane is gone (or is not
    // who it claims): a dead pane's straggler, not a session outside wmux.
    if (signal.ptyId) return;
    // `claude -p` and other SDK runs wait on nobody; the bridge drops them too.
    if (classifyEntrypoint(signalEntrypoint(signal)) === 'headless') return;
    const agentSessionId = signal.agentSessionId;
    if (!agentSessionId || agentSessionId.length > SESSION_ID_MAX || containsControlChars(agentSessionId)) return;
    if (signal.cwd.length > CWD_MAX || containsControlChars(signal.cwd)) return;

    const now = this.now();
    const id = `${signal.agent}:${agentSessionId}`;
    let entry = this.entries.get(id);
    if (!entry) {
      // The end of a session never seen: nothing to show.
      if (signal.kind === 'agent.session_end') return;
      this.makeRoom();
      entry = {
        session: {
          id,
          agent: signal.agent,
          agentSessionId,
          cwd: signal.cwd,
          where: { kind: 'unknown' },
          state: 'running',
          lastSignalAt: now,
          startedAt: now,
        },
      };
      this.entries.set(id, entry);
    }
    const s = entry.session;
    s.cwd = signal.cwd;
    s.lastSignalAt = now;
    // A later hook fills in what an earlier one could not say and never blanks
    // it: per-tool hooks carry the tmux kind without the session name.
    s.where = { ...s.where, ...cleanWhere(signal.where) };
    const pid = signalAgentPid(signal);
    if (pid !== undefined && pid !== entry.agentPid) {
      entry.agentPid = pid;
      this.endOthersOnPid(entry, now);
    }
    this.apply(entry, signal);
    this.scheduleChanged();
    this.ensureSweep();
  }

  /** The conversation now reports from a wmux pane: it is no longer external. */
  forget(agent: string, agentSessionId: string): void {
    if (this.entries.delete(`${agent}:${agentSessionId}`)) this.scheduleChanged();
  }

  /** Drop a row until its session sends another signal. */
  hide(id: string): boolean {
    const had = this.entries.delete(id);
    if (had) this.scheduleChanged();
    return had;
  }

  /** Every row, most recently heard first, after applying the TTLs. */
  list(): ExternalSession[] {
    this.sweep();
    return this.snapshot();
  }

  /** Apply the TTLs and process liveness. Exposed for tests; runs on a timer. */
  sweep(): void {
    const now = this.now();
    let changed = false;
    for (const [id, entry] of this.entries) {
      const s = entry.session;
      if (s.state !== 'ended') {
        if (now - s.lastSignalAt >= EXTERNAL_SESSION_LIMITS.silentTtlMs) {
          this.end(entry, s.lastSignalAt + EXTERNAL_SESSION_LIMITS.silentTtlMs);
          changed = true;
        } else if (entry.agentPid !== undefined && !this.pidRunning(entry.agentPid)) {
          this.end(entry, now);
          changed = true;
        } else if (entry.agentPid === undefined && s.state === 'running' && now - s.lastSignalAt >= RUNNING_SILENT_MS) {
          this.setState(entry, 'idle');
          changed = true;
        }
      }
      if (s.state === 'ended' && now - (s.endedAt ?? now) >= EXTERNAL_SESSION_LIMITS.endedTtlMs) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.scheduleChanged();
    if (this.entries.size === 0) this.stopSweep();
  }

  dispose(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    this.stopSweep();
  }

  private apply(entry: Entry, signal: AgentSignal): void {
    const s = entry.session;
    const payload = signal.payload;
    if (entry.closed) {
      // Only a resumed session reopens a row SessionEnd closed.
      if (signal.kind !== 'agent.session_start' && signal.kind !== 'agent.user_prompt_submit') return;
      entry.closed = false;
    }
    switch (signal.kind) {
      case 'agent.session_start':
        // A new, resumed or cleared session waits at its prompt; `compact`
        // fires in the middle of a turn.
        this.setState(entry, isFreshSessionSource(payload['source']) ? 'idle' : 'running');
        return;
      case 'agent.user_prompt_submit':
        s.title ??= externalText(payload['prompt'], EXTERNAL_SESSION_LIMITS.title);
        entry.lastPromptAt = this.now();
        this.setState(entry, 'running');
        return;
      // The PreToolUse gate (awaiting_permission) fires for every tool call;
      // nothing waits on it here.
      case 'agent.activity':
      case 'agent.tool_started':
      case 'agent.awaiting_permission': {
        const line = toolLine(payload, EXTERNAL_SESSION_LIMITS.lastActivity);
        if (line) s.lastActivity = line;
        // Another agent's tool can run while a dialog is still up. A question
        // is answered only by input_answered; an approval is answered once the
        // agent that asked runs a tool again (an external session sends no
        // permission_answered: its gate hook exits outside a pane).
        if (s.state === 'needs-you') {
          const agentId = subagentId(payload);
          if (s.pendingKind === 'question' ? agentId !== undefined : agentId !== entry.pendingAgentId) return;
        }
        this.setState(entry, 'running');
        return;
      }
      case 'agent.input_answered':
      case 'agent.permission_answered':
        this.setState(entry, 'running');
        return;
      case 'agent.awaiting_input':
        this.applyAwaiting(entry, payload);
        return;
      case 'agent.stop':
      case 'agent.stop_failure':
        // An Esc'd turn's Stop that lost the race to the next prompt: that
        // prompt's turn is running now.
        if (isStaleInterruptedStop(signal, entry.lastPromptAt)) return;
        this.setState(entry, 'idle');
        return;
      case 'agent.subagent_stop':
        // The lead is still mid-turn; only a row the TTLs had ended changes,
        // or an approval its own subagent asked for: a subagent whose tool was
        // denied can stop without running another tool to release it.
        if (s.state === 'ended') this.setState(entry, 'running');
        else if (s.state === 'needs-you' && s.pendingKind === 'approval'
          && entry.pendingAgentId !== undefined && subagentId(payload) === entry.pendingAgentId) {
          this.setState(entry, 'running');
        }
        return;
      case 'agent.session_end':
        this.end(entry, this.now());
        entry.closed = true;
        return;
    }
  }

  private applyAwaiting(entry: Entry, payload: Record<string, unknown>): void {
    const s = entry.session;
    const event = payload['hook_event_name'];
    if (event === 'PermissionRequest') {
      // Claude fires this for dialogs nobody waits on too (decided by another
      // hook, answered at once), so it only records what is asked. The
      // permission Notification, sent once a dialog has waited about six
      // seconds, is what marks the session needs-you. A new dialog also means
      // the previous one was answered.
      entry.permissionText = toolLine(payload, EXTERNAL_SESSION_LIMITS.pendingQuestion);
      entry.permissionAgentId = subagentId(payload);
      if ((s.state === 'needs-you' && s.pendingKind === 'approval') || s.state === 'ended') {
        this.setState(entry, 'running');
      }
      return;
    }
    if (event === 'Notification') {
      this.setNeedsYou(entry, 'approval',
        entry.permissionText ?? externalText(payload['message'], EXTERNAL_SESSION_LIMITS.pendingQuestion),
        subagentId(payload) ?? entry.permissionAgentId);
      return;
    }
    const question = extractAskUserQuestion(payload).question ?? payload['message'];
    this.setNeedsYou(entry, payload['tool_name'] === 'AskUserQuestion' ? 'question' : 'approval',
      externalText(question, EXTERNAL_SESSION_LIMITS.pendingQuestion), subagentId(payload));
  }

  private setState(entry: Entry, state: Exclude<ExternalSessionState, 'needs-you' | 'ended'>): void {
    const s = entry.session;
    s.state = state;
    delete s.endedAt;
    delete s.pendingQuestion;
    delete s.pendingKind;
    delete entry.pendingAgentId;
  }

  private setNeedsYou(entry: Entry, kind: 'approval' | 'question', question: string | undefined, agentId: string | undefined): void {
    const s = entry.session;
    s.state = 'needs-you';
    s.pendingKind = kind;
    entry.pendingAgentId = agentId;
    if (question) s.pendingQuestion = question;
    else delete s.pendingQuestion;
    delete s.endedAt;
  }

  private end(entry: Entry, at: number): void {
    const s = entry.session;
    s.state = 'ended';
    s.endedAt = at;
    delete s.pendingQuestion;
    delete s.pendingKind;
    delete entry.pendingAgentId;
  }

  /** One process runs one conversation: `/clear` or `/resume` in it ends the one before. */
  private endOthersOnPid(current: Entry, now: number): void {
    for (const entry of this.entries.values()) {
      if (entry === current || entry.agentPid !== current.agentPid) continue;
      if (entry.session.agent !== current.session.agent || entry.session.state === 'ended') continue;
      this.end(entry, now);
    }
  }

  /** At the cap, the oldest ended row goes first, then the longest silent. */
  private makeRoom(): void {
    while (this.entries.size >= EXTERNAL_SESSION_LIMITS.maxSessions) {
      let victim: Entry | undefined;
      for (const entry of this.entries.values()) {
        if (!victim || evictBefore(entry.session, victim.session)) victim = entry;
      }
      if (!victim) return;
      this.entries.delete(victim.session.id);
    }
  }

  private pidRunning(pid: number): boolean {
    if (!this.deps.isPidRunning) return true;
    try {
      return this.deps.isPidRunning(pid);
    } catch {
      return true;
    }
  }

  private snapshot(): ExternalSession[] {
    return [...this.entries.values()]
      .map((e) => ({ ...e.session, where: { ...e.session.where } }))
      .sort((a, b) => b.lastSignalAt - a.lastSignalAt);
  }

  private scheduleChanged(): void {
    if (!this.deps.onChanged || this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.deps.onChanged?.(this.snapshot());
    }, CHANGE_COALESCE_MS);
    this.changeTimer.unref?.();
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  private stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

function evictBefore(a: ExternalSession, b: ExternalSession): boolean {
  const aEnded = a.state === 'ended';
  const bEnded = b.state === 'ended';
  if (aEnded !== bEnded) return aEnded;
  return aEnded ? (a.endedAt ?? 0) < (b.endedAt ?? 0) : a.lastSignalAt < b.lastSignalAt;
}
