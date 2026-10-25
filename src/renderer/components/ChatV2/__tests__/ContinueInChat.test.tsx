// @vitest-environment jsdom
// @wmux-lane unit — 'win32' here is a fake window.electronAPI.platform value; nothing reaches the OS.
// Continue in chat: the move's state lives above the views, so the dialog and
// a failure after the TUI's stop outlive the view swap that stop causes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatV2BridgeApi } from '../../../../shared/chatv2/ipc';
import { setChatV2BridgeForTests } from '../bridge';
import { ContinueInChat, usePaneMove } from '../ContinueInChat';

vi.mock('../../../hooks/useT', () => { const t = (key: string) => key; return { useT: () => t }; });
vi.mock('../controller', () => ({ setKnownBinding: vi.fn() }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  (window as unknown as { electronAPI: unknown }).electronAPI = { platform: 'darwin' };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setChatV2BridgeForTests(null);
  vi.unstubAllGlobals();
});

function Probe({ paneId }: { paneId: string }) {
  const move = usePaneMove(paneId);
  return <div data-probe={move.phase} data-from-projection={String(move.fromProjection)}>{move.error}</div>;
}

describe('ContinueInChat', () => {
  it('is offered on macOS, Linux and Windows only', async () => {
    setChatV2BridgeForTests({ call: vi.fn() } as unknown as ChatV2BridgeApi);
    for (const [platform, offered] of [['darwin', true], ['linux', true], ['win32', true], ['freebsd', false]] as const) {
      (window as unknown as { electronAPI: unknown }).electronAPI = { platform };
      await act(async () => root.render(<ContinueInChat key={platform} paneId="pty-a" />));
      expect(!!host.querySelector('[data-chatv2-from-terminal]')).toBe(offered);
    }
  });

  it('a failure after the stop shows once the view that started the move is gone', async () => {
    let finish!: (message: string) => void;
    const call = vi.fn(async (_method: string, params: { preview?: true }) => (params.preview
      ? { ok: true, processes: [] }
      : new Promise((resolve) => { finish = (message) => resolve({ ok: false, error: { code: 'handoff-refused', message } }); })));
    setChatV2BridgeForTests({ call } as unknown as ChatV2BridgeApi);
    const render = (offered: boolean) => root.render(<>{offered && <ContinueInChat paneId="pty-a" />}<Probe paneId="pty-a" /></>);

    await act(async () => render(true));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-chatv2-from-terminal]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-continue-in-chat-confirm]')!.click(); });
    const probe = () => host.querySelector('[data-probe]')!;
    expect(probe().getAttribute('data-probe')).toBe('moving');
    expect(probe().getAttribute('data-from-projection')).toBe('true');

    // The stop ended the TUI: the projection, and the button in it, went away.
    await act(async () => render(false));
    await act(async () => { finish('Claude was stopped; reopen it with Resume. The chat could not start.'); });
    expect(probe().getAttribute('data-probe')).toBe('idle');
    expect(probe().textContent).toBe('Claude was stopped; reopen it with Resume. The chat could not start.');
  });
});
