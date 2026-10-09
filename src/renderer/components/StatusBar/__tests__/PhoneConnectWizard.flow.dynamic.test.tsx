// @vitest-environment jsdom
//
// The phone wizard as the mounted Remote popover drives it: shown on its own
// when nothing is paired, reachable by link when something is, and mapped onto
// the existing permission model — Remote control raises the server's input
// ceiling only after the operator confirms who else that reaches, and a
// pairing abandoned before a phone arrives puts the ceiling back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WebToggle from '../WebToggle';
import type { WebDeviceSummary, WebDiagnosis, WebTerminalInfo } from '../../../../shared/web';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let status: WebTerminalInfo;
let roster: WebDeviceSummary[];
const start = vi.fn();
const setGrants = vi.fn();
const pairStart = vi.fn();
const pairCancel = vi.fn();
const diagnose = vi.fn();

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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  status = { running: false };
  roster = [];
  start.mockReset().mockImplementation(async (args: { allowInput?: boolean; allowUpload?: boolean }) => {
    status = { ...FRONTED, allowInput: args.allowInput === true, allowUpload: args.allowUpload === true };
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
    tailscale: { ok: true, serve: 'free' },
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
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

async function toggle(): Promise<void> {
  const button = container.querySelector('[data-testid="deck-web-toggle"]') as HTMLButtonElement;
  await act(async () => button.click());
  await flush();
}

async function mountAndOpen(): Promise<void> {
  await act(async () => root.render(createElement(WebToggle)));
  await flush();
  await toggle();
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

async function typeName(value: string): Promise<void> {
  const input = document.querySelector('input[type="text"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function tick(ms = 2_100): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

/** The phone redeems the live code: the daemon burns it and mints the device. */
function redeem(name: string): void {
  status = withoutPending(status);
  roster = [
    ...roster,
    { deviceId: `dev-${name}`, name, createdAt: Date.now(), lastSeenAt: Date.now(), allowInput: true, kind: 'phone', activeNow: true },
  ];
}

function stepText(): string {
  return document.querySelector('[data-testid="wizard-step"]')?.textContent ?? '';
}

describe('phone wizard — mounted', () => {
  it('opens by itself on an empty roster and walks check → permissions → QR → connected', async () => {
    await mountAndOpen();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(stepText()).toBe('Step 1 of 4');

    await click('Options…');
    expect(stepText()).toBe('Step 2 of 4');
    await click('Remote control');
    await typeName('my phone');
    await click('Show QR code');

    // Stopped → started over the tailnet, every shown grant sent explicitly.
    expect(start).toHaveBeenCalledWith({ tailscale: true, allowInput: true, allowUpload: false });
    expect(setGrants).not.toHaveBeenCalled();
    expect(pairStart).toHaveBeenCalledWith('my phone', true, 'phone');
    expect(stepText()).toBe('Step 3 of 4');
    expect(document.querySelector('[aria-label="QR code that pairs this phone"]')).not.toBeNull();

    redeem('my phone');
    await tick();
    expect(stepText()).toBe('Step 4 of 4');
    expect(document.body.textContent).toContain('“my phone” is connected.');
    expect(document.querySelector('[data-testid="wizard-devices"]')?.textContent).toContain('my phone');
    expect(setGrants).not.toHaveBeenCalled();
  });

  it('Pair a phone on step 1: one click to the QR, view only, prefilled name', async () => {
    await mountAndOpen();
    await click('Pair a phone');
    // Same start as step 2's defaults: tailnet, input off, upload off.
    expect(start).toHaveBeenCalledWith({ tailscale: true, allowInput: false, allowUpload: false });
    expect(setGrants).not.toHaveBeenCalled();
    expect(pairStart).toHaveBeenCalledWith('Phone', false, 'phone');
    expect(stepText()).toBe('Step 3 of 4');
    expect(document.querySelector('[aria-label="QR code that pairs this phone"]')).not.toBeNull();
  });

  it('Pair a phone on step 1 leaves a running server\'s grants as they are', async () => {
    status = { ...FRONTED, allowUpload: true };
    await mountAndOpen();
    await click('Pair a phone');
    expect(start).not.toHaveBeenCalled();
    expect(setGrants).not.toHaveBeenCalled();
    expect(pairStart).toHaveBeenCalledWith('Phone', false, 'phone');
  });

  it('a problem shows describeTailscaleProblem text and a retry that re-runs the check', async () => {
    diagnose.mockImplementationOnce(async () => ({
      tailscale: { ok: false, problem: 'not-logged-in', lines: ['Error: Tailscale is installed but not logged in.'] },
      web: status,
    }));
    await mountAndOpen();
    expect(document.body.textContent).toContain('not logged in');
    await click('Check again');
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(button('Pair a phone')).toBeTruthy();
  });

  it('View only on a running server with input on never lowers the ceiling', async () => {
    status = { ...FRONTED, allowInput: true };
    await mountAndOpen();
    await click('Options…');
    await typeName('tablet');
    await click('Show QR code');
    expect(start).not.toHaveBeenCalled();
    expect(setGrants).not.toHaveBeenCalled();
    expect(pairStart).toHaveBeenCalledWith('tablet', false, 'phone');
  });

  it('Remote control on a running read-only server: confirm who else can type, raise, and put it back on Cancel', async () => {
    status = { ...FRONTED, allowInput: false };
    await mountAndOpen();
    // Nothing paired yet → wizard; but a legacy device shows up in the roster
    // read on step 2 and would start typing too.
    roster = [{ deviceId: 'old', name: 'old', createdAt: 1, lastSeenAt: 1, allowInput: true }];
    await click('Options…');
    await click('Remote control');
    await typeName('tablet');
    const impacts = document.querySelector('[data-testid="wizard-impacts"]')?.textContent ?? '';
    expect(impacts).toContain('1 paired device(s) already allowed to type');
    expect(button('Show QR code').disabled).toBe(true);

    const ack = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith('I understand'));
    const box = document.getElementById((ack as HTMLLabelElement).htmlFor) as HTMLButtonElement;
    await act(async () => box.click());
    await flush();
    await click('Show QR code');
    expect(setGrants).toHaveBeenCalledWith({ allowInput: true });
    expect(pairStart).toHaveBeenCalledWith('tablet', true, 'phone');

    await click('Cancel');
    expect(pairCancel).toHaveBeenCalled();
    expect(setGrants).toHaveBeenLastCalledWith({ allowInput: false });
    expect(stepText()).toBe('Step 2 of 4');
  });

  it('a phone that pairs while the popover is closed is found on reopen', async () => {
    await mountAndOpen();
    await click('Options…');
    await typeName('my phone');
    await click('Show QR code');
    expect(stepText()).toBe('Step 3 of 4');

    await toggle(); // close
    redeem('my phone');
    await toggle(); // reopen
    await tick();
    expect(stepText()).toBe('Step 4 of 4');
    expect(document.body.textContent).toContain('“my phone” is connected.');
  });

  it('a code that lapses without a phone goes back to step 2 and restores the ceiling', async () => {
    await mountAndOpen();
    await click('Options…');
    await click('Remote control');
    await typeName('my phone');
    await click('Show QR code');
    status = withoutPending(status); // cancelled from elsewhere, nobody paired
    await tick(2_100 * 4);
    expect(stepText()).toBe('Step 2 of 4');
    expect(document.body.textContent).toContain('The code was used or cancelled');
    expect(setGrants).toHaveBeenLastCalledWith({ allowInput: false });
  });

  it('with a device already paired the hub stays, the wizard is one link away, and closing resets it', async () => {
    roster = [{ deviceId: 'old', name: 'old', createdAt: 1, lastSeenAt: 1, allowInput: false }];
    await mountAndOpen();
    expect(stepText()).toBe('');
    expect(button('Start')).toBeTruthy();
    await click('Connect a phone step by step');
    expect(stepText()).toBe('Step 1 of 4');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await flush();
    await toggle();
    expect(stepText()).toBe('');
    expect(findButton('Start')).toBeTruthy();
  });
});
