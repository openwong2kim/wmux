import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { PTYManager } from '../../pty/PTYManager';
import type { DaemonClient } from '../../DaemonClient';
import { sendToRenderer } from './_bridge';
import { sanitizePtyText } from '../../../shared/types';
import { applyRoleBinding, type RoleBinding } from '../../../shared/orchestratorRole';
import { isGateHeldOn } from '../../deck/stopGateState';
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
//   (a) turn start — the pane's agentStatus goes to running/awaiting_input,
//       i.e. the agent detector / hook lane saw a turn begin for this pty.
//   (b) composer cleared — the text we just typed is no longer sitting on the
//       input line. Detected positionally (see `rowFromBottom`), because a TUI
//       like Claude Code re-renders the submitted prompt into its transcript:
//       the string is still on screen, just no longer at the bottom.

/** How long a submit waits for a receipt before retrying the Enter. */
const SUBMIT_RECEIPT_WINDOW_MS = 400;

/** Poll interval while waiting for a receipt. */
const SUBMIT_RECEIPT_POLL_MS = 50;

/** Screen lines handed back when no receipt arrived, so the caller can see
 *  what the pane is actually showing instead of guessing. */
const SUBMIT_RECEIPT_TAIL_LINES = 10;

/** Statuses that mean a turn has begun for this pane. A change to any other
 *  status (e.g. running → idle) is decay, not a receipt. */
const TURN_START_STATUSES: ReadonlySet<string> = new Set(['running', 'awaiting_input']);

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
 * True when the typed text left the input line between `before` and `after`.
 *
 * Gone from the screen entirely, or moved further from the bottom, both mean
 * the composer committed it. Same row means it is still pending — which is
 * exactly what an echo-only repaint looks like, so echo alone never accepts.
 * A needle that was never visible before the Enter tells us nothing (the pane
 * may not render an input line at all), so we refuse to guess.
 */
export function composerAdvanced(before: string, after: string, needle: string): boolean {
  const beforeRow = rowFromBottom(before, needle);
  if (beforeRow < 0) return false;
  const afterRow = rowFromBottom(after, needle);
  if (afterRow < 0) return true;
  return afterRow > beforeRow;
}

/** True when the pane's agent status moved INTO a turn between the two reads. */
export function isTurnStart(before: string | null, after: string | null): boolean {
  if (!after || after === before) return false;
  return TURN_START_STATUSES.has(after);
}

