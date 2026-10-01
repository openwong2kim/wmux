// ─── Fresh context per dispatched task: the engine (#1680) ───────────────────
//
// Types the bound agent's fresh-context command (`/clear`, `/new`) into a pane
// before a NEW task's text is delivered, and waits until the pane shows the
// command finished. The policy (two keys, result values, timeouts) is in
// src/shared/freshContext.ts; this file is the sequence and its guards.
//
// Runs in main for both delivery paths: `input.send` with `newTask`
// (terminal_send `new_task`) and the a2a new-task branch's gated submit. Every
// read and write goes through an injected probe, so the whole sequence is
// testable on a fake clock with a scripted pane.
//
// Order, and why:
//   1. The role must ask for it and name an agent with a verified command
//      (else `not_bound`).
//   2. The daemon must know the pane (else `skipped_unobservable`): its
//      canonical agent name, status, input revision and incarnation are the
//      safety proof. A local (pre-adoption) pty has none.
//   3. The agent running there must be the bound one (else
//      `skipped_mismatch`). agentVerified is reported, not required (owner
//      decision: Windows process attribution can fail).
//   4. The agent must be idle per the daemon AND the renderer, and nobody may
//      have typed in the last few seconds (else `skipped_busy`). Busy panes
//      get the text without a clear (owner decision).
//   5. The command is typed (no Enter). The cursor row must then hold exactly
//      a prompt glyph and the command: anything else is a draft someone left in
//      the composer, so the command is erased again and the text delivered
//      without a clear (`skipped_busy`). The daemon's input revision must have
//      moved by exactly our one write, else someone typed alongside us.
//   6. Enter. Then wait for the evidence (below). No evidence within
//      FRESH_CONTEXT_TIMEOUT_MS: FreshContextTimeout, and the caller writes
//      NOTHING else — the pane may still be clearing, and text typed now could
//      land in the old conversation.
//
// Evidence that the command finished, checked every poll after Enter:
//   - always: same incarnation, no input since our Enter, the bound agent is
//     not showing a prompt (`awaiting_input`), the command has left the cursor
//     row, and two screen reads at least FRESH_CONTEXT_SETTLE_MS apart are
//     identical. A running status is NOT disqualifying: the redraw after
//     `/clear` byte-promotes the pane for a moment.
//   - plus a SessionStart hook from the bound agent with a fresh source,
//     received after our Enter → signal `session_start`.
//   - or, without one, the screen alone → signal `screen`. Codex must also
//     show its banner (it redraws it for a new chat, #1610). Claude is held to
//     the hook when its hooks have reported a SessionStart on this pane before
//     (`evidence: 'session_start'`); a pane without hooks falls back to the
//     screen.

import { resolveAgentSlug } from '../../../shared/ptyMessageDelivery';
import { isFreshSessionSource } from '../../../shared/hooks/signal-types';
import type { SessionStartReceipt } from '../../../shared/hooks/HookSignalRouter';
import { freshContextGrammarFor } from '../../../shared/agentLaunchOptions';
import { bindingEnforcesFreshContext, type RoleBinding } from '../../../shared/orchestratorRole';
import {
  FRESH_CONTEXT_POLL_MS,
  FRESH_CONTEXT_SETTLE_MS,
  FRESH_CONTEXT_TIMEOUT_MS,
  type FreshContextReply,
} from '../../../shared/freshContext';
import { drawsCodexBanner } from '../../pty/AgentDetector';

/** The daemon's view of a pane (DaemonClient.getAgentState). */
export interface FreshContextAgentState {
  /** Canonical agent display name or slug, null when no agent is known. */
  agentName: string | null;
  agentVerified: boolean;
  agentStatus: string;
  inputQuiet: boolean;
  inputRevision: number;
  incarnationId: string;
}

/** Everything the engine reads and writes. Injected so tests can script it. */
export interface FreshContextProbe {
  /** Null when the daemon cannot answer for this pane. */
  readAgentState: () => Promise<FreshContextAgentState | null>;
  /** The renderer's status for the pane (mirror snapshot), null when unknown. */
  readMirrorStatus: () => Promise<string | null>;
  /** The screen, ending at the cursor row. '' when it cannot be read. */
  readScreen: () => Promise<string>;
  /** The latest SessionStart hook main received for this pane. */
  readSessionStart: () => SessionStartReceipt | undefined;
  write: (data: string) => void;
}

export interface FreshContextOptions {
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  /** How long the typed command may take to show on the cursor row. */
  echoTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * The caller already knows the conversation must be kept (a2a: the pane has
   * other open tasks pinned to it). A role that asks for fresh context then
   * reports `skipped_busy` with this reason, and nothing is typed.
   */
  keepContext?: string;
}

/** Why each keepContext code keeps the conversation. */
const KEEP_CONTEXT_REASONS: Readonly<Record<string, string>> = {
  open_a2a_task: 'open_a2a_task: the pane has other open a2a tasks pinned to it, so its conversation was kept',
};

