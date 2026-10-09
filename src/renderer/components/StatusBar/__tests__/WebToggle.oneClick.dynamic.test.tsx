// @vitest-environment jsdom
//
// The hub's one-click paths: Pair a phone and Connect another computer start
// a stopped server (behind Tailscale when this computer can be fronted, never
// on the LAN, input still off) and mint the named code in the same click; the
// computer card's HTTPS dead end becomes an inline restart behind Tailscale.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WebToggle from '../WebToggle';
import type { WebDeviceSummary, WebDiagnosis, WebTerminalInfo } from '../../../../shared/web';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let status: WebTerminalInfo;
let clipboard = '';
let tailscaleOk = true;
const start = vi.fn();
const pairStart = vi.fn();
const diagnose = vi.fn();
const writeEphemeral = vi.fn(async (text: string) => { clipboard = text; });

// One paired device keeps the popover on the hub rather than the wizard.
const ROSTER: WebDeviceSummary[] = [
  { deviceId: 'a', name: 'Phone', createdAt: 1, lastSeenAt: 1, allowInput: false, kind: 'phone' },
];

const TAILNET: WebTerminalInfo = {
  running: true,
  host: '127.0.0.1',
  port: 7681,
  tailscale: true,
  allowedHosts: ['desk.tail1234.ts.net'],
  urls: ['https://desk.tail1234.ts.net/?token=t', 'http://127.0.0.1:7681/?token=t'],
  allowInput: false,
};
const LOOPBACK: WebTerminalInfo = {
  running: true,
  host: '127.0.0.1',
  port: 7681,
  urls: ['http://127.0.0.1:7681/?token=t'],
  allowInput: false,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  status = { running: false };
  clipboard = '';
  tailscaleOk = true;
  start.mockReset().mockImplementation(async (args: { tailscale?: boolean; allowInput?: boolean }) => {
    status = { ...(args.tailscale ? TAILNET : LOOPBACK), allowInput: args.allowInput === true };
    return status;
  });
  pairStart.mockReset().mockImplementation(async (name: string, allowInput: boolean, flow: 'phone' | 'computer') => {
    status = { ...status, pairCode: 'QWXZ7K9M', pairExpiresAt: Date.now() + 600_000, pendingDeviceName: name, pendingDeviceAllowInput: allowInput, pendingPairFlow: flow };
    return status;
  });
  diagnose.mockReset().mockImplementation(async (): Promise<WebDiagnosis> => ({
    tailscale: tailscaleOk
      ? { ok: true, serve: 'free' }
      : { ok: false, problem: 'not-installed', lines: ['Error: tailscale is not on PATH.'] },
    web: status,
  }));
  writeEphemeral.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    web: {
      status: vi.fn(async () => status),
      start,
      stop: vi.fn(async () => ({ running: false })),
      pairStart,
      pairCancel: vi.fn(async () => status),
      diagnose,
      deviceList: vi.fn(async () => ({ devices: ROSTER })),
    },
  };
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = {
    writeText: vi.fn(async (text: string) => { clipboard = text; }),
    writeEphemeral,
    keepEphemeral: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { clipboardAPI?: unknown }).clipboardAPI;
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mountAndOpen(): Promise<void> {
  await act(async () => root.render(createElement(WebToggle)));
  await flush();
  const button = container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement;
  await act(async () => button.click());
  await flush();
}

function button(text: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === text);
  if (!b) throw new Error(`no button "${text}" in: ${document.body.textContent}`);
  return b;
}

async function click(text: string): Promise<void> {
  await act(async () => button(text).click());
  await flush();
}

describe('WebToggle — one click', () => {
  it('Pair a phone from a stopped server: tailnet start, input off, then the prefilled unique name', async () => {
    await mountAndOpen();
    expect((document.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Phone 2');
    await click('Pair a phone');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: true });
    expect(pairStart).toHaveBeenCalledWith('Phone 2', false, 'phone');
    expect(document.querySelector('[aria-label="QR code that pairs this phone"]')).not.toBeNull();
  });

  it('a click that beats the Tailscale check waits for it instead of starting on loopback', async () => {
    let answer: (d: WebDiagnosis) => void = () => undefined;
    diagnose.mockImplementationOnce(() => new Promise<WebDiagnosis>((resolve) => { answer = resolve; }));
    await mountAndOpen();
    await act(async () => button('Pair a phone').click());
    await flush();
    expect(start).not.toHaveBeenCalled();
    await act(async () => answer({ tailscale: { ok: true, serve: 'free' }, web: status }));
    await flush();
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: true });
  });

  it('without Tailscale keeps today\'s loopback default and offers no computer link', async () => {
    tailscaleOk = false;
    await mountAndOpen();
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'Connect another computer')).toBe(false);
    await click('Pair a phone');
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: false });
    expect(pairStart).toHaveBeenCalledWith('Phone 2', false, 'phone');
  });

  it('a transport the operator chose is sent as shown', async () => {
    await mountAndOpen();
    // The probe ticked the tailnet; unticking it is the operator's call.
    const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Serve over HTTPS (needs Tailscale) — required to pair a phone');
    const box = document.getElementById((label as HTMLLabelElement).htmlFor) as HTMLButtonElement;
    expect(box.getAttribute('aria-checked')).toBe('true');
    await act(async () => box.click());
    await flush();
    await click('Pair a phone');
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: false });
  });

  it('Connect another computer from a stopped server: one click puts the link on the clipboard', async () => {
    await mountAndOpen();
    await click('Connect another computer');
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: true });
    expect(pairStart).toHaveBeenCalledWith('Computer', false, 'computer');
    const link = 'https://desk.tail1234.ts.net/pair#wmux-desktop-code=QWXZ7K9M';
    expect(writeEphemeral).toHaveBeenCalledWith(link, expect.any(Number));
    expect(clipboard).toBe(link);
    expect(button('Copied')).toBeTruthy();
  });

  it('turns HTTPS on in place for a loopback server, keeping its input grant', async () => {
    status = { ...LOOPBACK, allowInput: true };
    await mountAndOpen();
    expect(document.body.textContent).toContain('1 paired device(s) will need to pair again.');
    await click('Turn on HTTPS over Tailscale');
    expect(start).toHaveBeenCalledWith({ tailscale: true, allowInput: true });
    expect(button('Create and copy link')).toBeTruthy();
  });

  it('a failed HTTPS restart keeps the running body and says why', async () => {
    status = LOOPBACK;
    start.mockImplementationOnce(async () => ({
      running: false,
      transportError: { reason: 'port-taken', lines: ['something else serves :443'] },
    }));
    await mountAndOpen();
    await click('Turn on HTTPS over Tailscale');
    expect(document.body.textContent).toContain('something else serves :443');
    expect(button('Stop')).toBeTruthy();
  });
});
