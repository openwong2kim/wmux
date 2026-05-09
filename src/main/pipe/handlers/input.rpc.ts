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
 * Resolves the active ptyId from the renderer when none is provided.
 * Asks the renderer for the currently focused surface's ptyId.
 */
async function resolveActivePtyId(getWindow: GetWindow): Promise<string> {
  const result = await sendToRenderer(getWindow, 'input.readScreen');
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

    let ptyId: string;

    if (typeof params['ptyId'] === 'string' && params['ptyId'].length > 0) {
      ptyId = params['ptyId'];
    } else {
      ptyId = await resolveActivePtyId(getWindow);
    }

    const callerWs = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    await assertWorkspaceOwnsPty(getWindow, ptyId, callerWs, 'input.send');

    const safeText = params['raw'] === true ? text : sanitizePtyText(text);

    // Try local PTYManager first, then daemon
    const instance = ptyManager.get(ptyId);
    if (instance) {
      ptyManager.write(ptyId, safeText);
    } else {
      const dc = getDaemonClient?.();
      if (dc?.isConnected) {
        dc.writeToSession(ptyId, safeText);
      } else {
        throw new Error(`input.send: PTY not found — id="${ptyId}"`);
      }
    }

    return { ok: true, ptyId };
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

    let ptyId: string;
    if (typeof params['ptyId'] === 'string' && params['ptyId'].length > 0) {
      ptyId = params['ptyId'];
    } else {
      ptyId = await resolveActivePtyId(getWindow);
    }

    const callerWs = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
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
   * terminal viewport text of the active surface.
   * Returns { ptyId: string, text: string }
   * Accepts optional { ptyId?, tail_lines? } params that the renderer honors.
   */
  router.register('input.readScreen', (params) =>
    sendToRenderer(getWindow, 'input.readScreen', params ?? {}),
  );

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
