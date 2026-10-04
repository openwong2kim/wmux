// ── Moa pane feed (main → daemon) ───────────────────────────────────────────
//
// A paired phone may reach the Moa (HQ brain) pane's turns, chat and input,
// and the daemon decides that from one fact it cannot derive itself: which
// daemon session is the HQ brain's TUI, while Moa is on and its HQ is present.
// The deck handler owns those three facts (master switch, HQ presence, brain
// pty map) and registers a `source`; this module pushes the answer over
// `daemon.moa.set` every time any of them can have changed. Withdrawals go out
// at once (no debounce) and are retried until the daemon applied them: they
// are what revokes the phone's access.
//
// The brain's hooks go to main, never to the daemon (`WMUX_HOOKS_TO_MAIN`), so
// two things only main can see ride along with the pane:
//   - the transcript binding the brain's own SessionStart/Stop carry, so the
//     daemon can serve the pane's turns. Hook payloads are not trusted as
//     given: a binding is used only when its cwd is the brain home main
//     spawned the TUI in and its path is that cwd's Claude project file for
//     the reported conversation, and an older hook never replaces a newer one;
//   - whether the brain's own permission dialog is up (its PermissionRequest
//     hook), so the daemon can refuse typed input that would answer it, and
//     the hook's evidence for that dialog (tool name, whole tool input, the
//     hook's tool_use / session / prompt ids), so the daemon can raise it as a
//     `terminal_prompt` approval record bound to that exact call (#1772).
//
// Never pushed: the commander token, the brain's env or its hook/MCP config.
// The payload is the two ids, the transcript binding and the dialog.

import { createHash } from 'node:crypto';
import path from 'node:path';

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
  /** The directory main spawned the HQ brain's TUI in (its brain home). */
  brainCwd: string;
}

export interface MoaPaneBinding {
  agent: 'claude';
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  ts: number;
}

/**
 * The permission dialog that is up, with the PermissionRequest hook's evidence
 * for it. The daemon binds an answer to the WHOLE tool input by hash, so an
 * input too big to send is omitted, never cut: the card is then one the phone
 * and the desktop cannot answer, only point at the terminal.
 */
export interface MoaPaneDialog {
  fingerprint: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  hookSessionId?: string;
  promptId?: string;
}

export type MoaPanePayload =
  | { sessionId: string; workspaceId: string; binding?: MoaPaneBinding; dialog?: MoaPaneDialog }
  | null;

type Push = (pane: MoaPanePayload, seq: number) => Promise<unknown>;

interface BrainState {
  binding?: MoaPaneBinding;
  /** The permission dialog that is up, if one is. */
  dialog?: MoaPaneDialog;
}

/** A brain pty is one per workspace and an HQ means one live brain, so a
 *  handful of entries is all this ever holds; the cap only bounds a leak. */
const MAX_BRAINS = 32;
/** The largest serialized tool input pushed with a dialog. Bigger is omitted. */
export const MOA_DIALOG_INPUT_MAX_BYTES = 8 * 1024;
/** Bounds on the hook's ids and tool name; longer is not something to bind to. */
const MAX_DIALOG_ID_CHARS = 128;
/** Retry delays for a push the daemon did not apply. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;

const brains = new Map<string, BrainState>();
let source: (() => MoaPaneSource | null) | null = null;
let push: Push | null = null;
let seq = 0;
let lastSent: string | null = null;
let inFlight: Promise<void> | null = null;
let again = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_BASE_MS;

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

function stateFor(ptyId: string): BrainState {
  let state = brains.get(ptyId);
  if (!state) {
    state = {};
    brains.set(ptyId, state);
    while (brains.size > MAX_BRAINS) {
      const oldest = brains.keys().next();
      if (oldest.done) break;
      brains.delete(oldest.value);
    }
  }
  return state;
}

/** A fingerprint of the dialog's tool call — never the call itself. */
function dialogFingerprint(payload: Record<string, unknown>): string {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  let input = '';
  try {
    input = JSON.stringify(payload.tool_input ?? null);
  } catch {
    input = '';
  }
  return createHash('sha256').update(`${tool}\0${input}`).digest('hex').slice(0, 32);
}

function dialogId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DIALOG_ID_CHARS ? value : undefined;
}

/**
 * The dialog and the PermissionRequest hook's evidence for it, read from the
 * same payload fields the daemon's HookIngest reads for every other pane.
 */
function dialogFrom(payload: Record<string, unknown>): MoaPaneDialog {
  const toolName = dialogId(payload.tool_name);
  const raw = payload.tool_input;
  let toolInput: Record<string, unknown> | undefined;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      const json = JSON.stringify(raw);
      if (Buffer.byteLength(json, 'utf8') <= MOA_DIALOG_INPUT_MAX_BYTES) toolInput = JSON.parse(json) as Record<string, unknown>;
    } catch {
      toolInput = undefined;
    }
  }
  const toolUseId = dialogId(payload.tool_use_id);
  const hookSessionId = dialogId(payload.session_id);
  const promptId = dialogId(payload.prompt_id);
  return {
    fingerprint: dialogFingerprint(payload),
    ...(toolName ? { toolName } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(hookSessionId ? { hookSessionId } : {}),
    ...(promptId ? { promptId } : {}),
  };
}

/**
 * A brain pty's hook signal: note the permission dialog and the transcript it
 * names. Called for every signal the brain lane claimed.
 */
