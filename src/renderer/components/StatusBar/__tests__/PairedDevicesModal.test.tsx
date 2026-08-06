// @vitest-environment jsdom
//
// PairedDevicesModal contract: it is the only operator surface that can call
// daemon.web.deviceRevoke. Revocation is permanent, so the two-step confirm and
// the honest reporting of a failed roster write are part of the contract, not
// polish.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import PairedDevicesModal from '../PairedDevicesModal';
import type { WebDeviceSummary } from '../../../../shared/web';

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush(ticks = 8) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  });
}

const NOW = 1_800_000_000_000;

const PHONE: WebDeviceSummary = {
  deviceId: 'dev-phone',
  name: 'iPhone',
  createdAt: NOW - 86_400_000,
  lastSeenAt: NOW - 60_000,
};

const OLD: WebDeviceSummary = {
  deviceId: 'dev-old',
  name: '',
  createdAt: NOW - 30 * 86_400_000,
  lastSeenAt: NOW - 20 * 86_400_000,
};

function revokeButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    /Revoke/.test(b.textContent ?? ''),
  ) as HTMLButtonElement[];
}

describe('PairedDevicesModal', () => {
  let deviceList: ReturnType<typeof vi.fn>;
  let deviceRevoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    deviceList = vi.fn().mockResolvedValue({ devices: [PHONE, OLD] });
    deviceRevoke = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      web: { deviceList, deviceRevoke },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('lists the roster and names a device that paired before naming was required', async () => {
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    expect(deviceList).toHaveBeenCalled();
    expect(container.textContent).toContain('iPhone');
    expect(container.textContent).toContain('Unnamed device');

    unmount();
  });

  // Revocation is permanent and the rows look alike. One stray click next to
  // the wrong name must not be able to cut a device off.
  it('does not revoke on the first click — it asks first', async () => {
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    const btn = revokeButtons(container)[0]!;
    act(() => { btn.click(); });
    await flush();

    expect(deviceRevoke).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Revoke for good?');

    unmount();
  });

  it('revokes on the confirming second click and re-lists', async () => {
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    const btn = revokeButtons(container)[0]!;
    act(() => { btn.click(); });
    await flush();
    act(() => { btn.click(); });
    await flush();

    expect(deviceRevoke).toHaveBeenCalledWith('dev-phone');
    expect(deviceList).toHaveBeenCalledTimes(2); // initial + post-revoke re-list

    unmount();
  });

  // The dangerous half-success: streams cut, roster write lost. Saying "done"
  // here would leave the operator believing a credential is gone when it comes
  // back on the next daemon boot.
  it('says the device will return when the roster write failed', async () => {
    deviceRevoke.mockResolvedValue({ ok: false, reason: 'persist-failed' });
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    const btn = revokeButtons(container)[0]!;
    act(() => { btn.click(); });
    await flush();
    act(() => { btn.click(); });
    await flush();

    expect(container.textContent).toContain('will come back when the daemon restarts');

    unmount();
  });

  it('shows a revoked device as a tombstone with no revoke button', async () => {
    deviceList.mockResolvedValue({ devices: [{ ...PHONE, revokedAt: NOW - 1000 }] });
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    expect(container.textContent).toContain('revoked');
    expect(revokeButtons(container)).toHaveLength(0);

    unmount();
  });

  it('surfaces a list error instead of rendering an empty roster', async () => {
    deviceList.mockResolvedValue({ devices: [], error: 'daemon is not running' });
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    expect(container.textContent).toContain('daemon is not running');
    expect(container.textContent).not.toContain('No devices have paired');

    unmount();
  });
});
