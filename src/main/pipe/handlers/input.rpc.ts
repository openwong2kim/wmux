import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { PTYManager } from '../../pty/PTYManager';
import type { DaemonClient } from '../../DaemonClient';
import { sendToRenderer } from './_bridge';
import { sanitizePtyText } from '../../../shared/types';

type GetWindow = () => BrowserWindow | null;

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

export function registerInputRpc(
  router: RpcRouter,
  ptyManager: PTYManager,
  getWindow: GetWindow,
  getDaemonClient?: () => DaemonClient | null,
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

    const safeText = params['raw'] === true ? text : sanitizePtyText(text);
    // submit=true appends \r so the text is committed (Enter pressed). We do
    // not append when the sanitized text already ends in \r to avoid a stray
    // empty submit. Carriage return is the canonical commit byte for both
    // line-mode shells and TUI input widgets (xterm/Claude Code/REPLs); \n
    // would land as a soft newline in the input widget instead.
    const payload =
      params['submit'] === true && !safeText.endsWith('\r')
        ? safeText + '\r'
        : safeText;

    // Try local PTYManager first, then daemon
    const instance = ptyManager.get(ptyId);
    if (instance) {
      ptyManager.write(ptyId, payload);
    } else {
      const dc = getDaemonClient?.();
      if (dc?.isConnected) {
        dc.writeToSession(ptyId, payload);
      } else {
        throw new Error(`input.send: PTY not found — id="${ptyId}"`);
      }
    }

    return { ok: true, ptyId, submitted: params['submit'] === true };
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
