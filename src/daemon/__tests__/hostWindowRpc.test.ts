import { describe, expect, it, vi } from 'vitest';
import { createHostWindowRpc } from '../hostWindowRpc';

const hwnd = Buffer.from([0x2a, 0x10, 0, 0, 0, 0, 0, 0]);
const wire = hwnd.toString('base64');

function setup(firstParty: string[] = ['main-1']) {
  const setHostWindow = vi.fn<(handle: Buffer | null) => number>(() => 3);
  const rpc = createHostWindowRpc({ isFirstParty: (id) => firstParty.includes(id), setHostWindow });
  return { rpc, setHostWindow };
}

describe('daemon.setHostWindow', () => {
  it('applies the app window to the panes and says how many it reached', () => {
    const { rpc, setHostWindow } = setup();
    expect(rpc.handle({ handle: wire }, 'main-1')).toEqual({ ok: true, reached: 3 });
    expect(setHostWindow).toHaveBeenCalledTimes(1);
    expect(setHostWindow.mock.calls[0][0]?.equals(hwnd)).toBe(true);
  });

  it('refuses a client that never claimed the app role (MCP, CLI)', () => {
    const { rpc, setHostWindow } = setup();
    expect(rpc.handle({ handle: wire }, 'mcp-7')).toEqual({ ok: false, reason: 'not-authorized' });
    expect(setHostWindow).not.toHaveBeenCalled();
  });

  it('takes an all-zero HWND as no window: it clears, and leaves no owner to clear again on close', () => {
    const { rpc, setHostWindow } = setup();
    expect(rpc.handle({ handle: Buffer.alloc(8).toString('base64') }, 'main-1')).toEqual({ ok: true, reached: 3 });
    expect(setHostWindow).toHaveBeenLastCalledWith(null);
    rpc.onClientClose('main-1');
    expect(setHostWindow).toHaveBeenCalledTimes(1);
  });

  it('refuses a handle that is not one HWND', () => {
    const { rpc, setHostWindow } = setup();
    expect(rpc.handle({ handle: Buffer.alloc(4).toString('base64') }, 'main-1')).toEqual({ ok: false, reason: 'bad-handle' });
    expect(rpc.handle({}, 'main-1')).toEqual({ ok: false, reason: 'bad-handle' });
    expect(setHostWindow).not.toHaveBeenCalled();
  });

  it('clears the owner when the app that set it disconnects, so no pane keeps a dead window', () => {
    const { rpc, setHostWindow } = setup(['main-1', 'main-2']);
    rpc.handle({ handle: wire }, 'main-1');
    rpc.onClientClose('mcp-7');
    rpc.onClientClose('main-2');
    expect(setHostWindow).toHaveBeenCalledTimes(1);
    rpc.onClientClose('main-1');
    expect(setHostWindow).toHaveBeenLastCalledWith(null);
    // Once cleared, a second close is nothing to do.
    rpc.onClientClose('main-1');
    expect(setHostWindow).toHaveBeenCalledTimes(2);
  });

  it('leaves a newer app window alone when an older connection closes', () => {
    const { rpc, setHostWindow } = setup(['main-1', 'main-2']);
    rpc.handle({ handle: wire }, 'main-1');
    rpc.handle({ handle: wire }, 'main-2');
    rpc.onClientClose('main-1');
    expect(setHostWindow).toHaveBeenCalledTimes(2);
  });
});
