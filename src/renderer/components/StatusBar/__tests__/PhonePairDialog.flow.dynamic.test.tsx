// @vitest-environment jsdom
//
// The Pair a phone dialog as the app mounts it, mapped onto the existing
// permission model: Can type raises the server's input ceiling only after the
// operator confirms who else that reaches (re-read at the click, never from a
// stale screen), View only never lowers it, the upload grant is never sent,
// and every way the dialog goes away before a phone arrives burns the code and
// puts the ceiling back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PhonePairDialog from '../PhonePairDialog';
import type { WebDeviceSummary, WebDiagnosis, WebTerminalInfo } from '../../../../shared/web';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let status: WebTerminalInfo;
let roster: WebDeviceSummary[];
let tailscaleOk: boolean;
const start = vi.fn();
const setGrants = vi.fn();
const pairStart = vi.fn();
const pairCancel = vi.fn();
const diagnose = vi.fn();
const onClose = vi.fn();
const onOpenSettings = vi.fn();

const FRONTED: WebTerminalInfo = {
  running: true,
  host: '127.0.0.1',
  port: 7681,
  tailscale: true,
  allowedHosts: ['box.example.ts.net'],
  urls: ['https://box.example.ts.net/?token=t', 'http://127.0.0.1:7681/?token=t'],
  allowInput: false,
  allowUpload: false,
};

const withoutPending = (s: WebTerminalInfo): WebTerminalInfo => ({
  ...s,
  pairCode: 'ROTATED1',
  pendingDeviceName: undefined,
  pendingDeviceAllowInput: undefined,
  pendingPairFlow: undefined,
});

