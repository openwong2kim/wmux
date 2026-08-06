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
  allowInput: true,
};

const OLD: WebDeviceSummary = {
  deviceId: 'dev-old',
  name: '',
  createdAt: NOW - 30 * 86_400_000,
  lastSeenAt: NOW - 20 * 86_400_000,
  allowInput: false,
};

function revokeButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    /Revoke/.test(b.textContent ?? ''),
  ) as HTMLButtonElement[];
}

describe('PairedDevicesModal', () => {
  let deviceList: ReturnType<typeof vi.fn>;
  let deviceRevoke: ReturnType<typeof vi.fn>;
  let deviceSetInput: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    deviceList = vi.fn().mockResolvedValue({ devices: [PHONE, OLD] });
    deviceRevoke = vi.fn().mockResolvedValue({ ok: true });
    deviceSetInput = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      web: { deviceList, deviceRevoke, deviceSetInput },
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
    deviceRevoke.mockResolvedValue({ ok: false, reason: 'persist-failed', closed: 2 });
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
    deviceList.mockResolvedValue({ devices: [], error: 'unavailable' });
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    expect(container.textContent).toContain('Could not read the device list');
    expect(container.textContent).not.toContain('No devices have paired');

    unmount();
  });

  // The revoke never reached the daemon, so nothing was necessarily cut. Saying
  // "its live connections were cut" here is a false safety claim.
  it('does not claim connections were cut when the daemon never answered', async () => {
    deviceRevoke.mockResolvedValue({ ok: false, reason: 'unknown' });
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    const btn = revokeButtons(container)[0]!;
    act(() => { btn.click(); });
    await flush();
    act(() => { btn.click(); });
    await flush();

    expect(container.textContent).toContain('not known whether this device was revoked');
    expect(container.textContent).not.toContain('live connections were cut');

    unmount();
  });

  // persist-failed with nothing actually cut earns the weaker sentence.
  it('does not claim a cut when the daemon reported closing zero streams', async () => {
    deviceRevoke.mockResolvedValue({ ok: false, reason: 'persist-failed', closed: 0 });
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    const btn = revokeButtons(container)[0]!;
    act(() => { btn.click(); });
    await flush();
    act(() => { btn.click(); });
    await flush();

    expect(container.textContent).toContain('no live connection was found to cut');

    unmount();
  });

  // On a credential surface, "we could not ask" must never render as "nobody
  // has access" — that is the one wrong answer that reads as reassuring.
  it('does not render an empty roster when the bridge is missing entirely', async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { web: {} };
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();

    expect(container.textContent).toContain('Could not read the device list');
    expect(container.textContent).not.toContain('No devices have paired');
    expect(container.textContent).not.toContain('0 active');

    unmount();
  });

  // The operator confirmed a destructive call; its verdict must not be
  // dismissable before it has been shown.
  it('ignores Escape and backdrop clicks while a revoke is in flight', async () => {
    let resolveRevoke: (v: unknown) => void = () => { /* replaced below */ };
    deviceRevoke.mockReturnValue(new Promise((r) => { resolveRevoke = r; }));
    const onClose = vi.fn();
    const { container, unmount } = render(<PairedDevicesModal onClose={onClose} />);
    await flush();

    const btn = revokeButtons(container)[0]!;
    act(() => { btn.click(); });
    await flush();
    act(() => { btn.click(); });   // confirm — revoke now pending
    await flush();

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();

    act(() => { resolveRevoke({ ok: true }); });
    await flush();

    // Once it has settled, Escape works again.
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalled();

    unmount();
  });

  it('drops stale rows when the post-revoke re-list fails', async () => {
    const { container, unmount } = render(<PairedDevicesModal onClose={() => { /* noop */ }} />);
    await flush();
    expect(container.textContent).toContain('iPhone');

    // The revoke lands, but the roster read that follows it does not.
    deviceList.mockResolvedValue({ devices: [], error: 'unavailable' });
    const btn = revokeButtons(container)[0]!;
    act(() => { btn.click(); });
    await flush();
    act(() => { btn.click(); });
    await flush();

    // The just-revoked device must not still be sitting there with a live
    // Revoke button and counted as active.
    expect(container.textContent).not.toContain('iPhone');
    expect(container.textContent).not.toContain('2 active');
    expect(container.textContent).toContain('Could not read the device list');

    unmount();
  });
});
