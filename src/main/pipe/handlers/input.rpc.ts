import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { PTYManager } from '../../pty/PTYManager';
import { sendToRenderer } from './_bridge';

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

export function registerInputRpc(
  router: RpcRouter,
  ptyManager: PTYManager,
  getWindow: GetWindow,
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

    const instance = ptyManager.get(ptyId);
    if (!instance) {
      throw new Error(`input.send: PTY not found — id="${ptyId}"`);
    }

    ptyManager.write(ptyId, text);
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

    const instance = ptyManager.get(ptyId);
    if (!instance) {
      throw new Error(`input.sendKey: PTY not found — id="${ptyId}"`);
    }

    ptyManager.write(ptyId, sequence);
    return { ok: true, ptyId, key, sequence };
  });

  /**
   * input.readScreen — delegates to the renderer to capture the current
   * terminal viewport text of the active surface.
   * Returns { ptyId: string, text: string }
   */
  router.register('input.readScreen', (_params) =>
    sendToRenderer(getWindow, 'input.readScreen'),
  );
}
