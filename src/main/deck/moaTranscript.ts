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

import fs from 'node:fs';
import path from 'node:path';
import { TranscriptProjector } from '../../daemon/transcript/TranscriptProjector';
import { scanForTranscript } from '../../daemon/transcript/TranscriptDiscovery';
import type { CodeBlockRequest } from '../../daemon/transcript/types';
import { moaDialogUp } from './moaPaneFeed';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
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
/** How long after main noted a prompt its transcript entry may land: a cold
 *  start waits for the TUI (up to 20 s) and a turn can wait for a slot. */
const PROMPT_MATCH_WINDOW_MS = 120_000;
/** How many entry → prompt assignments are kept so a re-read stays stable. */
const ASSIGNED_MEMORY = 200;
/** Where the remembered prompts live (wmux data dir), so a restart keeps the
 *  questions earlier turns showed. */
const PROMPTS_FILE = 'moa-prompts.json';

/** A prompt main sent to an HQ brain. */
export interface NotedPrompt { at: number; text: string; hq: string }

/** The remembered prompts on disk, or [] (none yet, unreadable, foreign). */
export function parseNotedPrompts(raw: unknown): NotedPrompt[] {
  const list = (raw as { prompts?: unknown } | null)?.prompts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is NotedPrompt =>
      !!p && typeof p === 'object'
      && typeof (p as NotedPrompt).at === 'number' && Number.isFinite((p as NotedPrompt).at)
      && typeof (p as NotedPrompt).text === 'string'
      && typeof (p as NotedPrompt).hq === 'string')
    .slice(-PROMPT_MEMORY);
}

/**
 * The terminal brain types each turn as one paste — the context blocks main
 * builds (rules, policy, decision, active work) with the prompt at the end —
 * so Claude records the whole wire as the user's message, capped by the
 * parser. Shown as-is, the chat would display Moa's instructions as if the
 * operator had typed them. Main knows what was actually asked, so such an
 * entry is shown as the prompt main sent for it:
 *  - an entry that ends with a prompt is that prompt's (a wire typed into a
 *    TUI that is still starting can lose its paste markers and its start);
 *  - else a pasted entry takes the latest prompt noted before it, within
 *    PROMPT_MATCH_WINDOW_MS. Never a prompt noted after it.
 * Each prompt is used once, and `assigned` remembers which entry took which
 * prompt across calls (snapshots and appends see the same entries again).
 */