export function noteBrainHookSignal(signal: BrainHookSignal): void {
  const ptyId = signal.ptyId;
  if (!ptyId || signal.agent !== 'claude') return;
  const state = stateFor(ptyId);
  let changed = false;
  if (signal.kind === 'agent.awaiting_input') {
    // The brain profile maps only PermissionRequest to this kind, so for a
    // brain it is its own permission dialog drawn on screen.
    state.dialog = dialogFrom(signal.payload ?? {});
    changed = true;
  } else if (
    signal.kind === 'agent.stop' || signal.kind === 'agent.stop_failure'
    || signal.kind === 'agent.user_prompt_submit' || signal.kind === 'agent.session_start'
    || signal.kind === 'agent.activity'
  ) {
    // The turn ended, a new prompt was taken, a new session started, or a
    // tool ran (PostToolUse: the human allowed it): no dialog is waiting.
    if (state.dialog !== undefined) {
      delete state.dialog;
      changed = true;
    }
  }
  if (
    (signal.kind === 'agent.session_start' || signal.kind === 'agent.stop' || signal.kind === 'agent.subagent_stop')
    && signal.agentSessionId && signal.cwd && Number.isFinite(signal.ts)
  ) {
    const prev = state.binding;
    // A late hook from the conversation a `/clear` already left behind must
    // not replace the newer one (same rule as the daemon's applyResumeBinding).
    if (!prev || signal.ts >= prev.ts) {
      const raw = signal.payload?.transcript_path;
      // SessionStart may come without a path; keep the one a Stop of the same
      // conversation already gave rather than dropping back to none.
      const transcriptPath = typeof raw === 'string' && raw.length > 0
        ? raw
        : prev?.sessionId === signal.agentSessionId ? prev.transcriptPath : undefined;
      state.binding = {
        agent: 'claude',
        sessionId: signal.agentSessionId,
        cwd: signal.cwd,
        ...(transcriptPath ? { transcriptPath } : {}),
        ts: signal.ts,
      };
      changed = true;
    }
  }
  if (changed && currentSource()?.sessionId === ptyId) void publishMoaPane();
}

/**
 * The HQ brain's own permission dialog is on screen. The one source for both
 * the phone's typed-input fence (via the published payload) and Moa's desktop
 * chat (its transcript status reads `awaiting_input`).
 */
export function moaDialogUp(): boolean {
  const src = currentSource();
  return !!src && brains.get(src.sessionId)?.dialog !== undefined;
}

/** A brain pty is gone: its binding and dialog go with it. */
export function forgetBrainPty(ptyId: string): void {
  brains.delete(ptyId);
}

/** Claude Code's project directory name for a cwd. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The binding, only when it can be the brain's own conversation: reported
 * from the brain home main spawned the TUI in, and naming
 * `…/projects/<slug(brain home)>/<conversation>.jsonl`. Anything else is
 * dropped, so the phone shows no transcript rather than a forged one.
 */
function trustedBinding(binding: MoaPaneBinding | undefined, brainCwd: string): MoaPaneBinding | undefined {
  if (!binding || binding.cwd !== brainCwd) return undefined;
  if (binding.transcriptPath === undefined) return binding;
  const file = binding.transcriptPath;
  if (!path.isAbsolute(file) || path.normalize(file) !== file) return undefined;
  const project = path.dirname(file);
  if (path.basename(file) !== `${binding.sessionId}.jsonl`) return undefined;
  if (path.basename(project) !== claudeProjectSlug(brainCwd)) return undefined;
  if (path.basename(path.dirname(project)) !== 'projects') return undefined;
  return binding;
}

function currentSource(): MoaPaneSource | null {
  try {
    return source?.() ?? null;
  } catch (err) {
    console.warn(`[moa] could not read the Moa pane: ${String(err)}`);
    return null;
  }
}

/** What the daemon should hold now. A throwing source is "no Moa pane". */
export function buildMoaPanePayload(): MoaPanePayload {
  const pane = currentSource();
  if (!pane) return null;
  const state = brains.get(pane.sessionId);
  const binding = trustedBinding(state?.binding, pane.brainCwd);
  return {
    sessionId: pane.sessionId,
    workspaceId: pane.workspaceId,
    ...(binding ? { binding } : {}),
    ...(state?.dialog ? { dialog: { ...state.dialog } } : {}),
  };
}

function applied(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === true;
}

function scheduleRetry(): void {
  if (retryTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void publishMoaPane();
  }, delay);
  retryTimer.unref?.();
}

/**
 * Push the current answer unless it is what the daemon already holds. `force`
 * re-sends anyway — the connect-time seed, since a new daemon (or one whose
 * publisher just reconnected) holds nothing. One push at a time, latest wins;
 * every push carries a fresh `seq`, so the daemon drops one serviced late. A
 * push the daemon did not answer `ok` (thrown, refused, no transport) is
 * retried with backoff until one is, whatever it carried — a withdrawal most
 * of all.
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
      if (key === lastSent) continue;
      if (!push) {
        scheduleRetry();
        continue;
      }
      seq += 1;
      let result: unknown;
      try {
        result = await push(payload, seq);
      } catch (err) {
        result = { ok: false, error: String(err) };
      }
      if (applied(result)) {
        lastSent = key;
        retryDelay = RETRY_BASE_MS;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      } else {
        lastSent = null;
        console.warn(`[moa] the daemon did not take the Moa pane: ${JSON.stringify(result)}`);
        scheduleRetry();
      }
    } while (again);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Tests only. */
export function __resetMoaPaneFeedForTest(): void {
  brains.clear();
  source = null;
  push = null;
  seq = 0;
  lastSent = null;
  inFlight = null;
  again = false;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_BASE_MS;
}
