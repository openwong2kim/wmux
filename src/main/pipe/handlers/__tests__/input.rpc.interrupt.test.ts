// The interrupt edge on the RPC lane (MCP `terminal_send` / `terminal_send_key`
// and the CLI). An orchestrator that stops a worker with Ctrl+C gets no Stop
// hook, and `claude` stays the pane's foreground command so OSC 133 cannot see
// it either — the written bytes are the only evidence, and they must reach
// main's PTYBridge settle exactly like renderer keystrokes do.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

function setup() {
  const writes: string[] = [];
  const spyPty = {
    get: () => ({}),
    write: (_ptyId: string, text: string) => { writes.push(text); },
  } as unknown as PTYManager;
  const noteInterruptInput = vi.fn();
  const router = new RpcRouter();
  registerInputRpc(router, spyPty, () => fakeWindow, undefined, undefined, noteInterruptInput);
  return { router, writes, noteInterruptInput };
}

describe('input.rpc interrupt edge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('feeds input.sendKey ctrl+c to the settle', async () => {
    const { router, noteInterruptInput } = setup();

    const res = await router.dispatch({ id: '1', method: 'input.sendKey', params: { ptyId: 'p1', key: 'ctrl+c' } });

    expect(res.ok).toBe(true);
    expect(noteInterruptInput).toHaveBeenCalledWith('p1', '\x03');
  });

  it('feeds input.sendKey escape to the settle (two taps are the interrupt)', async () => {
    const { router, noteInterruptInput } = setup();

    await router.dispatch({ id: '1', method: 'input.sendKey', params: { ptyId: 'p1', key: 'escape' } });
    await router.dispatch({ id: '2', method: 'input.sendKey', params: { ptyId: 'p1', key: 'escape' } });

    expect(noteInterruptInput).toHaveBeenNthCalledWith(1, 'p1', '\x1b');
    expect(noteInterruptInput).toHaveBeenNthCalledWith(2, 'p1', '\x1b');
  });

  it('feeds input.send chunks to the settle', async () => {
    const { router, noteInterruptInput } = setup();

    await router.dispatch({ id: '1', method: 'input.send', params: { ptyId: 'p1', text: '\x03', raw: true } });

    expect(noteInterruptInput).toHaveBeenCalledWith('p1', '\x03');
  });
});
