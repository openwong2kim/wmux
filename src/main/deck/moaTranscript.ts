// ─── Moa transcript — the HQ brain's conversation for the right panel ────────
//
// The right-panel chat shows the HQ (Moa) brain's Claude transcript as turn
// events. It reuses the daemon's TranscriptProjector (plain node: fs, path,
// shared) instead of writing a second normalizer, but runs ONE instance here in
// main with ONE logical session — the HQ brain.
//
// Why main and not the daemon: the brain pane is deliberately not a daemon
// transcript session (its hooks are claimed by the brain-pty lane in main, it
// has no resume binding in the daemon, and the phone routes refuse it). The
// binding the projector reads therefore comes from the adapter's own hook
// signals and the commander session id, both of which only main sees.
//
// One rule above all: this module never reads any transcript other than the
// HQ brain's. The binding is built only from hints and session ids reported
// for the CURRENT HQ workspace while Moa is on, and every read goes through the
// projector's containment check (basename = `<sessionId>.jsonl`, inside a
// Claude projects root).
//
// Two pieces of state stay separate on purpose:
//   - `binding`    — which transcript the HQ brain is on. Dropped when the
//                    brain is retired (a model swap, /clear, the HQ gate) and
//                    rebuilt when the next brain reports its session.
//   - `subscribed` — the renderer's intent. Survives a brain retire (nothing
//                    tells the renderer about a model-swap retire), so the next
//                    binding re-arms the watch and pushes a reset snapshot.
//                    Dropped only when Moa goes off or the HQ changes; the
//                    renderer hears those through DECK_MOA_CHANGED.

import { TranscriptProjector } from '../../daemon/transcript/TranscriptProjector';
import { scanForTranscript } from '../../daemon/transcript/TranscriptDiscovery';
import { getWmuxDir } from '../../daemon/config';
import { resolveBrainHomeDir } from './ClaudePtyBrainAdapter';
import type { ResumeBinding } from '../../shared/agentResume';
import type { AgentSignalKind } from '../../shared/hooks/signal-types';
import type {
  TranscriptAppendData,
  TranscriptPage,
  TranscriptStatus,
  TurnEvent,
} from '../../shared/transcript/turnEvents';

/** How many recent prompts Moa remembers for the chat view. */
const PROMPT_MEMORY = 50;
/** A transcript user entry lands a little after main typed it. */
const PROMPT_MATCH_SLACK_MS = 5_000;

/**
 * The terminal brain types each turn as one paste — the context blocks main
 * builds (rules, policy, decision, active work) with the prompt at the end —
 * so Claude records the whole wire as the user's message, capped by the
 * parser. Shown as-is, the chat would display Moa's instructions as if the
 * operator had typed them. Main knows what was actually asked, so a pasted
 * user entry is shown as the prompt main sent at that moment. So is an entry
 * that merely ends with that prompt: a wire typed into a TUI that is still
 * starting can land without its paste markers and missing its first
 * characters, and it still carries the context blocks.
 */
export function rewritePastedPrompts(
  events: readonly TurnEvent[],
  prompts: readonly { at: number; text: string }[],
): TurnEvent[] {
  if (prompts.length === 0) return [...events];
  return events.map((e) => {
    if (e.kind !== 'user_text') return e;
    const at = typeof e.ts === 'number' ? e.ts : Number.POSITIVE_INFINITY;
    let match: { at: number; text: string } | undefined;
    for (const p of prompts) {
      if (p.at <= at + PROMPT_MATCH_SLACK_MS && (!match || p.at > match.at)) match = p;
    }
    if (!match || e.text === match.text) return e;
    const prompt = match.text.trim();
    const wire = e.text.includes('<pasted_content') || (prompt.length > 0 && e.text.trimEnd().endsWith(prompt));
    return wire ? { ...e, text: match.text } : e;
  });
}

/** The projector's one session key. Never a daemon pty id. */
const SESSION_KEY = 'moa-hq-brain';
/** The projector's one client: the desktop renderer's Moa panel. */
const CLIENT_ID = 'moa-panel';

/**
 * Reasons this module answers before the projector is consulted. Additive to
 * the projector's own set (`TranscriptStatus.reason` is a free string).
 */
export const MOA_TRANSCRIPT_REASONS = {
  moaOff: 'moa-off',
  noHq: 'no-hq',
  noBrain: 'no-brain',
} as const;

/** What the brain adapter reports from each of its hook signals. */
export interface MoaTranscriptHint {
  kind: AgentSignalKind;
  agentSessionId?: string;
  transcriptPath?: string;
}

