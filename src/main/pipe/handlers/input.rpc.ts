import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { PTYManager } from '../../pty/PTYManager';
import type { DaemonClient } from '../../DaemonClient';
import { sendToRenderer } from './_bridge';
import { sanitizePtyText } from '../../../shared/types';
import { applyRoleBinding, type RoleBinding } from '../../../shared/orchestratorRole';
import { isGateHeldOn } from '../../deck/stopGateState';
import {
  approvalBlockMessage,
  pendingApprovalOnPane,
  pressBlockLift,
} from './approvals.rpc';
import {
  assertWorkspaceOwnsPty,
  resolvePtyOwnerWorkspace,
  resolveRoleBindingForPty,
} from '../../workspace/ptyOwnership';
import { getWorkspaceMirror } from '../../workspace/WorkspaceMirror';

type GetWindow = () => BrowserWindow | null;

/**
 * Delay between the text write and the trailing carriage return on a submit.
 * See the two-write rationale in the input.send handler. Small but non-zero so
 * the PTY slave gets its OWN read for the text before the Enter arrives — a
 * fused `text\r` chunk is read as a multi-line PASTE by TUI editors (Claude
 * Code / ink) and lands the \r as a soft newline instead of submitting.
 * Live-tunable if a TUI still coalesces at 20ms on a slow host.
 *
 * The value has not been re-measured against a live Claude pane in this
 * change, and it no longer needs to be tuned blind: a delay too short for the
 * host now shows up as `accepted:false` and re-sends the Enter (see the submit
 * receipt below), instead of silently stranding the prompt in the composer.
 * The number to raise, if a host is found where the retry keeps firing, is
 * this one.
 */
const SUBMIT_ENTER_DELAY_MS = 20;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Submit receipt (orchestrator track, 2026-09-04)
// ---------------------------------------------------------------------------
//
// `submitted: true` used to mean "we wrote a \r", which is not a receipt: the
// orchestrator read it as "the agent got my prompt" and reported progress on
// panes that were still sitting on an uncommitted line. Raw PTY byte activity
// is not a receipt either — a TUI echoes every keystroke and repaints its
// cursor, so bytes flow whether or not anything was committed.
//
// Two signals are accepted, both of which require the pane to have MOVED:
//   (a) turn start — the pane's agentStatus goes to `running`, from a status
//       that was not a turn, reported by a mirror snapshot taken AFTER our \r.
//   (b) composer cleared — the text we just typed has LEFT the composer area
//       at the bottom of the screen. Positional (see `rowFromBottom`), because
//       a TUI like Claude Code re-renders the submitted prompt into its
//       transcript: the string is still on screen, just no longer down there.
//
// Both are narrower than they look, and deliberately:
//   - `running → awaiting_input` is NOT a turn start. It is what a PREVIOUS
//     turn ending inside our window looks like.
//   - agentStatus is byte-promoted (#935), so the pane's own echo of our text
//     can flip it to running before anything was submitted. That is why the
//     snapshot has to be newer than the \r, not merely different.
//   - "the needle moved up one row" is NOT acceptance. That is precisely the
//     soft-newline failure this whole change exists to catch (the composer
//     grew a line and pushed our text up), and background output does it too.
//     Only leaving the composer area counts.

/** How long a submit waits for a receipt before retrying the Enter. */
const SUBMIT_RECEIPT_WINDOW_MS = 400;

/** Poll interval while waiting for a receipt. */
const SUBMIT_RECEIPT_POLL_MS = 50;

/**
 * Hard ceiling on the whole receipt wait, retry included. An MCP client gives
 * a tool call ~10s; a submit that spent most of that budget waiting would turn
 * a working send into a client-side timeout, which is a worse answer than an
 * honest `accepted:false`.
 */
const SUBMIT_RECEIPT_MAX_TOTAL_MS = 2_000;

/** Per-poll viewport read budget. Short on purpose: a screen we cannot get
 *  quickly is a poll we skip, not a submit we stall. */
const SUBMIT_RECEIPT_READ_TIMEOUT_MS = 300;

/** Viewport rows pulled per poll. The composer and its framing live in the
 *  last handful of rows; the scrollback is irrelevant here. */
const SUBMIT_RECEIPT_READ_LINES = 20;

/** Screen lines handed back when no receipt arrived, so the caller can see
 *  what the pane is actually showing instead of guessing. */
const SUBMIT_RECEIPT_TAIL_LINES = 10;

/**
 * How far up from the bottom the input line can be. A TUI frames its composer
 * (border, hint row, mode line), so the typed text sits a few rows above the
 * true bottom; anything further up is transcript, not composer.
 */
export const COMPOSER_AREA_ROWS = 6;

