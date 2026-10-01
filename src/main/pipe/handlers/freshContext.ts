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
//      (else `not_bound`). A caller that knows the conversation must be kept
//      (a2a: other open tasks on the pane, or open tasks that cannot be read)
//      gets `skipped_busy` with nothing typed.
//   2. The daemon must know the pane (else `skipped_unobservable`): its
//      canonical agent name, status, key-input counter and incarnation are the
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
//      without a clear (`skipped_busy`). The daemon's key-input counter must
//      have moved by exactly our one write. If someone typed alongside us,
//      the send fails with nothing more written: erasing would delete their
//      characters, not ours.
//   6. Enter. Then wait for the evidence (below). No evidence within
//      FRESH_CONTEXT_TIMEOUT_MS: FreshContextTimeout, and the caller writes
//      NOTHING else — the pane may still be clearing, and text typed now could
//      land in the old conversation.
//
// "Typed" means KEY input: the daemon's key-only counter, which focus reports
// and pointer-motion reports do not move. Agents turn on any-motion mouse
// tracking and focus reporting, so the all-writes counter moved whenever the
// operator's pointer crossed the pane. An older daemon without the key counter
// falls back to the all-writes one: conservative (a pointer can make the step
// skip or fail), never permissive.
//
// Evidence that the command finished, checked every poll after Enter:
//   - always: same incarnation, no key input since our Enter, the bound agent
//     is not showing a prompt (`awaiting_input`), the command has left the
//     cursor row, and two screen reads at least FRESH_CONTEXT_SETTLE_MS apart
//     are identical. A running status is NOT disqualifying: the redraw after
//     `/clear` byte-promotes the pane for a moment.
//   - plus a SessionStart hook from the bound agent with a fresh source,
//     received after our Enter → signal `session_start`.
//   - or the screen → signal `screen`. The screen above the cursor row must
//     differ from what it was before the command (the old conversation is
//     gone), and Codex must show its banner (it redraws it for a new chat,
//     #1610). A screen that looks exactly as before (an already-empty
//     conversation) counts only after holding still for
//     FRESH_CONTEXT_UNCHANGED_HOLD_MS (reason `screen_unchanged`), and never
//     when the daemon confirms the agent's hooks work, nor on a Codex pane
//     that showed a conversation before the command.
//   - Claude's hooks report `/clear` as SessionStart(clear), so a pane whose
//     CURRENT agent has reported hooks (main holds a receipt from it, and the
//     daemon, when it can tell, says that agent's hooks reported) waits for
//     the hook first — but only FRESH_CONTEXT_HOOK_GRACE_MS past the screen
//     evidence, then takes the screen (reason `session_start_missing`). A
//     receipt left by an earlier run of the agent, or hooks that stopped
//     reaching wmux, cost a few seconds, never the task.

