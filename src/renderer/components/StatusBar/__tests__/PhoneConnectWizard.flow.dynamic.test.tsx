// @vitest-environment jsdom
//
// The phone wizard as the mounted Remote popover drives it: shown on its own
// when nothing is paired, reachable by link when something is, and mapped onto
// the existing permission model — Remote control raises the server's input
// ceiling and grants the device, View only never lowers anyone else's.

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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  status = { running: false };
  roster = [];
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
      pairCancel: vi.fn(async () => status),
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

function button(text: string): HTMLButtonElement {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent === text);
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

function stepText(): string {
  return document.querySelector('[data-testid="wizard-step"]')?.textContent ?? '';
}

describe('phone wizard — mounted', () => {
  it('opens by itself on an empty roster and walks check → permissions → QR → connected', async () => {
    await mountAndOpen();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(stepText()).toBe('Step 1 of 4');

    await click('Next');
    expect(stepText()).toBe('Step 2 of 4');
    await click('Remote control');
    await typeName('my phone');
    await click('Show QR code');

    // Stopped → started over the tailnet with the input ceiling raised.
    expect(start).toHaveBeenCalledWith({ tailscale: true, allowInput: true });
    expect(setGrants).not.toHaveBeenCalled();
    expect(pairStart).toHaveBeenCalledWith('my phone', true, 'phone');
    expect(stepText()).toBe('Step 3 of 4');
    expect(document.querySelector('[aria-label="QR code that pairs this phone"]')).not.toBeNull();

    // The phone redeems the code: it appears on the roster, seen just now.
    roster = [
      {
        deviceId: 'dev-1',
        name: 'my phone',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        allowInput: true,
        kind: 'phone',
        activeNow: true,
      },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await flush();
    expect(stepText()).toBe('Step 4 of 4');
    expect(document.body.textContent).toContain('“my phone” is connected.');
    expect(document.querySelector('[data-testid="wizard-devices"]')?.textContent).toContain('my phone');
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
    expect(button('Next')).toBeTruthy();
  });

  it('View only on a running server with input on never lowers the ceiling', async () => {
    status = { ...FRONTED, allowInput: true };
    await mountAndOpen();
    await click('Next');
    await typeName('tablet');
    await click('Show QR code');
    expect(start).not.toHaveBeenCalled();
    expect(setGrants).not.toHaveBeenCalled();
    expect(pairStart).toHaveBeenCalledWith('tablet', false, 'phone');
  });

  it('Remote control on a running read-only server raises input in place', async () => {
    status = { ...FRONTED, allowInput: false };
    await mountAndOpen();
    await click('Next');
    await click('Remote control');
    await typeName('tablet');
    await click('Show QR code');
    expect(setGrants).toHaveBeenCalledWith({ allowInput: true });
    expect(pairStart).toHaveBeenCalledWith('tablet', true, 'phone');
  });

  it('with a device already paired the hub stays, and the wizard is one link away', async () => {
    roster = [{ deviceId: 'old', name: 'old', createdAt: 1, lastSeenAt: 1, allowInput: false }];
    await mountAndOpen();
    expect(stepText()).toBe('');
    expect(button('Start')).toBeTruthy();
    await click('Connect a phone step by step');
    expect(stepText()).toBe('Step 1 of 4');
    await click('All settings');
    expect(button('Start')).toBeTruthy();
  });
});