/** Statuses that are NOT a turn — a move from one of these into `running` is a
 *  turn starting. `running → awaiting_input` is the previous turn ending. */
const NON_TURN_STATUSES: ReadonlySet<string> = new Set([
  'idle',
  'waiting',
  'complete',
  'error',
]);

/** Length of the trailing slice of the submitted text used to locate the
 *  composer line. Long enough to be unique in a viewport, short enough that a
 *  wrapped prompt still has the whole needle on its LAST visual row. */
const SUBMIT_NEEDLE_CHARS = 24;

/**
 * The fragment of the submitted text we look for on screen. The TAIL, not the
 * head: a prompt long enough to wrap puts its head on an earlier visual row,
 * and only the tail is guaranteed to sit on the composer's last row. Collapsed
 * whitespace, because a TUI re-flows the line it renders.
 */
export function submitNeedle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUBMIT_NEEDLE_CHARS ? flat.slice(-SUBMIT_NEEDLE_CHARS) : flat;
}

/**
 * How many lines up from the last non-empty line of the screen the needle last
 * appears; -1 when it is not on screen at all. This is the whole trick behind
 * "did the composer clear": the input line is the bottom-most place the text
 * can be, so a submitted prompt can only move UP.
 */
export function rowFromBottom(screen: string, needle: string): number {
  if (!needle) return -1;
  const lines = screen.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.replace(/\s+/g, ' ').includes(needle)) return lines.length - 1 - i;
  }
  return -1;
}

/**
 * Was the typed text sitting in the composer area when we pressed Enter?
 *
 * Only then is the composer signal usable at all: a needle we never saw down
 * there (empty text, a prompt so wrapped the tail is off-grid, a dialog over
 * the pane) tells us nothing about what an Enter did, and a receipt built on
 * "we could not see it" is a guess.
 */
export function needleInComposer(screen: string, needle: string): boolean {
  const row = rowFromBottom(screen, needle);
  return row >= 0 && row < COMPOSER_AREA_ROWS;
}

/**
 * True when the typed text LEFT the composer area between `before` and `after`.
 *
 * Not "moved up": a composer that grew a soft newline pushes the text up one
 * row while still holding it uncommitted — the exact failure this change
 * exists to catch — and background output shifts rows too. Gone from the
 * bottom region (or off screen entirely) is the only thing a submit does.
 */
export function composerCleared(before: string, after: string, needle: string): boolean {
  if (!needleInComposer(before, needle)) return false;
  return !needleInComposer(after, needle);
}

/**
 * True when the pane's agent status moved INTO a turn.
 *
 * Narrow on purpose. `running → awaiting_input` is a PREVIOUS turn ending
 * inside our window, not ours beginning, so only `running` is an arrival, and
 * only from a status that was not already a turn.
 */
export function isTurnStart(before: string | null, after: string | null): boolean {
  if (after !== 'running') return false;
  if (before === null) return true;
  return NON_TURN_STATUSES.has(before);
}

/** Last `count` non-empty-trailing lines of a screen capture. */
export function screenTail(screen: string, count = SUBMIT_RECEIPT_TAIL_LINES): string {
  const lines = screen.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.slice(-count).join('\n');
}

/** One agent-status observation: the value, and WHEN the snapshot carrying it
 *  was taken. The timestamp is load-bearing — see `awaitSubmitReceipt`. */
export interface AgentStatusReading {
  status: string;
  /** Epoch ms the snapshot was built (renderer push time). */
  ts: number;
}

/** What `awaitSubmitReceipt` needs to observe a pane. Injected so the wait is
 *  testable against a fake PTY with no renderer and no mirror. */
export interface SubmitProbe {
  readScreen: () => Promise<string>;
  readAgentStatus: () => Promise<AgentStatusReading | null>;
}

export interface SubmitReceipt {
  accepted: boolean;
  agentStatusAfter: string | null;
  /** The Enter was sent a second time because the first produced no receipt. */
  retried: boolean;
  /** Why we accepted; 'none' when we watched and nothing moved, 'unobservable'
   *  when neither signal was available to watch in the first place. */
  signal: 'turn_start' | 'composer_cleared' | 'none' | 'unobservable';
  /** Present only when `accepted` is false. */
  screenTail?: string;
}