import { resolveAgentSlug } from '../../../shared/ptyMessageDelivery';
import { isFreshSessionSource } from '../../../shared/hooks/signal-types';
import type { SessionStartReceipt } from '../../../shared/hooks/HookSignalRouter';
import { freshContextGrammarFor } from '../../../shared/agentLaunchOptions';
import { bindingEnforcesFreshContext, type RoleBinding } from '../../../shared/orchestratorRole';
import {
  FRESH_CONTEXT_HOOK_GRACE_MS,
  FRESH_CONTEXT_LOCK_WAIT_MS,
  FRESH_CONTEXT_POLL_MS,
  FRESH_CONTEXT_SETTLE_MS,
  FRESH_CONTEXT_TIMEOUT_MS,
  FRESH_CONTEXT_UNCHANGED_HOLD_MS,
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
  /** Key input only (focus and pointer-motion reports excluded). Absent on an
   *  older daemon. */
  keyInputRevision?: number;
  keyInputQuiet?: boolean;
  /** The pane's CURRENT agent has delivered a hook. Absent on an older
   *  daemon. */
  hookReports?: boolean;
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

/** Why a caller wants the conversation kept (see KEEP_CONTEXT_REASONS). */
export type KeepContextCode = 'open_a2a_task' | 'a2a_tasks_unknown';

export interface FreshContextOptions {
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  hookGraceMs?: number;
  unchangedHoldMs?: number;
  /** How long the typed command may take to show on the cursor row. */
  echoTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * The conversation must be kept (a2a: the pane has other open tasks pinned to
   * it, or its open tasks cannot be read). A role that asks for fresh context
   * then reports `skipped_busy` with this reason, and nothing is typed. A
   * function is asked only when the role does ask, so an unbound pane costs no
   * lookup.
   */
  keepContext?: KeepContextCode | (() => Promise<KeepContextCode | undefined>);
}

/** Why each keepContext code keeps the conversation. */
const KEEP_CONTEXT_REASONS: Readonly<Record<KeepContextCode, string>> = {
  open_a2a_task: 'open_a2a_task: the pane has other open a2a tasks pinned to it, so its conversation was kept',
  a2a_tasks_unknown:
    'a2a_tasks_unknown: the open a2a tasks for this pane could not be read, so its conversation was kept',
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

/** Another new-task send held the pane for longer than
 *  FRESH_CONTEXT_LOCK_WAIT_MS. Nothing was written. */
export class FreshContextBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreshContextBusy';
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

function screenLines(screen: string): string[] {
  return screen.replace(/\r/g, '').split('\n');
}

/** The cursor row of a cursor-anchored read: its last line. */
export function cursorRow(screen: string): string {
  const lines = screenLines(screen);
  return lines[lines.length - 1] ?? '';
}

/** Everything above the cursor row, trailing blanks ignored per line. */
function aboveCursorRow(screen: string): string {
  return screenLines(screen)
    .slice(0, -1)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
}

/**
 * How the cursor row holds the typed command:
 *  - `alone`: a prompt glyph and the command, nothing else — an empty
 *    composer we typed into.
 *  - `with_draft`: the command sits behind other text, or on a continuation
 *    row with no prompt glyph (a multi-line draft above it). Enter would
 *    submit the draft.
 *  - `absent`: not on the cursor row (not echoed yet, or something else drew).
 *
 * Plain text only: the read carries no styling, so Claude Code's dimmed
 * prompt suggestion (ghost text such as `❯ make the button blue`, drawn after
 * the caret) cannot be told from typed text. That does not matter here: typing
 * replaces the suggestion, so the row reads `❯ /clear`. If an agent ever kept
 * ghost text next to the typed command, the row reads as a draft and the step
 * conservatively erases the command and skips.
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
  return screenLines(screen).some((line) => drawsCodexBanner(line));
}

/**
 * Does a Codex screen show a conversation with nothing in it yet: its banner,
 * and above the input line no transcript row? Codex draws a submitted prompt
 * as `› …` and the agent's items as `• …` (0.157.1 capture). A heuristic, used
 * only to allow the unchanged-screen fallback, never to skip the clear.
 */
export function codexConversationLooksEmpty(screen: string): boolean {
  if (!showsCodexBanner(screen)) return false;
  return !screenLines(screen)
    .slice(0, -1)
    .some((line) => /^\s*[›•]/.test(line));
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
  const hookGraceMs = opts.hookGraceMs ?? FRESH_CONTEXT_HOOK_GRACE_MS;
  const unchangedHoldMs = opts.unchangedHoldMs ?? FRESH_CONTEXT_UNCHANGED_HOLD_MS;
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
  const keep = typeof opts.keepContext === 'function' ? await opts.keepContext() : opts.keepContext;
  if (keep) return skip('skipped_busy', KEEP_CONTEXT_REASONS[keep]);

  // 2. The daemon's view is the safety proof; without it, do not type.
  const state = await probe.readAgentState();
  if (!state) {
    return skip('skipped_unobservable', 'no_agent_state: the daemon has no state for this pane');
  }
  // Key input when the daemon reports it, every write otherwise (see the head).
  const useKeyCounter = typeof state.keyInputRevision === 'number';
  const revision = (s: FreshContextAgentState): number =>
    useKeyCounter && typeof s.keyInputRevision === 'number' ? s.keyInputRevision : s.inputRevision;
  const quiet = typeof state.keyInputQuiet === 'boolean' ? state.keyInputQuiet : state.inputQuiet;

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
  if (!quiet) {
    return skip('skipped_busy', 'input_active: the pane received key input in the last few seconds');
  }
  const mirrorStatus = await probe.readMirrorStatus();
  if (mirrorStatus && BUSY_MIRROR_STATUSES.has(mirrorStatus)) {
    return skip('skipped_busy', `agent_busy: the pane shows ${mirrorStatus}`);
  }
  // A few tries: one slow renderer read should not cost the whole step. The
  // read is also the "before" the screen evidence must differ from.
  let before = '';
  for (let attempt = 0; attempt < 3 && !before; attempt++) {
    if (attempt > 0) await sleep(pollMs);
    before = await probe.readScreen();
  }
  if (!before) {
    return skip('skipped_unobservable', 'screen_unreadable: the pane screen could not be read');
  }
  const beforeAbove = aboveCursorRow(before);
  // Decided before typing: the current agent's hooks report SessionStart, so
  // wait for the hook first. A receipt alone could be an earlier run's; the
  // daemon's flag, when present, says the current agent's hooks reported.
  const prior = probe.readSessionStart();
  const preferHook = grammar.evidence === 'session_start' && prior?.agent === agent && state.hookReports !== false;
  // May a screen that looks exactly as before count, after a long still hold?
  // Not when the daemon confirms the current agent's hooks work: then the
  // fresh SessionStart arrives in the legitimate case, so wait for it (or a
  // changed screen). Not for Codex unless the conversation was already empty:
  // its banner usually stays on screen, so "unchanged" proves nothing there.
  const unchangedAllowed =
    state.hookReports !== true && (agent !== 'codex' || codexConversationLooksEmpty(before));

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
  // Ordering note: the command went out on the session's data pipe and this
  // read goes over the daemon's control pipe, so the transport does not order
  // them. The echo wait above does: the renderer shows the command only after
  // the daemon took the write (and counted it). If live use ever reports
  // `input_interleaved` with nobody typing, look here first — and at terminal
  // query replies (cursor position, device attributes), which the key counter
  // still counts.
  const typed = await probe.readAgentState();
  if (!typed) {
    return erase('state_unreadable: the pane state could not be read after the command was typed; it was erased',
      'skipped_unobservable');
  }
  if (typed.incarnationId !== state.incarnationId) {
    return erase('session_changed: the pane changed while the command was typed');
  }
  if (revision(typed) !== revision(state) + 1) {
    // An older daemon counts every write, so this may be just a pointer or a
    // focus report: erase our command and deliver without a clear, as before.
    if (!useKeyCounter) {
      return erase('input_interleaved: other input reached the pane while the command was typed');
    }
    // Someone TYPED alongside the command. Erasing would remove their last
    // characters, not ours, and leave a fragment such as `/c` for the task to
    // land on. So nothing more is written, and the send fails.
    throw new FreshContextTimeout(
      `typed ${command}, and other key input reached the pane before its Enter; nothing further was written ` +
        '(the command may still be in the input line)',
      command,
      'input_interleaved',
    );
  }

  // 6. Enter, then wait for the evidence.
  probe.write('\r');
  const enterAt = now();
  const revisionAfterEnter = revision(state) + 2;
  const deadline = enterAt + timeoutMs;
  let lastScreen: string | undefined;
  let lastScreenAt = 0;
  const applied = (signal: 'session_start' | 'screen', reason?: string): FreshContextReply => ({
    freshContext: 'applied',
    freshContextCommand: command,
    freshContextSignal: signal,
    ...(reason ? { freshContextReason: reason } : {}),
  });
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
    if (revision(current) > revisionAfterEnter) {
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
    // How long this exact screen has held.
    const held = at - lastScreenAt;
    if (held < settleMs) continue;
    const receipt = probe.readSessionStart();
    if (receipt && receipt.at >= enterAt && receipt.agent === agent && isFreshSessionSource(receipt.source)) {
      return applied('session_start');
    }
    if (agent === 'codex' && !showsCodexBanner(screen)) continue;
    const changed = aboveCursorRow(screen) !== beforeAbove;
    if (!changed && !unchangedAllowed) continue;
    const needed = Math.max(changed ? settleMs : unchangedHoldMs, preferHook ? settleMs + hookGraceMs : 0);
    if (held < needed) continue;
    const reasons = [
      ...(preferHook ? ['session_start_missing: no SessionStart hook arrived; the settled screen was used'] : []),
      ...(changed ? [] : ['screen_unchanged: the pane looked the same as before the command (an empty conversation)']),
    ];
    return applied('screen', reasons.length > 0 ? reasons.join('; ') : undefined);
  }
  throw new FreshContextTimeout(
    `typed ${command} and saw no ${preferHook ? 'SessionStart hook or ' : ''}settled screen within ${timeoutMs} ms`,
    command,
    'timeout',
  );
}

// ─── Per-pane serialization ─────────────────────────────────────────────────
//
// A new-task send holds its pane from the fresh-context step through the text
// write and the Enter, so a second new-task send to the same pane cannot type
// its command into the first one's half-delivered task. The second one waits —
// at most FRESH_CONTEXT_LOCK_WAIT_MS, so it can never outlive its caller and
// deliver behind a retry — and then runs its own step against the pane as it
// is by then (usually busy with the first task, so `skipped_busy`). Past the
// wait it fails with FreshContextBusy, before writing anything. Ordinary sends
// do not take the lock: they never type a command, and a human or another tool
// typing at the same moment is what the key-input guards above are for.

const paneLocks = new Map<string, Promise<void>>();

export async function withFreshContextLock<T>(
  ptyId: string,
  fn: () => Promise<T>,
  waitMs: number = FRESH_CONTEXT_LOCK_WAIT_MS,
): Promise<T> {
  const previous = paneLocks.get(ptyId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  paneLocks.set(ptyId, tail);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const acquired = await Promise.race([
    previous.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!acquired) {
    // Give up our place without blocking anyone behind us: they still wait
    // for `previous`, which is the send actually holding the pane.
    release();
    throw new FreshContextBusy(
      `another new-task send is still running on this pane (waited ${waitMs} ms); nothing was written`,
    );
  }
  try {
    return await fn();
  } finally {
    release();
    if (paneLocks.get(ptyId) === tail) paneLocks.delete(ptyId);
  }
}