export interface MoaTranscriptDeps {
  getHqWorkspaceId: () => string | null;
  isMoaEnabled: () => boolean;
  /** Push one append to the renderer (DECK_MOA_TRANSCRIPT_APPEND). */
  emitAppend: (data: TranscriptAppendData) => void;
  /**
   * The HQ brain's account env overlay (`CLAUDE_CONFIG_DIR` when the workspace
   * is bound to an account). The brain's transcript lives under that root, so
   * the containment check must see the same env the brain was spawned with.
   */
  getSessionEnv?: (workspaceId: string) => Record<string, string> | undefined;
  /** Data dir the brain home is resolved under. Defaults to getWmuxDir(). */
  wmuxDir?: () => string;
  /** Find `<sessionId>.jsonl` under the projects roots. Injected in tests. */
  scan?: (sessionId: string, env?: Record<string, string>) => string[];
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  debounceMs?: number;
  pollMs?: number;
}

interface HqBinding {
  workspaceId: string;
  sessionId: string;
  transcriptPath?: string;
  ts: number;
}

export class MoaTranscript {
  private readonly deps: MoaTranscriptDeps;
  private readonly projector: TranscriptProjector;
  private binding: HqBinding | null = null;
  /** The HQ the renderer subscribed under, or null when not subscribed. */
  private subscribedHq: string | null = null;
  /** Whether the projector currently holds the renderer's subscription. */
  private armed = false;
  /** Prompts sent to the HQ brain this run, oldest first. */
  private prompts: { at: number; text: string }[] = [];