/**
 * Wait for one of the two receipts after an Enter, retrying the Enter once.
 *
 * Budget is WALL CLOCK, not poll count: each poll costs a viewport read whose
 * latency varies with the pane, so counting iterations meant the real wait
 * drifted with load. `windowMs` for the first attempt; if the needle was
 * observably in the composer we re-send the Enter and watch 2× as long, all
 * clamped by `maxTotalMs` so a submit can never eat an MCP client's timeout.
 *
 * Two things that look like over-caution and are not:
 *
 *   - A status reading is only evidence when its snapshot was taken AFTER the
 *     \r. agentStatus is byte-promoted (#935), so the pane echoing our own
 *     text flips it to `running` — a snapshot from before the Enter would let
 *     our own keystrokes sign for their own delivery.
 *   - We re-send the Enter ONLY when the needle was in the composer to begin
 *     with. Otherwise the pane might be showing a confirmation dialog, and a
 *     blind second Enter presses its default.
 */
export async function awaitSubmitReceipt(
  probe: SubmitProbe,
  needle: string,
  before: { screen: string; agentStatus: string | null },
  resendEnter: () => void,
  opts: {
    windowMs?: number;
    pollMs?: number;
    maxTotalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Epoch ms the \r was written. A status snapshot older than this is our
     *  own echo, not a turn. */
    enterAt?: number;
    now?: () => number;
  } = {},
): Promise<SubmitReceipt> {
  const windowMs = opts.windowMs ?? SUBMIT_RECEIPT_WINDOW_MS;
  const pollMs = opts.pollMs ?? SUBMIT_RECEIPT_POLL_MS;
  const maxTotalMs = opts.maxTotalMs ?? SUBMIT_RECEIPT_MAX_TOTAL_MS;
  const sleep = opts.sleep ?? delay;
  const now = opts.now ?? Date.now;
  const enterAt = opts.enterAt ?? now();

  const composerUsable = needleInComposer(before.screen, needle);
  const statusUsable = before.agentStatus !== null || before.screen !== '';

  // Nothing to watch: no viewport came back AND no status is known for this pty
  // (no renderer, or a pane the mirror has never carried). Waiting to learn
  // nothing helps no one, and a second Enter into a pane we cannot see is worse
  // than no second Enter — so say plainly that we could not observe.
  if (!composerUsable && !statusUsable) {
    return { accepted: false, agentStatusAfter: null, retried: false, signal: 'unobservable' };
  }

  let status = before.agentStatus;
  let screen = before.screen;
  let retried = false;
  const hardDeadline = enterAt + maxTotalMs;

  /** Read the status and decide; separated so it can run BEFORE the first
   *  (expensive) screen read — a hook-fast turn start should not wait on IPC. */
  const pollStatus = async (): Promise<boolean> => {
    const reading = await probe.readAgentStatus();
    if (!reading || reading.ts < enterAt) return false;
    const started = isTurnStart(status, reading.status);
    status = reading.status;
    return started;
  };

  if (await pollStatus()) {
    return { accepted: true, agentStatusAfter: status, retried, signal: 'turn_start' };
  }

  // One attempt when the composer is not observable — there is no second Enter
  // to send, so a longer wait buys only latency.
  const attempts = composerUsable ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const windowDeadline = Math.min(now() + windowMs * (attempt === 0 ? 1 : 2), hardDeadline);
    while (now() < windowDeadline) {
      await sleep(pollMs);
      if (await pollStatus()) {
        return { accepted: true, agentStatusAfter: status, retried, signal: 'turn_start' };
      }
      if (composerUsable) {
        screen = await probe.readScreen();
        if (composerCleared(before.screen, screen, needle)) {
          return { accepted: true, agentStatusAfter: status, retried, signal: 'composer_cleared' };
        }
      }
    }
    if (attempt === 0 && attempts === 2 && now() < hardDeadline) {
      retried = true;
      try {
        resendEnter();
      } catch {
        // The pane died between the first Enter and the retry. That is an
        // unaccepted submit, not a failed RPC — the caller gets `false` and the
        // screen tail, exactly as it would for a pane that ignored us.
        break;
      }
    }
  }

  return {
    accepted: false,
    agentStatusAfter: status,
    retried,
    signal: composerUsable ? 'none' : 'unobservable',
    ...(screen ? { screenTail: screenTail(screen) } : {}),
  };
}

/**
 * Key sequence mapping table for input.sendKey
 */
