// ── Moa pane feed (main → daemon) ───────────────────────────────────────────
//
// A paired phone may reach the Moa (HQ brain) pane's turns, chat and input,
// and the daemon decides that from one fact it cannot derive itself: which
// daemon session is the HQ brain's TUI, while Moa is on and its HQ is present.
// The deck handler owns those three facts (master switch, HQ presence, brain
// pty map) and registers a `source`; this module pushes the answer over
// `daemon.moa.set` every time any of them can have changed. Withdrawals go out
// at once (no debounce): they are what revokes the phone's access.
//
// The brain's hooks go to main, never to the daemon (`WMUX_HOOKS_TO_MAIN`), so
// the daemon has no transcript binding for that pane and could not serve its
// turns. The binding the brain's own SessionStart/Stop signals carry is noted
// here and rides along with the pane, for that one session only.
//
// Never pushed: the commander token, the brain's env or its hook/MCP config.
// The payload is the two ids and the transcript binding, nothing else.

/** The slice of a hook signal (`AgentSignal`) this module reads. */
export interface BrainHookSignal {
  kind: string;
  agent: string;
  agentSessionId?: string;
  ptyId?: string;
  cwd: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface MoaPaneSource {
  /** The HQ brain's daemon session. */
  sessionId: string;
  /** The HQ workspace. */
  workspaceId: string;
}

export interface MoaPaneBinding {
  agent: 'claude';
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  ts: number;
}

export type MoaPanePayload = (MoaPaneSource & { binding?: MoaPaneBinding }) | null;

type Push = (pane: MoaPanePayload, seq: number) => Promise<unknown>;

/** A brain pty is one per workspace and an HQ means one live brain, so a
 *  handful of entries is all this ever holds; the cap only bounds a leak. */
const MAX_BINDINGS = 32;

const bindings = new Map<string, MoaPaneBinding>();
let source: (() => MoaPaneSource | null) | null = null;
let push: Push | null = null;
let seq = 0;
let lastSent: string | null = null;
let inFlight: Promise<void> | null = null;
let again = false;

/** The deck handler's answer to "which session is the Moa pane right now". */
export function setMoaPaneSource(fn: () => MoaPaneSource | null): () => void {
  source = fn;
  return () => {
    if (source === fn) source = null;
  };
}

/** The daemon transport (main/index.ts). */
export function setMoaPanePush(fn: Push | null): void {
  push = fn;
}

/**
 * A brain pty's hook signal: remember the transcript it names. Called for every
 * signal the brain lane claimed; only the session-lifecycle kinds carry one.
 */
export function noteBrainHookSignal(signal: BrainHookSignal): void {
  const ptyId = signal.ptyId;
  if (!ptyId || signal.agent !== 'claude' || !signal.agentSessionId || !signal.cwd) return;
  if (signal.kind !== 'agent.session_start' && signal.kind !== 'agent.stop' && signal.kind !== 'agent.subagent_stop') return;
  const raw = signal.payload?.transcript_path;
  const prev = bindings.get(ptyId);
  // SessionStart may come without a path; keep the one a Stop of the same
  // conversation already gave rather than dropping back to none.
  const transcriptPath = typeof raw === 'string' && raw.length > 0
    ? raw
    : prev?.sessionId === signal.agentSessionId ? prev.transcriptPath : undefined;
  bindings.delete(ptyId);
  bindings.set(ptyId, {
    agent: 'claude',
    sessionId: signal.agentSessionId,
    cwd: signal.cwd,
    ...(transcriptPath ? { transcriptPath } : {}),
    ts: signal.ts,
  });
  while (bindings.size > MAX_BINDINGS) {
    const oldest = bindings.keys().next();
    if (oldest.done) break;
    bindings.delete(oldest.value);
  }
  if (source?.()?.sessionId === ptyId) void publishMoaPane();
}

/** A brain pty is gone: its binding goes with it. */
export function forgetBrainPty(ptyId: string): void {
  bindings.delete(ptyId);
}

/** What the daemon should hold now. A throwing source is "no Moa pane". */
export function buildMoaPanePayload(): MoaPanePayload {
  let pane: MoaPaneSource | null = null;
  try {
    pane = source?.() ?? null;
  } catch (err) {
    console.warn(`[moa] could not read the Moa pane: ${String(err)}`);
  }
  if (!pane) return null;
  const binding = bindings.get(pane.sessionId);
  return { sessionId: pane.sessionId, workspaceId: pane.workspaceId, ...(binding ? { binding } : {}) };
}

/**
 * Push the current answer unless it is what the daemon already holds. `force`
 * re-sends anyway — the connect-time seed, since a new daemon (or one whose
 * publisher just reconnected) holds nothing. One push at a time, latest wins;
 * every push carries a fresh `seq`, so the daemon drops one serviced late.
 */
export function publishMoaPane(opts: { force?: boolean } = {}): Promise<void> {
  if (opts.force) lastSent = null;
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      again = false;
      const payload = buildMoaPanePayload();
      const key = JSON.stringify(payload);
      if (key === lastSent || !push) continue;
      seq += 1;
      try {
        await push(payload, seq);
        lastSent = key;
      } catch (err) {
        // The daemon keeps what it had; the next change (or reconnect) retries.
        lastSent = null;
        console.warn(`[moa] could not publish the Moa pane: ${String(err)}`);
      }
    } while (again);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Tests only. */
export function __resetMoaPaneFeedForTest(): void {
  bindings.clear();
  source = null;
  push = null;
  seq = 0;
  lastSent = null;
  inFlight = null;
  again = false;
}