/** How long to wait for the typed command to appear on screen. */
const FRESH_CONTEXT_ECHO_TIMEOUT_MS = 1_500;

/**
 * The command was typed and Entered, and the pane never showed it finished.
 * The caller must write nothing else. `code`: `timeout`, `session_changed`
 * (the pane's process was replaced) or `input_interleaved` (someone typed after
 * our Enter, so the composer is no longer known).
 */
export class FreshContextTimeout extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code: 'timeout' | 'session_changed' | 'input_interleaved',
  ) {
    super(message);
    this.name = 'FreshContextTimeout';
  }
}

/** Statuses in which an agent is waiting for its next prompt. */
const READY_STATUSES: ReadonlySet<string> = new Set(['idle', 'waiting', 'complete']);

/** Statuses the renderer reports for a pane that is not free. */
const BUSY_MIRROR_STATUSES: ReadonlySet<string> = new Set(['running', 'awaiting_input']);

/** What a composer frame and a wrap put around typed text: whitespace and
 *  box drawing (same class as the submit receipt's matcher in input.rpc). */
const squash = (s: string): string => s.replace(/[\s─-╿]/g, '');

/** A composer's own prompt glyph at the start of its first row: Claude Code
 *  `>` / `❯`, Codex `›`. */
const PROMPT_GLYPH_RE = /^[>❯›»]/;

/** The cursor row of a cursor-anchored read: its last line. */
export function cursorRow(screen: string): string {
  const lines = screen.replace(/\r/g, '').split('\n');
  return lines[lines.length - 1] ?? '';
}

/**
 * How the cursor row holds the typed command:
 *  - `alone`: a prompt glyph and the command, nothing else — an empty
 *    composer we typed into.
 *  - `with_draft`: the command sits behind other text, or on a continuation
 *    row with no prompt glyph (a multi-line draft above it). Enter would
 *    submit the draft.
 *  - `absent`: not on the cursor row (not echoed yet, or something else drew).
 */
export function commandOnCursorRow(screen: string, command: string): 'alone' | 'with_draft' | 'absent' {
  const row = squash(cursorRow(screen));
  const cmd = squash(command);
  if (!row.endsWith(cmd)) return row.includes(cmd) ? 'with_draft' : 'absent';
  const before = row.slice(0, row.length - cmd.length);
  return PROMPT_GLYPH_RE.test(before) && before.replace(PROMPT_GLYPH_RE, '') === '' ? 'alone' : 'with_draft';
}

/** The Codex banner row anywhere in the read (redrawn for a new chat). */
function showsCodexBanner(screen: string): boolean {
  return screen
    .replace(/\r/g, '')
    .split('\n')
    .some((line) => drawsCodexBanner(line));
}

const skip = (
  freshContext: FreshContextReply['freshContext'],
  reason: string,
): FreshContextReply => ({ freshContext, freshContextReason: reason });

/**
 * Run the fresh-context step for one new-task send. Resolves with what
 * happened (the caller then delivers the text either way), or throws
 * FreshContextTimeout when the command was Entered but never seen to finish
 * (the caller must then deliver nothing).
 */