const KEY_MAP: Readonly<Record<string, string>> = {
  enter: '\r',
  tab: '\t',
  'ctrl+c': '\x03',
  'ctrl+d': '\x04',
  'ctrl+z': '\x1a',
  'ctrl+l': '\x0c',
  escape: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const;

/**
 * Guard for terminal_send / terminal_send_key when ptyId is OMITTED.
 *
 * A verified first-party agent caller carries its own `senderPtyId` (the MCP
 * server's MY_PTY_ID, populated only on a verified PID-map hit). For such a
 * caller, "the active terminal" is ill-defined: it resolves either to the
 * caller's OWN pane (bracket-paste + submit loops into its own prompt) or, in a
 * multi-pane workspace, to a non-deterministic UI-focus-dependent sibling — a
 * silent mis-delivery that assertWorkspaceOwnsPty cannot catch (it only blocks
 * cross-workspace access, never an intra-workspace sibling). So we refuse and
 * require an explicit ptyId.
 *
 * External callers (no senderPtyId — env-hint identity / non-agent) are
 * unaffected: omitting ptyId legitimately targets their own pinned terminal. An
 * explicit ptyId never reaches this guard (handled by the early branch), so a
 * legitimate cross-pane send is structurally safe. A spoofed senderPtyId from a
 * raw pipe client can only self-reject its OWN omitted-ptyId send (it cannot
 * misroute — explicit ptyId bypasses this), so provenance need not be verified.
 */
export function decideTerminalOmittedTarget(senderPtyId: string): {
  allow: boolean;
  reason?: string;
} {
  if (!senderPtyId) return { allow: true };
  return {
    allow: false,
    reason:
      'cannot resolve "the active terminal" for an agent caller — it would loop ' +
      'into your own pane or a non-deterministic sibling. Pass an explicit ptyId ' +
      '(call surface_list() to find the target PTY ID).',
  };
}

/**
 * Resolves the active ptyId from the renderer when none is provided. Scoped to
 * the caller's workspace (not the globally UI-focused one) so an external caller
 * resolves its OWN active pane — mirrors the input.readScreen handler's scoped
 * passthrough (the workspaceId-less variant read whatever the user had focused).
 */
async function resolveActivePtyId(getWindow: GetWindow, callerWs?: string): Promise<string> {
  const scoped = callerWs ? { workspaceId: callerWs } : {};
  const result = await sendToRenderer(getWindow, 'input.readScreen', scoped);
  // renderer returns { ptyId: string, ... } for the active surface
  if (
    result !== null &&
    typeof result === 'object' &&
    'ptyId' in result &&
    typeof (result as Record<string, unknown>)['ptyId'] === 'string'
  ) {
    return (result as Record<string, string>)['ptyId'];
  }
  throw new Error('input: could not resolve active ptyId from renderer');
}

/**
 * Resolve a pane's enforced role→model binding for a ptyId. Mirror-first with
 * a renderer round-trip fallback — see workspace/ptyOwnership.ts (which also
 * hosts assertWorkspaceOwnsPty, shared with the other ownership call sites).
 *
 * Returns undefined on any miss (no owner, unbound role, malformed reply) — the
 * caller fails OPEN, never blocking a legitimate send because a lookup raced.
 */
export type RoleBindingResolver = (ptyId: string) => Promise<RoleBinding | undefined>;

export function makeRoleBindingResolver(getWindow: GetWindow): RoleBindingResolver {
  return (ptyId: string): Promise<RoleBinding | undefined> =>
    resolveRoleBindingForPty(getWindow, ptyId);
}

/**
 * The live submit probe: viewport from the renderer, agent status from the
 * main-side WorkspaceMirror (the renderer pushes it, so no extra IPC per poll).
 *
 * Both reads FAIL SOFT — an empty screen or an unknown status simply means that
 * signal cannot accept, never that the send errors. The mirror needs the owning
 * workspace to key its fleet snapshot; with none resolvable we degrade to the
 * composer signal alone.
 */
function makeSubmitProbe(
  getWindow: GetWindow,
  ptyId: string,
  workspaceId: string | undefined,
): SubmitProbe {
  return {
    readScreen: async (): Promise<string> => {
      try {
        const result = await sendToRenderer(getWindow, 'input.readScreen', {
          ptyId,
          // Bounded on both axes: the composer lives in the last handful of
          // rows, and a viewport we cannot get in 300ms is a poll to skip, not
          // a submit to stall.
          tail_lines: SUBMIT_RECEIPT_READ_LINES,
          timeoutMs: SUBMIT_RECEIPT_READ_TIMEOUT_MS,
        });
        if (result !== null && typeof result === 'object') {
          const text = (result as Record<string, unknown>)['text'];
          if (typeof text === 'string') return text;
        }
      } catch {
        // fail soft — a viewport we cannot read is "no signal", not an error.
      }
      return '';
    },
    readAgentStatus: (): Promise<AgentStatusReading | null> => {
      if (!workspaceId) return Promise.resolve(null);
      const snapshot = getWorkspaceMirror().getFleetSnapshot(workspaceId);
      const pane = snapshot?.panes.find((p) => p.ptyId === ptyId);
      if (!snapshot || !pane?.agentStatus) return Promise.resolve(null);
      // The snapshot's own build time rides along: a status from BEFORE our \r
      // cannot testify about it (byte promotion means our echo moves it).
      return Promise.resolve({ status: pane.agentStatus, ts: snapshot.ts });
    },
  };
}

/**
 * Does this payload end the session rather than talk to it?
 *
 * Two shapes, both seen in #733: an `exit` command committed on its own line,
 * and a raw EOT (Ctrl+D). Deliberately narrow — `exit 1` inside a script, or
 * the word "exit" in a sentence, is not a match. False negatives are fine here
 * (the guard is a backstop for one specific escalation, not a sandbox); false
 * positives would block legitimate writes.
 */
export function isSessionTerminatingInput(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- EOT is the byte we are matching
  if (/\x04/.test(text)) return true;
  return text
    .split(/[\r\n]/)
    .some((line) => /^\s*(exit|logout)\s*$/i.test(line));
}

/**
 * Refuse to end a pane the caller's Stop gate is currently blocked on (#733).
 *
 * The failure this exists for: a pane wedged at `running` held the gate, the
 * brain was told "resolve these panes", and it resolved one by killing it —
 * a live shell the human owned. The gate already names the panes it is waiting
 * on, so the refusal is exactly that intersection and nothing wider. An
 * orchestrator that is not gate-held, or one aiming at a pane the gate did not
 * name, is unaffected.
 *
 * Throws so the caller gets the reason back and can act on it, rather than
 * having the write silently swallowed.
 */
function assertNotKillingAGateHeldPane(
  callerWs: string | undefined,
  ptyId: string,
  text: string,
  op: string,
): void {
  if (!callerWs) return;
  if (!isSessionTerminatingInput(text)) return;
  if (!isGateHeldOn(callerWs, ptyId)) return;
  throw new Error(
    `${op}: refusing to end pane "${ptyId}" — your turn is currently held open by this pane. ` +
      'A pane\'s status is not resolved by closing it, and this session belongs to the human. ' +
      'Read its screen, answer what it is waiting on, or raise it with deck_ask_decision.',
  );
}

/**
 * Refuse to TYPE at a pane that is waiting on an approval (orchestrator wave 2).
 *
 * A brain answering a worker used to send the literal text `1`. That is not an
 * approval: nothing checks the prompt is still on screen, nothing records a
 * decision, no press scope is consulted, and the same digit a moment later lands
 * in the composer of an agent that has moved on. `approval_press` is the answer,
 * so this closes the door the tool replaces — and closes it to ANY text or key,
 * not only digits, because "2" and Down/Enter misfire the same way.
 *
 * Narrow on purpose. It engages ONLY for a commander (`ctx.commanderWorkspace`):
 * the human operator types at their own panes, and a pane agent answering its
 * own prompt IS the pane. And it engages only when a RECORD exists — wmux holds
 * one only for a prompt a hook reported, so a worker without wmux hooks is
 * unaffected and keeps its typed path.
 *
 * The lift is the deadlock guard: once a press on this pane has been refused by
 * policy, typing is the only path left and the block gets out of the way. See
 * `approvals.rpc.ts`.
 */
/**
 * Keys the block does NOT cover: the two ways to make an agent stop.
 *
 * The block exists to stop a brain ANSWERING a prompt by keystroke, and neither
 * of these answers one — they abandon what the pane is doing. Blocking them cost
 * the operator's own escalation path: a worker running away inside a gated tool
 * call holds an approval record for the whole gate deadline, and for that whole
 * window the brain could neither press (policy said no) nor interrupt. "You may
 * not answer this prompt" must not become "you may not stop this agent".
 *
 * Everything else stays blocked, digits and Enter and the arrows included: those
 * SELECT an option, which is the misfire `approval_press` exists to replace.
 */
const APPROVAL_BLOCK_EXEMPT_KEYS: ReadonlySet<string> = new Set(['ctrl+c', 'escape']);

async function assertNotTypingAtAnApproval(
  getDaemonClient: (() => DaemonClient | null) | undefined,
  ctx: RpcContext | undefined,
  ptyId: string,
  op: string,
): Promise<void> {
  if (!ctx?.commanderWorkspace) return;
  if (pressBlockLift(ptyId)) return;
  const record = await pendingApprovalOnPane(getDaemonClient, ptyId);
  if (!record) return;
  throw new Error(approvalBlockMessage(op, ptyId, record));
}

export function registerInputRpc(
  router: RpcRouter,
  ptyManager: PTYManager,
  getWindow: GetWindow,
  getDaemonClient?: () => DaemonClient | null,
  resolveRoleBinding?: RoleBindingResolver,
  /**
   * The interrupt edge for RPC-issued input (MCP `terminal_send` /
   * `terminal_send_key`, the CLI): an orchestrator stopping a worker with
   * Ctrl+C / ESC ESC gets no Stop hook, and `claude` stays the foreground
   * command so OSC 133 cannot see it — main's PTYBridge settles the pane from
   * the bytes instead. Optional: tests and any wiring without a bridge skip it.
   */
  noteInterruptInput?: (ptyId: string, data: string) => void,
): void {
  /**
   * input.send — writes text to a PTY session.
   * params: { text: string, ptyId?: string }
   * If ptyId is omitted the renderer is queried for the active surface's ptyId.
   */
  router.register('input.send', async (params, ctx?: RpcContext) => {
    if (typeof params['text'] !== 'string') {
      throw new Error('input.send: missing required param "text"');
    }

    const text = params['text'];

    if (text.length > 100_000) {
      throw new Error('input.send: text exceeds 100KB limit');
    }

    const callerWs = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    let ptyId: string;

    if (typeof params['ptyId'] === 'string' && params['ptyId'].length > 0) {
      ptyId = params['ptyId'];
    } else {
      const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'] : '';
      const decision = decideTerminalOmittedTarget(senderPtyId);
      if (!decision.allow) {
        throw new Error(`input.send: ${decision.reason}`);
      }
      ptyId = await resolveActivePtyId(getWindow, callerWs);
    }

    await assertWorkspaceOwnsPty(getWindow, ptyId, callerWs, 'input.send');

    assertNotKillingAGateHeldPane(callerWs, ptyId, text, 'input.send');

    await assertNotTypingAtAnApproval(getDaemonClient, ctx, ptyId, 'input.send');

    let safeText = params['raw'] === true ? text : sanitizePtyText(text);

    // D2 — role→model enforcement. When the text is being COMMITTED (submit) and
    // the target pane carries a bound role, transparently rewrite a bare agent
    // launcher (`claude`) into its enforced form (`claude --model haiku`).
    //
    // Coverage is RPC-issued launches only: this handler serves the
    // orchestrator's terminal_send("claude", submit:true) reflex and other pipe
    // callers. Human keystrokes do NOT flow through here — Terminal.tsx writes
    // straight to the pty IPC handler — so typing `claude⏎` yourself is not
    // enforced. The other two enforcement points are the seeded initialCommand
    // (ptyCreateOptions.withRoleBinding) and the resume chip.
    //
    // Only the commit edge is touched. A half-typed line (submit=false), a
    // multi-line paste, and a `raw:true` write (which deliberately bypasses
    // sanitizePtyText, i.e. the caller is sending bytes, not a command) are all
    // left alone. Fail OPEN on any resolver error so a role lookup that races
    // can never block a legitimate send.
    let enforcedModel: string | undefined;
    let enforcementNote: string | undefined;
    // ESC joins the line terminators here: a line carrying terminal control
    // sequences is not a plain command and must not be spliced into.
    // eslint-disable-next-line no-control-regex -- intentional control-char match
    const NON_COMMAND_CHARS = /[\n\r\x1b]/;
    const rewritable =
      params['submit'] === true && params['raw'] !== true && !NON_COMMAND_CHARS.test(safeText);
    if (rewritable && resolveRoleBinding) {
      try {
        const binding = await resolveRoleBinding(ptyId);
        if (binding) {
          const rewrite = applyRoleBinding(safeText, binding);
          if (rewrite.changed) {
            safeText = rewrite.command;
            // Report the model ONLY when the flag was actually injected —
            // args-only rewrites leave whatever model the line already names.
            if (rewrite.modelInjected) enforcedModel = binding.model;
          }
          if (rewrite.note) enforcementNote = rewrite.note;
        }
      } catch {
        // fail-open — enforcement is best-effort at the input layer.
      }
    }

    // Route one chunk to the local PTYManager, else the daemon. Shared by the
    // text write and the trailing-\r submit so both hit the same session.
    const writeChunk = (data: string): void => {
      noteInterruptInput?.(ptyId, data);
      const instance = ptyManager.get(ptyId);
      if (instance) {
        ptyManager.write(ptyId, data);
      } else {
        const dc = getDaemonClient?.();
        if (dc?.isConnected) {
          dc.writeToSession(ptyId, data);
        } else {
          throw new Error(`input.send: PTY not found — id="${ptyId}"`);
        }
      }
    };

    // submit=true commits the text with an Enter (carriage return — the
    // canonical commit byte for line-mode shells and TUI input widgets alike;
    // \n would land as a soft newline). CRUCIALLY, the \r is a SEPARATE write
    // from the text, with a tick between them: a fused `text\r` chunk is read
    // by a TUI editor (Claude Code / ink) as a multi-line paste and does NOT
    // submit — the \r becomes a soft newline in the composer. A lone \r
    // arriving in its own read cycle is an unambiguous Enter keypress. This is
    // exactly why the two-step terminal_send + terminal_send_key('enter')
    // workaround succeeded where submit:true did not.
    //
    // A text that ALREADY ends in \r used to skip the split write and the
    // receipt entirely, and then reported `submitted:true, accepted:false` —
    // the very false receipt this handler exists to remove, wearing a
    // different hat. The trailing \r IS the submit, so it is stripped and the
    // normal path runs: one text write, one Enter, one receipt.
    const submitRequested = params['submit'] === true;
    const bodyText = submitRequested && safeText.endsWith('\r') ? safeText.slice(0, -1) : safeText;
    let receipt: SubmitReceipt | undefined;
    if (submitRequested) {
      // Resolve the receipt workspace BEFORE the first write so its round-trip
      // never lands inside the text→Enter gap the delay above protects.
      const receiptWs =
        callerWs ?? (await resolvePtyOwnerWorkspace(getWindow, ptyId).catch(() => null)) ?? undefined;
      const probe = makeSubmitProbe(getWindow, ptyId, receiptWs);

      if (bodyText) writeChunk(bodyText);
      await delay(SUBMIT_ENTER_DELAY_MS);
      // Snapshot the pane while the text sits UNCOMMITTED on the input line —
      // this is the "before" the composer diff is measured against.
      const beforeReading = await probe.readAgentStatus();
      const before = {
        screen: await probe.readScreen(),
        agentStatus: beforeReading?.status ?? null,
      };
      writeChunk('\r');
      const enterAt = Date.now();
      receipt = await awaitSubmitReceipt(
        probe,
        submitNeedle(bodyText),
        before,
        () => writeChunk('\r'),
        { enterAt },
      );
    } else {
      writeChunk(safeText);
    }

    return {
      ok: true,
      ptyId,
      // `submitted` reports only that an Enter was WRITTEN. `accepted` is the
      // receipt: whether the pane was observed to move. A caller that needs to
      // know the agent got the prompt must read `accepted` — and when no
      // receipt was attempted at all (submit:false) the field is ABSENT rather
      // than a hard false, which would read as "we looked and it did not land".
      submitted: submitRequested,
      ...(receipt
        ? {
            accepted: receipt.accepted,
            agentStatusAfter: receipt.agentStatusAfter,
            receiptSignal: receipt.signal,
            enterRetried: receipt.retried,
          }
        : {}),
      ...(receipt?.screenTail ? { screenTail: receipt.screenTail } : {}),
      // D2 — surface enforcement on the payload (callRpc stringifies it into the
      // tool result, so the orchestrator sees which model was pinned). The pane
      // also shows the rewritten command directly — the primary indication.
      ...(enforcedModel ? { enforcedModel } : {}),
      ...(enforcementNote ? { note: enforcementNote } : {}),
    };
  });

  /**
   * input.sendKey — maps a named key to an ANSI sequence and writes it.
   * params: { key: string, ptyId?: string }
   * Supported keys: enter, tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l,
   *                 escape, up, down, right, left
   */
  router.register('input.sendKey', async (params, ctx?: RpcContext) => {
    if (typeof params['key'] !== 'string') {
      throw new Error('input.sendKey: missing required param "key"');
    }

    const key = params['key'].toLowerCase();
    const sequence = KEY_MAP[key];
    if (sequence === undefined) {
      throw new Error(
        `input.sendKey: unknown key "${params['key']}". ` +
          `Supported: ${Object.keys(KEY_MAP).join(', ')}`,
      );
    }

    const callerWs = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    let ptyId: string;
    if (typeof params['ptyId'] === 'string' && params['ptyId'].length > 0) {
      ptyId = params['ptyId'];
    } else {
      const senderPtyId = typeof params['senderPtyId'] === 'string' ? params['senderPtyId'] : '';
      const decision = decideTerminalOmittedTarget(senderPtyId);
      if (!decision.allow) {
        throw new Error(`input.sendKey: ${decision.reason}`);
      }
      ptyId = await resolveActivePtyId(getWindow, callerWs);
    }

    await assertWorkspaceOwnsPty(getWindow, ptyId, callerWs, 'input.sendKey');

    // Ctrl+D arrives here as its escape sequence, so the same guard applies.
    assertNotKillingAGateHeldPane(callerWs, ptyId, sequence, 'input.sendKey');

    // Down/Enter picks an option just as surely as typing "2" does — but ctrl+c
    // and escape do not pick anything, they stop the agent, and the block must
    // not take away the way to stop a runaway worker.
    if (!APPROVAL_BLOCK_EXEMPT_KEYS.has(key)) {
      await assertNotTypingAtAnApproval(getDaemonClient, ctx, ptyId, 'input.sendKey');
    }

    noteInterruptInput?.(ptyId, sequence);
    const instance = ptyManager.get(ptyId);
    if (instance) {
      ptyManager.write(ptyId, sequence);
    } else {
      const dc = getDaemonClient?.();
      if (dc?.isConnected) {
        dc.writeToSession(ptyId, sequence);
      } else {
        throw new Error(`input.sendKey: PTY not found — id="${ptyId}"`);
      }
    }

    return { ok: true, ptyId, key };
  });

  /**
   * input.readScreen — delegates to the renderer to capture the current
   * terminal viewport text of a surface.
   * Returns { ptyId: string, text: string }
   * Accepts optional { ptyId?, tail_lines? } params that the renderer honors.
   *
   * Ownership is enforced so a caller that learned a foreign PTY id cannot read
   * another workspace's viewport (issue #163 — readScreen was the lone
   * terminal-IO handler missing the assert). Two paths:
   *   - Explicit ptyId: assert BEFORE reading, so a foreign viewport is never
   *     even captured.
   *   - No ptyId: forward params as-is so the renderer resolves the active pane
   *     scoped to params.workspaceId. This preserves the old passthrough — the
   *     caller's OWN active pane, not the globally UI-focused one (resolving via
   *     a workspaceId-less resolveActivePtyId would read whatever the user has
   *     focused and wrongly reject a legit same-workspace caller). Re-assert the
   *     returned ptyId as defense in depth.
   * Internal callers (CLI/UI) pass no workspaceId; assertWorkspaceOwnsPty then
   * early-returns and the check is skipped.
   *
   * #922 PR2 — note what this assert does and does not answer. `callerWs` comes
   * from `params.workspaceId`, so it checks that the NAMED workspace and the
   * pty agree; it never checks that the named workspace is the caller's. For an
   * iframe plugin those were different questions: naming a foreign workspace
   * passed, because the pty really does live there. The missing half is now
   * supplied at dispatch — `hostedWorkspaceBinding.ts` pins `workspaceId` to
   * the workspace hosting the plugin before this handler runs, so `callerWs`
   * is the binding and the early-return is unreachable for that caller class.
   */
  router.register('input.readScreen', async (params) => {
    const p = params ?? {};
    const callerWs = typeof p['workspaceId'] === 'string' ? p['workspaceId'] : undefined;

    if (typeof p['ptyId'] === 'string' && p['ptyId'].length > 0) {
      await assertWorkspaceOwnsPty(getWindow, p['ptyId'], callerWs, 'input.readScreen');
      return sendToRenderer(getWindow, 'input.readScreen', p);
    }

    const result = await sendToRenderer(getWindow, 'input.readScreen', p);
    const readPtyId =
      result !== null &&
      typeof result === 'object' &&
      typeof (result as Record<string, unknown>)['ptyId'] === 'string'
        ? (result as Record<string, string>)['ptyId']
        : undefined;
    if (readPtyId) {
      await assertWorkspaceOwnsPty(getWindow, readPtyId, callerWs, 'input.readScreen');
    }
    return result;
  });

  /**
   * terminal.readEvents — return structured OSC 133 prompt/command events
   * from the daemon's per-session PromptEventLog. This is the canonical
   * "AI-readable" terminal read path — unlike input.readScreen which
   * returns a flat viewport string.
   *
   * params: { ptyId?, limit?, sinceOffset?, lastCommandOnly? }
   */
  router.register('terminal.readEvents', async (params) => {
    let ptyId: string;
    if (typeof params['ptyId'] === 'string' && params['ptyId'].length > 0) {
      ptyId = params['ptyId'];
    } else {
      ptyId = await resolveActivePtyId(getWindow);
    }

    const callerWs = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    await assertWorkspaceOwnsPty(getWindow, ptyId, callerWs, 'terminal.readEvents');

    const dc = getDaemonClient?.();
    if (!dc?.isConnected) {
      // Local-only PTYs (spawned by main before daemon adoption) don't have
      // a PromptEventLog. Return a structured empty response so the caller
      // gets a consistent shape.
      return {
        ptyId,
        events: [],
        lastCompletedRange: null,
        totalBytesWritten: 0,
        sessionFound: false,
        note: 'daemon not connected — prompt events unavailable for this PTY',
      };
    }

    const opts: { limit?: number; sinceOffset?: number; lastCommandOnly?: boolean } = {};
    if (typeof params['limit'] === 'number') opts.limit = params['limit'];
    if (typeof params['sinceOffset'] === 'number') opts.sinceOffset = params['sinceOffset'];
    if (params['lastCommandOnly'] === true) opts.lastCommandOnly = true;

    const result = await dc.readPromptEvents(ptyId, opts);
    return { ptyId, ...result };
  });
}