export function rewritePastedPrompts<P extends { at: number; text: string }>(
  events: readonly TurnEvent[],
  prompts: readonly P[],
  assigned: Map<string, P> = new Map(),
): TurnEvent[] {
  if (prompts.length === 0) return [...events];
  const used = new Set<P>(assigned.values());
  return events.map((e) => {
    if (e.kind !== 'user_text') return e;
    const known = assigned.get(e.id);
    if (known) return known.text === e.text ? e : { ...e, text: known.text };
    const ts = typeof e.ts === 'number' ? e.ts : null;
    const before = (p: P) => ts !== null && p.at <= ts && ts - p.at <= PROMPT_MATCH_WINDOW_MS;
    const tail = e.text.trimEnd();
    let match: P | undefined;
    for (const p of prompts) {
      const text = p.text.trim();
      if (used.has(p) || !text || !tail.endsWith(text) || (ts !== null && !before(p))) continue;
      if (!match || p.at > match.at) match = p;
    }
    if (!match && e.text.includes('<pasted_content')) {
      for (const p of prompts) {
        if (!used.has(p) && before(p) && (!match || p.at > match.at)) match = p;
      }
    }
    if (!match) return e;
    used.add(match);
    assigned.set(e.id, match);
    if (assigned.size > ASSIGNED_MEMORY) assigned.delete(assigned.keys().next().value as string);
    return match.text === e.text ? e : { ...e, text: match.text };
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
  /** The HQ brain's own permission dialog is up. Defaults to moaPaneFeed's. */
  isDialogUp?: () => boolean;
  /** Load / save the remembered prompts. Defaults to `moa-prompts.json`. */
  promptStore?: { load: () => unknown; save: (prompts: NotedPrompt[]) => void };
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
  /** Who in the renderer wants appends (the panel, the titlebar's reply dot).
   *  Appends flow while anyone does, so neither can unsubscribe the other. */
  private readonly subscribers = new Set<string>();
  /** Whether the projector currently holds the renderer's subscription. */
  private armed = false;
  /** Prompts sent to an HQ brain, oldest first; read from disk on first use. */
  private prompts: NotedPrompt[] | null = null;
  /** Transcript entry id → the prompt it was shown as (see rewritePastedPrompts). */
  private readonly assigned = new Map<string, NotedPrompt>();

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
        this.deps.emitAppend({ ...data, events: rewritePastedPrompts(data.events, this.hqPrompts(), this.assigned) });
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
    const status = this.projector.status(SESSION_KEY);
    // The brain's hooks never reach the daemon's approval registry, so the
    // projector cannot know a dialog is up. moaPaneFeed tracks it from the
    // brain's PermissionRequest / PostToolUse hooks for the phone; the chat
    // reads the same state.
    return (this.deps.isDialogUp ?? moaDialogUp)() ? { ...status, agentStatus: 'awaiting_input' } : status;
  }

  snapshot(opts?: { before?: number }): TranscriptPage | null {
    this.sync();
    if (!this.liveBinding()) return null;
    const before = opts?.before;
    const valid = typeof before === 'number' && Number.isFinite(before) && before >= 0;
    const page = this.projector.snapshot(SESSION_KEY, valid ? { before: Math.floor(before) } : undefined);
    return page ? { ...page, events: rewritePastedPrompts(page.events, this.hqPrompts(), this.assigned) } : page;
  }

  /** The prompt main is about to send to a workspace's brain (the operator's
   *  words, or an automation's), remembered for the HQ's chat view. */
  notePrompt(workspaceId: string, text: string, at: number = Date.now()): void {
    if (workspaceId !== this.activeHq() || !text.trim()) return;
    const prompts = this.loadPrompts();
    prompts.push({ at, text, hq: workspaceId });
    if (prompts.length > PROMPT_MEMORY) prompts.splice(0, prompts.length - PROMPT_MEMORY);
    this.promptStore().save(prompts);
  }

  private hqPrompts(): NotedPrompt[] {
    const hq = this.activeHq();
    return this.loadPrompts().filter((p) => p.hq === hq);
  }

  private loadPrompts(): NotedPrompt[] {
    if (!this.prompts) {
      try {
        this.prompts = parseNotedPrompts(this.promptStore().load());
      } catch {
        this.prompts = [];
      }
    }
    return this.prompts;
  }

  private promptStore(): NonNullable<MoaTranscriptDeps['promptStore']> {
    if (this.deps.promptStore) return this.deps.promptStore;
    const file = path.join((this.deps.wmuxDir ?? getWmuxDir)(), PROMPTS_FILE);
    return {
      load: () => JSON.parse(fs.readFileSync(file, 'utf8')),
      save: (prompts) => {
        void atomicWriteJSON(file, { prompts }).catch((err) => {
          this.deps.log?.('warn', `[moa] could not save prompts: ${err instanceof Error ? err.message : String(err)}`);
        });
      },
    };
  }

  /**
   * Start pushing appends for `client`. A repeat subscribe from the same
   * client (a renderer reload) re-arms from scratch so the first push is a
   * reset snapshot rather than an empty delta from a cursor the reloaded
   * renderer never saw; a second client joins the running watch.
   */
  subscribe(client = 'panel'): TranscriptStatus {
    this.sync();
    const hq = this.activeHq();
    if (hq === null) return this.status();
    const repeat = this.subscribers.has(client);
    this.subscribers.add(client);
    if (repeat || this.subscribedHq !== hq) this.disarm();
    this.subscribedHq = hq;
    this.arm();
    return this.status();
  }

  /** One code-block body from the HQ brain's transcript, or null. */
  codeBlock(req: CodeBlockRequest): { body: string } | null {
    this.sync();
    if (!this.liveBinding()) return null;
    return this.projector.codeBlock(SESSION_KEY, req);
  }

  /** Stop pushing for `client`; the watch ends with the last one. */
  unsubscribe(client = 'panel'): void {
    this.subscribers.delete(client);
    if (this.subscribers.size > 0) return;
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
      this.subscribers.clear();
      this.disarm();
    }
  }

  dispose(): void {
    this.binding = null;
    this.subscribedHq = null;
    this.subscribers.clear();
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
