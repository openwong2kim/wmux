// @vitest-environment jsdom
//
// Phone access settings, stopped: a usable tailnet is ticked visibly before
// anything can start (never the LAN by default; input still off), Start
// starts what the boxes show, and nothing is paired from here — pairing is
// the Pair a phone dialog, a computer link is Connect a PC…. A running server
// is never restarted from here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
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
  // The Remote page's settings button opens straight on the settings view.
  await act(async () => root.render(<WebToggle variant="page" />));
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

function tailnetBox(): HTMLButtonElement {
  const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Serve over HTTPS (needs Tailscale) — required to pair a phone');
  return document.getElementById((label as HTMLLabelElement).htmlFor) as HTMLButtonElement;
}

async function toggleOpen(): Promise<void> {
  const button = container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement;
  await act(async () => button.click());
  await flush();
}

describe('WebToggle — one click', () => {
  it('Start from a stopped server: the tailnet the check ticked, input off, and no code minted', async () => {
    await mountAndOpen();
    expect(tailnetBox().getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('input[type="text"]')).toBeNull();
    await click('Start');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: true });
    expect(pairStart).not.toHaveBeenCalled();
  });

  it('the transport is not defaulted until the Tailscale check answers', async () => {
    let answer: (d: WebDiagnosis) => void = () => undefined;
    diagnose.mockImplementationOnce(() => new Promise<WebDiagnosis>((resolve) => { answer = resolve; }));
    await mountAndOpen();
    expect(document.body.textContent).toContain('Checking Tailscale…');
    expect(tailnetBox().getAttribute('aria-checked')).toBe('false');
    await act(async () => answer({ tailscale: { ok: true, serve: 'free' }, web: status }));
    await flush();
    expect(tailnetBox().getAttribute('aria-checked')).toBe('true');
  });

  it('plain Start never waits for the check and starts what the boxes show', async () => {
    diagnose.mockImplementationOnce(() => new Promise<WebDiagnosis>(() => undefined));
    await mountAndOpen();
    await click('Start');
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: false });
  });

  it('without Tailscale: says why, and offers no pairing of any kind', async () => {
    tailscaleOk = false;
    await mountAndOpen();
    expect(document.body.textContent).toContain('tailscale is not on PATH');
    const names = Array.from(document.querySelectorAll('button')).map((b) => b.textContent);
    expect(names).not.toContain('Pair a phone');
    expect(names).not.toContain('Connect another computer');
    expect(pairStart).not.toHaveBeenCalled();
  });

  it('unticked while usable: the inline fix ticks the box and starts with it', async () => {
    await mountAndOpen();
    await act(async () => tailnetBox().click());
    await flush();
    await click('Turn on HTTPS over Tailscale');
    expect(start).toHaveBeenCalledWith({ allowInput: false, expose: false, tailscale: true });
    expect(pairStart).not.toHaveBeenCalled();
  });

  it('each open decides afresh: an untick does not outlive the popover', async () => {
    await mountAndOpen();
    await act(async () => tailnetBox().click());
    await flush();
    expect(tailnetBox().getAttribute('aria-checked')).toBe('false');
    await toggleOpen(); // close
    await toggleOpen(); // reopen
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(tailnetBox().getAttribute('aria-checked')).toBe('true');
  });

  it('a default the check set is taken back when the next check finds no Tailscale', async () => {
    await mountAndOpen();
    expect(tailnetBox().getAttribute('aria-checked')).toBe('true');
    await toggleOpen();
    tailscaleOk = false;
    await toggleOpen();
    expect(tailnetBox().getAttribute('aria-checked')).toBe('false');
  });

  it('a check answering after unmount changes nothing', async () => {
    let answer: (d: WebDiagnosis) => void = () => undefined;
    diagnose.mockImplementationOnce(() => new Promise<WebDiagnosis>((resolve) => { answer = resolve; }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mountAndOpen();
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => answer({ tailscale: { ok: true, serve: 'free' }, web: status }));
    await flush();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a running server without HTTPS is never restarted from the popover', async () => {
    status = { ...LOOPBACK, allowInput: true };
    await mountAndOpen();
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'Turn on HTTPS over Tailscale')).toBe(false);
    expect(diagnose).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