/** Last `count` non-empty-trailing lines of a screen capture. */
export function screenTail(screen: string, count = SUBMIT_RECEIPT_TAIL_LINES): string {
  const lines = screen.replace(/\r/g, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.slice(-count).join('\n');
}

/** What `awaitSubmitReceipt` needs to observe a pane. Injected so the wait is
 *  testable against a fake PTY with no renderer and no mirror. */
export interface SubmitProbe {
  readScreen: () => Promise<string>;
  readAgentStatus: () => Promise<string | null>;
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
 * Budget: `windowMs` for the first attempt, then the Enter is re-sent and we
 * wait 2× as long (a TUI that missed the first \r was busy, so give it more
 * room). Still nothing ⇒ `accepted: false` with the screen tail attached.
 */
export async function awaitSubmitReceipt(
  probe: SubmitProbe,
  needle: string,
  before: { screen: string; agentStatus: string | null },
  resendEnter: () => void,
  opts: { windowMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SubmitReceipt> {
  const windowMs = opts.windowMs ?? SUBMIT_RECEIPT_WINDOW_MS;
  const pollMs = opts.pollMs ?? SUBMIT_RECEIPT_POLL_MS;
  const sleep = opts.sleep ?? delay;

  // Neither signal is available: no viewport came back AND no status is known
  // for this pty (no renderer, or a pane the mirror has never carried). Waiting
  // 1.2s to learn nothing helps no one, and re-sending an Enter into a pane we
  // cannot see is worse than not sending it — so say plainly that we could not
  // observe rather than manufacturing a verdict.
  if (before.screen === '' && before.agentStatus === null) {
    return { accepted: false, agentStatusAfter: null, retried: false, signal: 'unobservable' };
  }

  let status = before.agentStatus;
  let screen = before.screen;
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = windowMs * (attempt === 0 ? 1 : 2);
    for (let waited = 0; waited < budget; waited += pollMs) {
      await sleep(pollMs);
      screen = await probe.readScreen();
      const next = await probe.readAgentStatus();
      if (next !== null) {
        if (isTurnStart(status, next)) {
          return { accepted: true, agentStatusAfter: next, retried, signal: 'turn_start' };
        }
        status = next;
      }
      if (composerAdvanced(before.screen, screen, needle)) {
        return { accepted: true, agentStatusAfter: status, retried, signal: 'composer_cleared' };
      }
    }
    if (attempt === 0) {
      retried = true;
      resendEnter();
    }
  }

  return {
    accepted: false,
    agentStatusAfter: status,
    retried,
    signal: 'none',
    screenTail: screenTail(screen),
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
        const result = await sendToRenderer(getWindow, 'input.readScreen', { ptyId });
        if (result !== null && typeof result === 'object') {
          const text = (result as Record<string, unknown>)['text'];
          if (typeof text === 'string') return text;
        }
      } catch {
        // fail soft — a viewport we cannot read is "no signal", not an error.
      }
      return '';
    },
    readAgentStatus: (): Promise<string | null> => {
      if (!workspaceId) return Promise.resolve(null);
      const snapshot = getWorkspaceMirror().getFleetSnapshot(workspaceId);
      const pane = snapshot?.panes.find((p) => p.ptyId === ptyId);
      return Promise.resolve(pane?.agentStatus ?? null);
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

export function registerInputRpc(
  router: RpcRouter,
  ptyManager: PTYManager,
  getWindow: GetWindow,
  getDaemonClient?: () => DaemonClient | null,
  resolveRoleBinding?: RoleBindingResolver,
): void {
  /**
   * input.send — writes text to a PTY session.
   * params: { text: string, ptyId?: string }
   * If ptyId is omitted the renderer is queried for the active surface's ptyId.
   */
  router.register('input.send', async (params) => {
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
    // workaround succeeded where submit:true did not. We skip the extra write
    // when the text already ends in \r (avoids a stray empty submit).
    const wantsSubmit = params['submit'] === true && !safeText.endsWith('\r');
    let receipt: SubmitReceipt | undefined;
    if (wantsSubmit) {
      // Resolve the receipt workspace BEFORE the first write so its round-trip
      // never lands inside the text→Enter gap the delay above protects.
      const receiptWs =
        callerWs ?? (await resolvePtyOwnerWorkspace(getWindow, ptyId).catch(() => null)) ?? undefined;
      const probe = makeSubmitProbe(getWindow, ptyId, receiptWs);

      writeChunk(safeText);
      await delay(SUBMIT_ENTER_DELAY_MS);
      // Snapshot the pane while the text sits UNCOMMITTED on the input line —
      // this is the "before" the composer diff is measured against.
      const before = {
        screen: await probe.readScreen(),
        agentStatus: await probe.readAgentStatus(),
      };
      writeChunk('\r');
      receipt = await awaitSubmitReceipt(probe, submitNeedle(safeText), before, () =>
        writeChunk('\r'),
      );
    } else {
      writeChunk(safeText);
    }

    return {
      ok: true,
      ptyId,
      // `submitted` reports only that an Enter was WRITTEN. `accepted` is the
      // receipt: whether the pane was observed to move. A caller that needs to
      // know the agent got the prompt must read `accepted`.
      submitted: params['submit'] === true,
      accepted: receipt?.accepted ?? false,
      agentStatusAfter: receipt?.agentStatusAfter ?? null,
      ...(receipt ? { receiptSignal: receipt.signal, enterRetried: receipt.retried } : {}),
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
  router.register('input.sendKey', async (params) => {
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