export async function runFreshContext(
  binding: RoleBinding | undefined,
  probe: FreshContextProbe,
  opts: FreshContextOptions = {},
): Promise<FreshContextReply> {
  const timeoutMs = opts.timeoutMs ?? FRESH_CONTEXT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? FRESH_CONTEXT_POLL_MS;
  const settleMs = opts.settleMs ?? FRESH_CONTEXT_SETTLE_MS;
  const echoTimeoutMs = opts.echoTimeoutMs ?? FRESH_CONTEXT_ECHO_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;

  // 1. Both keys: the caller's signal brought us here; the role must opt in.
  if (!binding) return skip('not_bound', 'no_role_binding: the pane has no role binding');
  const agent = binding.agent;
  const grammar = freshContextGrammarFor(agent);
  if (!bindingEnforcesFreshContext(binding) || !grammar || !agent) {
    return skip(
      'not_bound',
      binding.freshContext !== true
        ? 'role_not_opted_in: the role does not ask for fresh context'
        : `no_command_for_agent: "${agent ?? 'no agent'}" has no verified fresh-context command`,
    );
  }
  const command = grammar.command;
  if (opts.keepContext) {
    return skip('skipped_busy', KEEP_CONTEXT_REASONS[opts.keepContext] ?? `${opts.keepContext}: the conversation was kept`);
  }

  // 2. The daemon's view is the safety proof; without it, do not type.
  const state = await probe.readAgentState();
  if (!state) {
    return skip('skipped_unobservable', 'no_agent_state: the daemon has no state for this pane');
  }

  // 3. Canonical slug match only.
  const live = state.agentName ? resolveAgentSlug(state.agentName) : undefined;
  if (live !== agent) {
    return skip(
      'skipped_mismatch',
      `agent_mismatch: the pane runs ${live ? `"${live}"` : 'no detected agent'} ` +
        `(agentVerified: ${state.agentVerified}), the role is bound to "${agent}"`,
    );
  }

  // 4. Idle on both views, nobody typing.
  if (!READY_STATUSES.has(state.agentStatus)) {
    return skip('skipped_busy', `agent_busy: the agent is ${state.agentStatus}`);
  }
  if (!state.inputQuiet) {
    return skip('skipped_busy', 'input_active: the pane received input in the last few seconds');
  }
  const mirrorStatus = await probe.readMirrorStatus();
  if (mirrorStatus && BUSY_MIRROR_STATUSES.has(mirrorStatus)) {
    return skip('skipped_busy', `agent_busy: the pane shows ${mirrorStatus}`);
  }
  if (!(await probe.readScreen())) {
    return skip('skipped_unobservable', 'screen_unreadable: the pane screen could not be read');
  }
  // Decided before typing: a hook-backed pane is held to the hook.
  const prior = probe.readSessionStart();
  const requireSessionStart = grammar.evidence === 'session_start' && prior?.agent === agent;

  // 5. Type the command, without Enter, and check what it landed next to.
  const erase = (reason: string, result: FreshContextReply['freshContext'] = 'skipped_busy'): FreshContextReply => {
    probe.write('\x7f'.repeat(command.length));
    return skip(result, reason);
  };
  probe.write(command);
  let placement: ReturnType<typeof commandOnCursorRow> = 'absent';
  const echoDeadline = now() + echoTimeoutMs;
  while (placement === 'absent' && now() < echoDeadline) {
    await sleep(pollMs);
    const screen = await probe.readScreen();
    if (screen) placement = commandOnCursorRow(screen, command);
  }
  if (placement === 'with_draft') {
    return erase('draft_in_composer: the composer held other text; the command was erased');
  }
  if (placement === 'absent') {
    return erase('command_not_seen: the typed command never showed on the cursor row; it was erased',
      'skipped_unobservable');
  }
  const typed = await probe.readAgentState();
  if (!typed || typed.incarnationId !== state.incarnationId) {
    return erase('session_changed: the pane changed while the command was typed');
  }
  if (typed.inputRevision !== state.inputRevision + 1) {
    return erase('input_interleaved: other input reached the pane while the command was typed');
  }

  // 6. Enter, then wait for the evidence.
  probe.write('\r');
  const enterAt = now();
  const revisionAfterEnter = state.inputRevision + 2;
  const deadline = enterAt + timeoutMs;
  let lastScreen: string | undefined;
  let lastScreenAt = 0;
  while (now() < deadline) {
    await sleep(pollMs);
    const current = await probe.readAgentState();
    if (!current) continue;
    if (current.incarnationId !== state.incarnationId) {
      throw new FreshContextTimeout(
        `typed ${command} and the pane's session changed before it finished`,
        command,
        'session_changed',
      );
    }
    if (current.inputRevision > revisionAfterEnter) {
      throw new FreshContextTimeout(
        `typed ${command}, and other input reached the pane before it finished`,
        command,
        'input_interleaved',
      );
    }
    if (current.agentStatus === 'awaiting_input') continue;
    const screen = await probe.readScreen();
    if (!screen) continue;
    if (commandOnCursorRow(screen, command) !== 'absent') {
      lastScreen = undefined;
      continue;
    }
    const at = now();
    if (screen !== lastScreen) {
      lastScreen = screen;
      lastScreenAt = at;
      continue;
    }
    if (at - lastScreenAt < settleMs) continue;
    const receipt = probe.readSessionStart();
    if (receipt && receipt.at >= enterAt && receipt.agent === agent && isFreshSessionSource(receipt.source)) {
      return { freshContext: 'applied', freshContextCommand: command, freshContextSignal: 'session_start' };
    }
    if (requireSessionStart) continue;
    if (agent === 'codex' && !showsCodexBanner(screen)) continue;
    return { freshContext: 'applied', freshContextCommand: command, freshContextSignal: 'screen' };
  }
  throw new FreshContextTimeout(
    `typed ${command} and saw no ${requireSessionStart ? 'SessionStart hook' : 'settled screen'} ` +
      `within ${timeoutMs} ms`,
    command,
    'timeout',
  );
}

// ─── Per-pane serialization ─────────────────────────────────────────────────
//
// A new-task send holds its pane from the fresh-context step through the text
// write and the Enter, so a second new-task send to the same pane cannot type
// its command into the first one's half-delivered task. The second one waits
// and then runs its own step against the pane as it is by then (usually busy
// with the first task, so `skipped_busy`). Ordinary sends do not take the
// lock: they never type a command, and a human or another tool typing at the
// same moment is what the input-revision guards above are for.

const paneLocks = new Map<string, Promise<void>>();

export async function withFreshContextLock<T>(ptyId: string, fn: () => Promise<T>): Promise<T> {
  const previous = paneLocks.get(ptyId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  paneLocks.set(ptyId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (paneLocks.get(ptyId) === tail) paneLocks.delete(ptyId);
  }
}
