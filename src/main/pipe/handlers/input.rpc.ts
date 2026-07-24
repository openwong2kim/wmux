import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { PTYManager } from '../../pty/PTYManager';
import type { DaemonClient } from '../../DaemonClient';
import { sendToRenderer } from './_bridge';
import { sanitizePtyText } from '../../../shared/types';
import { applyRoleBinding, normalizeRoleBinding, type RoleBinding } from '../../../shared/orchestratorRole';

type GetWindow = () => BrowserWindow | null;

/**
 * Delay between the text write and the trailing carriage return on a submit.
 * See the two-write rationale in the input.send handler. Small but non-zero so
 * the PTY slave gets its OWN read for the text before the Enter arrives — a
 * fused `text\r` chunk is read as a multi-line PASTE by TUI editors (Claude
 * Code / ink) and lands the \r as a soft newline instead of submitting.
 * Live-tunable if a TUI still coalesces at 20ms on a slow host.
 */
const SUBMIT_ENTER_DELAY_MS = 20;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
 * Verify that `ptyId` belongs to a surface inside `expectedWorkspaceId`.
 * Throws when the PTY is owned by a different workspace (or no workspace at
 * all). Returns silently when `expectedWorkspaceId` is undefined — internal
 * callers (CLI, UI) skip this check.
 *
 * Closes the cross-workspace bypass where the metadata layer enforced
 * isolation but the PTY-id-keyed terminal IO layer didn't: any caller that
 * learned a foreign PTY id (via leaks, screenshots, surface_list) could
 * read or write that workspace's terminal at will.
 */
async function assertWorkspaceOwnsPty(
  getWindow: GetWindow,
  ptyId: string,
  expectedWorkspaceId: string | undefined,
  rpcName: string,
): Promise<void> {
  if (!expectedWorkspaceId) return;
  const result = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId });
  const owner =
    result && typeof result === 'object' && 'workspaceId' in result
      ? ((result as Record<string, unknown>)['workspaceId'] as string | null)
      : null;
  if (owner !== expectedWorkspaceId) {
    throw new Error(
      `${rpcName}: PTY "${ptyId}" is not owned by workspace "${expectedWorkspaceId}" ` +
        `(actual owner: ${owner ?? 'none'}). Cross-workspace terminal access is not allowed.`,
    );
  }
}

/**
 * Resolve a pane's enforced role→model binding for a ptyId, via the SAME
 * renderer oracle assertWorkspaceOwnsPty already consults (input.findOwnerWorkspace,
 * extended in D2 to also return the owning paneId + resolved roleBinding). Both
 * the role mirror and the operator binding map live in the renderer store, so
 * the renderer resolves the pair; main just applies the pure transform.
 *
 * Returns undefined on any miss (no owner, unbound role, malformed reply) — the
 * caller fails OPEN, never blocking a legitimate send because a lookup raced.
 */
export type RoleBindingResolver = (ptyId: string) => Promise<RoleBinding | undefined>;

export function makeRoleBindingResolver(getWindow: GetWindow): RoleBindingResolver {
  return async (ptyId: string): Promise<RoleBinding | undefined> => {
    const result = await sendToRenderer(getWindow, 'input.findOwnerWorkspace', { ptyId });
    if (!result || typeof result !== 'object' || !('roleBinding' in result)) return undefined;
    // Re-normalize at the read boundary — the renderer store is hand-editable
    // via session.json, so treat the binding as untrusted even here.
    return normalizeRoleBinding((result as Record<string, unknown>)['roleBinding']);
  };
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
    if (wantsSubmit) {
      writeChunk(safeText);
      await delay(SUBMIT_ENTER_DELAY_MS);
      writeChunk('\r');
    } else {
      writeChunk(safeText);
    }

    return {
      ok: true,
      ptyId,
      submitted: params['submit'] === true,
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
