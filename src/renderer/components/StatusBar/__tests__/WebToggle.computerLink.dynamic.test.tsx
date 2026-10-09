// @vitest-environment jsdom
//
// The mounted "Connect another computer" card: it pairs with ITS OWN name and
// grant under the computer flow, cancels the other card's pairing on request,
// and takes a copied link back off the clipboard only while the clipboard
// still holds exactly that link.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WebToggle from '../WebToggle';
import type { WebTerminalInfo } from '../../../../shared/web';
import { EphemeralClipboard } from '../../../../main/clipboard/ephemeralClipboard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let status: WebTerminalInfo;
let clipboard = '';
const pairStart = vi.fn();
const pairCancel = vi.fn();
const writeText = vi.fn(async (text: string) => { clipboard = text; });
const readText = vi.fn(async () => clipboard);
// The real main-process owner of the copied link, wired to the fake board —
// so these tests exercise the same clear rules the app runs.
let ephemeral: EphemeralClipboard;
const writeEphemeral = vi.fn(async (text: string, ttl: number) => ephemeral.write(text, ttl));
const keepEphemeral = vi.fn(async (stillValid: string) => ephemeral.keepOnly(stillValid));

const tailnet: WebTerminalInfo = {
  running: true,
  host: '127.0.0.1',
  port: 7681,
  urls: ['https://desk.tail1234.ts.net/?token=t', 'http://127.0.0.1:7681/?token=t'],
  allowedHosts: ['desk.tail1234.ts.net'],
  tailscale: true,
};
const LINK = 'https://desk.tail1234.ts.net/pair#wmux-desktop-code=QWXZ7K9M';
const computerPending: WebTerminalInfo = {
  ...tailnet,
  pairCode: 'QWXZ7K9M',
  pairExpiresAt: Date.now() + 600_000,
  pendingDeviceName: 'Computer',
  pendingDeviceAllowInput: false,
  pendingPairFlow: 'computer',
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  clipboard = '';
  pairStart.mockReset();
  pairCancel.mockReset();
  writeText.mockClear();
  readText.mockClear();
  writeEphemeral.mockClear();
  keepEphemeral.mockClear();
  ephemeral = new EphemeralClipboard({ readText: () => clipboard, writeText: (t) => { clipboard = t; } });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    web: {
      status: vi.fn(async () => status),
      pairStart,
      pairCancel,
      deviceList: vi.fn(async () => ({ devices: [] })),
    },
  };
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = { writeText, readText, writeEphemeral, keepEphemeral };
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
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

async function mountAndOpen(): Promise<void> {
  await act(async () => root.render(createElement(WebToggle)));
  await flush();
  const button = container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement;
  await act(async () => button.click());
  await flush();
}

function buttonNamed(text: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
}

describe('WebToggle — Connect another computer', () => {
  it('starts the computer flow with its own prefilled name and unticked grant, and copies the link at once', async () => {
    status = tailnet;
    pairStart.mockResolvedValue(computerPending);
    await mountAndOpen();
    await act(async () => buttonNamed('Create and copy link').click());
    await flush();
    expect(pairStart).toHaveBeenCalledWith('Computer', false, 'computer');
    expect(document.querySelector('[data-testid="web-computer-link"]')?.textContent).toBe(LINK);
    expect(writeEphemeral).toHaveBeenCalledWith(LINK, expect.any(Number));
    expect(clipboard).toBe(LINK);
    expect(buttonNamed('Copied')).toBeTruthy();
  });

  it('the phone card cancels a live computer pairing instead of starting over it', async () => {
    status = computerPending;
    pairCancel.mockResolvedValue(tailnet);
    await mountAndOpen();
    expect(document.body.textContent).toContain('Another computer is being paired right now');
    await act(async () => buttonNamed('Cancel the pairing in progress').click());
    await flush();
    expect(pairCancel).toHaveBeenCalledTimes(1);
    expect(pairStart).not.toHaveBeenCalled();
  });

  it('clears the copied link once it is consumed — only if the clipboard still holds it', async () => {
    status = computerPending;
    await mountAndOpen();
    await act(async () => buttonNamed('Copy link').click());
    await flush();
    expect(clipboard).toBe(LINK);

    // The other computer redeemed it: the next poll shows no pending pairing.
    status = tailnet;
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(keepEphemeral).toHaveBeenLastCalledWith('');
    expect(clipboard).toBe('');
  });

  it('survives a remount (Sidebar ↔ MiniSidebar): the link is still cleared at expiry', async () => {
    status = { ...computerPending, pairExpiresAt: Date.now() + 5_000 };
    await mountAndOpen();
    await act(async () => buttonNamed('Copy link').click());
    await flush();
    expect(writeEphemeral).toHaveBeenCalledWith(LINK, expect.any(Number));
    // The component goes away; main still owns the link and its expiry.
    act(() => root.unmount());
    root = createRoot(container);
    expect(clipboard).toBe(LINK);
    await act(async () => { vi.advanceTimersByTime(6_000); });
    expect(clipboard).toBe('');
  });

  it('a fresh mount does not wipe a still-valid copied link before its first status read', async () => {
    ephemeral.write(LINK, 600_000);
    status = computerPending;
    await mountAndOpen();
    expect(keepEphemeral).not.toHaveBeenCalledWith('');
    expect(clipboard).toBe(LINK);
  });

  it('leaves the clipboard alone when the operator copied something else since', async () => {
    status = computerPending;
    await mountAndOpen();
    await act(async () => buttonNamed('Copy link').click());
    await flush();
    clipboard = 'something the operator copied later';
    status = tailnet;
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(clipboard).toBe('something the operator copied later');
  });

  it('clears the copied link at expiry even while the popover is closed', async () => {
    status = { ...computerPending, pairExpiresAt: Date.now() + 5_000 };
    await mountAndOpen();
    await act(async () => buttonNamed('Copy link').click());
    await flush();
    // Close the popover: no polling from here on.
    const button = container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement;
    await act(async () => button.click());
    await act(async () => { vi.advanceTimersByTime(6_000); });
    await flush();
    expect(clipboard).toBe('');
  });
});