const typingPhone: WebDeviceSummary = { deviceId: 'd0', name: 'Phone', createdAt: 1, lastSeenAt: 1, allowInput: true, kind: 'phone' };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  status = { running: false };
  roster = [];
  tailscaleOk = true;
  onClose.mockReset();
  onOpenSettings.mockReset();
  start.mockReset().mockImplementation(async (args: { allowInput?: boolean }) => {
    status = { ...FRONTED, allowInput: args.allowInput === true };
    return status;
  });
  setGrants.mockReset().mockImplementation(async (g: Record<string, boolean>) => {
    status = { ...status, ...g };
    return status;
  });
  pairStart.mockReset().mockImplementation(async (name: string, allowInput: boolean) => {
    status = { ...status, pairCode: 'ABCD2345', pendingDeviceName: name, pendingDeviceAllowInput: allowInput, pendingPairFlow: 'phone' };
    return status;
  });
  pairCancel.mockReset().mockImplementation(async () => {
    status = withoutPending(status);
    return status;
  });
  diagnose.mockReset().mockImplementation(async (): Promise<WebDiagnosis> => ({
    tailscale: tailscaleOk ? { ok: true, serve: 'free' } : { ok: false, problem: 'not-installed', lines: ['Error: tailscale is not on PATH.'] },
    web: status,
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    web: {
      status: vi.fn(async () => status),
      start,
      stop: vi.fn(async () => ({ running: false })),
      setGrants,
      pairStart,
      pairCancel,
      diagnose,
      deviceList: vi.fn(async () => ({ devices: roster })),
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function open(): Promise<void> {
  await act(async () => root.render(createElement(PhonePairDialog, { onClose, onOpenSettings })));
  await flush();
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((x) => x.textContent === text);
}

function button(text: string): HTMLButtonElement {
  const b = findButton(text);
  if (!b) throw new Error(`no button "${text}" in: ${document.body.textContent}`);
  return b;
}

async function click(text: string): Promise<void> {
  await act(async () => button(text).click());
  await flush();
}

async function tick(ms = 2_100): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

async function confirmShared(): Promise<void> {
  const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'I understand this also changes access for other devices');
  await act(async () => (label as HTMLLabelElement).click());
  await flush();
}

/** Get to the QR as a Can type pairing on a running read-only server, confirming who else can type. */
async function toQrWithRaise(): Promise<void> {
  status = { ...FRONTED };
  roster = [typingPhone];
  await open();
  await click('Can type');
  await confirmShared();
  await click('Pair');
  expect(setGrants).toHaveBeenCalledWith({ allowInput: true });
  expect(status.allowInput).toBe(true);
  expect(document.body.textContent).toContain('Waiting for the phone…');
}

const restoredAfterAbandon = () => {
  expect(pairCancel).toHaveBeenCalledTimes(1);
  expect(setGrants).toHaveBeenLastCalledWith({ allowInput: false });
  expect(status.allowInput).toBe(false);
};

describe('PhonePairDialog', () => {
  it('stopped server: one Pair starts with the tailnet, view only, the prefilled unique name — then the phone arrives', async () => {
    roster = [{ ...typingPhone, allowInput: false }];
    await open();
    expect(document.body.textContent).toContain('Ready. Tailscale can serve this computer over HTTPS.');
    expect((document.querySelector('[data-testid="pair-name"]') as HTMLInputElement).value).toBe('Phone 2');
    await click('Pair');
    expect(start).toHaveBeenCalledWith({ tailscale: true, allowInput: false });
    expect(pairStart).toHaveBeenCalledWith('Phone 2', false, 'phone');
    expect(document.querySelector('[aria-label="QR code that pairs this phone"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Pair a phone · Phone 2');

    // The phone redeems the code: it leaves status, and the device it minted shows up.
    status = withoutPending(status);
    roster = [...roster, { deviceId: 'd2', name: 'Phone 2', createdAt: Date.now() + 1, lastSeenAt: Date.now(), allowInput: false, kind: 'phone' }];
    await tick();
    expect(document.body.textContent).toContain('“Phone 2” is connected · View only');
    await click('Done');
    expect(onClose).toHaveBeenCalledTimes(1);
    // Nothing to undo after a phone arrived.
    expect(pairCancel).not.toHaveBeenCalled();
  });

  it('Can type on a stopped server nobody else can type on: starts with input on, pairs a phone that can type', async () => {
    await open();
    await click('Can type');
    expect(document.querySelector('[data-testid="pair-impacts"]')).toBeNull();
    await click('Pair');
    expect(start).toHaveBeenCalledWith({ tailscale: true, allowInput: true });
    expect(pairStart).toHaveBeenCalledWith('Phone', true, 'phone');
  });

  it('never sends the upload grant, on a start or a raise', async () => {
    await toQrWithRaise();
    for (const [g] of setGrants.mock.calls) expect(g).not.toHaveProperty('allowUpload');
    for (const [a] of start.mock.calls) expect(a).not.toHaveProperty('allowUpload');
  });

  it('Can type that reaches other devices: no Pair until confirmed', async () => {
    status = { ...FRONTED };
    roster = [typingPhone];
    await open();
    await click('Can type');
    expect(document.querySelector('[data-testid="pair-impacts"]')).not.toBeNull();
    expect(button('Pair').disabled).toBe(true);
    await confirmShared();
    expect(button('Pair').disabled).toBe(false);
    // Changing the choice takes the confirmation back.
    await click('View only');
    await click('Can type');
    expect(button('Pair').disabled).toBe(true);
  });

  it('re-reads the server at the click: input turned off since the screen was drawn shows its notice and mints nothing', async () => {
    status = { ...FRONTED, allowInput: true };
    roster = [typingPhone];
    await open();
    await click('Can type');
    expect(document.querySelector('[data-testid="pair-impacts"]')).toBeNull();
    status = { ...status, allowInput: false };
    await click('Pair');
    expect(pairStart).not.toHaveBeenCalled();
    expect(setGrants).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="pair-impacts"]')).not.toBeNull();
  });

  it('View only on a running server with input on never lowers the ceiling', async () => {
    status = { ...FRONTED, allowInput: true };
    await open();
    await click('Pair');
    expect(setGrants).not.toHaveBeenCalled();
    expect(pairStart).toHaveBeenCalledWith('Phone', false, 'phone');
  });

  it('× during the QR burns the code and puts the ceiling back', async () => {
    await toQrWithRaise();
    await act(async () => (document.querySelector('[data-testid="pair-close"]') as HTMLButtonElement).click());
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    restoredAfterAbandon();
  });

  it('Escape during the QR does the same', async () => {
    await toQrWithRaise();
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    restoredAfterAbandon();
  });

  it('Cancel pairing goes back to the form and does the same', async () => {
    await toQrWithRaise();
    await click('Cancel the pairing in progress');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="pair-submit"]')).not.toBeNull();
    restoredAfterAbandon();
  });

  it('closing just after the phone redeemed the code keeps the input it was paired with', async () => {
    await toQrWithRaise();
    // Redeemed between two watcher reads: the code is gone, the device exists.
    status = withoutPending(status);
    roster = [...roster, { deviceId: 'd9', name: 'Phone 2', createdAt: Date.now() + 1, lastSeenAt: Date.now(), allowInput: true, kind: 'phone' }];
    await act(async () => (document.querySelector('[data-testid="pair-close"]') as HTMLButtonElement).click());
    await flush();
    expect(setGrants).toHaveBeenCalledTimes(1);
    expect(status.allowInput).toBe(true);
  });

  it('a computer link Connect a PC… handed out is never replaced by a phone code', async () => {
    status = { ...FRONTED, pairCode: 'QWXZ7K9M', pendingDeviceName: 'Computer', pendingPairFlow: 'computer' };
    await open();
    await click('Pair');
    expect(pairStart).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('A computer is being paired right now');
  });

  it('readiness follows the server the dialog itself started', async () => {
    await open();
    expect(document.body.textContent).toContain('Ready. Tailscale can serve this computer over HTTPS.');
    await click('Pair');
    await click('Cancel the pairing in progress');
    expect(document.body.textContent).toContain('Ready. This computer is already shared over HTTPS.');
  });

  it('the host unmounting it during the QR does the same', async () => {
    await toQrWithRaise();
    act(() => root.unmount());
    root = createRoot(container);
    await flush();
    restoredAfterAbandon();
  });

  it('a code that lapses without a phone goes back to the form, says so, and restores the ceiling', async () => {
    await toQrWithRaise();
    status = withoutPending(status);
    await tick();
    await tick();
    await tick();
    expect(document.body.textContent).toContain('The code was used or cancelled before this phone connected.');
    expect(document.querySelector('[data-testid="pair-submit"]')).not.toBeNull();
    expect(setGrants).toHaveBeenLastCalledWith({ allowInput: false });
    expect(pairCancel).not.toHaveBeenCalled();
  });

  it('a Tailscale problem quotes why, and Check again re-runs the check', async () => {
    tailscaleOk = false;
    await open();
    expect(document.body.textContent).toContain('tailscale is not on PATH');
    expect(button('Pair').disabled).toBe(true);
    tailscaleOk = true;
    await click('Check again');
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(button('Pair').disabled).toBe(false);
  });

  it('sharing without HTTPS: Phone access settings closes this and opens the settings', async () => {
    status = { running: true, host: '127.0.0.1', urls: ['http://127.0.0.1:7681/?token=t'] };
    await open();
    expect(button('Pair').disabled).toBe(true);
    await click('Phone access settings…');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
});