  constructor(deps: MoaTranscriptDeps) {
    this.deps = deps;
    this.projector = new TranscriptProjector({
      getResumeBinding: (key) => this.resumeBinding(key),
      getDetectedAgent: (key) => (key === SESSION_KEY && this.liveBinding() ? 'claude' : undefined),
      getSessionEnv: (key) => {
        const b = key === SESSION_KEY ? this.liveBinding() : null;
        return b ? this.sessionEnv(b.workspaceId) : undefined;
      },
      emitAppend: (key, data, clientIds) => {
        if (key !== SESSION_KEY || !clientIds.includes(CLIENT_ID)) return;
        if (this.subscribedHq === null || this.subscribedHq !== this.activeHq()) return;
        this.deps.emitAppend({ ...data, events: rewritePastedPrompts(data.events, this.prompts) });
      },
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.debounceMs !== undefined ? { debounceMs: deps.debounceMs } : {}),
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    });
  }

  // ── renderer surface ──────────────────────────────────────────────────────

  status(): TranscriptStatus {
    this.sync();
    if (!this.deps.isMoaEnabled()) return { available: false, reason: MOA_TRANSCRIPT_REASONS.moaOff };
    if (!this.activeHq()) return { available: false, reason: MOA_TRANSCRIPT_REASONS.noHq };
    if (!this.liveBinding()) return { available: false, reason: MOA_TRANSCRIPT_REASONS.noBrain };
    return this.projector.status(SESSION_KEY);
  }

  snapshot(opts?: { before?: number }): TranscriptPage | null {
    this.sync();
    if (!this.liveBinding()) return null;
    const before = opts?.before;
    const valid = typeof before === 'number' && Number.isFinite(before) && before >= 0;
    const page = this.projector.snapshot(SESSION_KEY, valid ? { before: Math.floor(before) } : undefined);
    return page ? { ...page, events: rewritePastedPrompts(page.events, this.prompts) } : page;
  }

  /** The prompt main is about to send to a workspace's brain (the operator's
   *  words, or an automation's), remembered for the HQ's chat view. */
  notePrompt(workspaceId: string, text: string, at: number = Date.now()): void {
    if (workspaceId !== this.activeHq() || !text.trim()) return;
    this.prompts.push({ at, text });
    if (this.prompts.length > PROMPT_MEMORY) this.prompts.splice(0, this.prompts.length - PROMPT_MEMORY);
  }

  /**
   * Start pushing appends. A repeat subscribe (a renderer reload) re-arms from
   * scratch so the first push is a reset snapshot rather than an empty delta
   * from a cursor the reloaded renderer never saw.
   */
  subscribe(): TranscriptStatus {
    this.sync();
    const hq = this.activeHq();
    if (hq === null) return this.status();
    this.disarm();
    this.subscribedHq = hq;
    this.arm();
    return this.status();
  }

  unsubscribe(): void {
    this.subscribedHq = null;
    this.disarm();
  }

  // ── brain-side inputs ─────────────────────────────────────────────────────

  /** A hook signal from a workspace's terminal brain. Ignored unless HQ. */
  noteHint(workspaceId: string, hint: MoaTranscriptHint): void {
    if (workspaceId !== this.activeHq()) return;
    const sessionId = hint.agentSessionId || this.binding?.sessionId;
    if (!sessionId) return;
    const prev = this.liveBinding();
    const samePath = prev?.sessionId === sessionId ? prev.transcriptPath : undefined;
    const transcriptPath = hint.transcriptPath || samePath || this.find(workspaceId, sessionId);
    this.binding = { workspaceId, sessionId, ...(transcriptPath ? { transcriptPath } : {}), ts: Date.now() };
    // The binding is updated BEFORE the nudge, so a session_start for a new
    // session resolves to the new binding and the projector's stale-hold
    // branch (made for the daemon's refused provisional capture) never engages.
    if (this.armed) this.projector.nudge(SESSION_KEY, hint.kind, sessionId);
    else this.arm();
  }

  /** A session id the commander manager learned (resume, turn-end, foreign Stop). */
  noteSessionId(workspaceId: string, sessionId: string): void {
    if (!sessionId || workspaceId !== this.activeHq()) return;
    if (this.liveBinding()?.sessionId === sessionId) return;
    const transcriptPath = this.find(workspaceId, sessionId);
    this.binding = { workspaceId, sessionId, ...(transcriptPath ? { transcriptPath } : {}), ts: Date.now() };
    if (this.armed) this.projector.rebind(SESSION_KEY);
    else this.arm();
  }

  /** A workspace's brain was retired. Drops the binding; keeps the intent. */
  retire(workspaceId: string): void {
    if (this.binding?.workspaceId !== workspaceId) return;
    this.binding = null;
    this.disarm();
  }

  /**
   * Re-check the switch and the HQ. Moa off or a different HQ drops both the
   * binding and the renderer's subscription. Called on every Moa change and at
   * the top of every renderer call, so a missed notification can never leak
   * a previous HQ's conversation.
   */
  sync(): void {
    const hq = this.activeHq();
    if (this.binding && this.binding.workspaceId !== hq) {
      this.binding = null;
      this.disarm();
    }
    if (this.subscribedHq !== null && this.subscribedHq !== hq) {
      this.subscribedHq = null;
      this.disarm();
    }
  }

  dispose(): void {
    this.binding = null;
    this.subscribedHq = null;
    this.armed = false;
    this.projector.dispose();
  }

  /** Live watch count — tests only. */
  get watchCount(): number {
    return this.projector.watchCount;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The HQ workspace id while Moa is on, else null. */
  private activeHq(): string | null {
    if (!this.deps.isMoaEnabled()) return null;
    return this.deps.getHqWorkspaceId();
  }

  /** The binding, only while it still belongs to the active HQ. */
  private liveBinding(): HqBinding | null {
    const b = this.binding;
    return b && b.workspaceId === this.activeHq() ? b : null;
  }

  private resumeBinding(key: string): ResumeBinding | undefined {
    if (key !== SESSION_KEY) return undefined;
    const b = this.liveBinding();
    if (!b) return undefined;
    return {
      agent: 'claude',
      sessionId: b.sessionId,
      cwd: resolveBrainHomeDir(this.deps.wmuxDir?.() ?? getWmuxDir(), b.workspaceId),
      ...(b.transcriptPath ? { transcriptPath: b.transcriptPath } : {}),
      ts: b.ts,
    };
  }

  private sessionEnv(workspaceId: string): Record<string, string> | undefined {
    try {
      return this.deps.getSessionEnv?.(workspaceId);
    } catch {
      return undefined;
    }
  }

  /** Look the transcript up by name (bounded, one level under each root). */
  private find(workspaceId: string, sessionId: string): string | undefined {
    try {
      const scan = this.deps.scan ?? scanForTranscript;
      return scan(sessionId, this.sessionEnv(workspaceId))[0];
    } catch {
      return undefined;
    }
  }

  /** Hand the renderer's subscription to the projector, if it wants one. */
  private arm(): void {
    if (this.armed || this.subscribedHq === null || this.subscribedHq !== this.activeHq()) return;
    this.armed = true;
    this.projector.subscribe(CLIENT_ID, SESSION_KEY);
  }

  /** Tear the projector's watch down (and its session hold bookkeeping). */
  private disarm(): void {
    this.armed = false;
    this.projector.dropPty(SESSION_KEY);
  }
}
