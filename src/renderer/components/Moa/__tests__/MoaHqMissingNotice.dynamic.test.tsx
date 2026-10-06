// @vitest-environment jsdom
// While Moa is on and its workspace is gone, Moa recreates it on its own, once
// per lost id. Only when that fails does one persistent notice offer to
// recreate it; it goes away when the state recovers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MoaHqMissingNotice from '../MoaHqMissingNotice';
import { useStore } from '../../../stores';
import { setLocale } from '../../../i18n';
import type { MoaHqState, MoaState } from '../../../../shared/moa';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const moa = (state: MoaHqState, enabled = true): MoaState => ({
  config: { enabled, onboarded: true, level: 1, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
  hq: { workspaceId: state === 'unset' ? null : 'hq', state },
  archive: { unacked: 0, total: 0 },
});
const notices = () => useStore.getState().toasts.filter((t) => t.action?.label === 'Recreate Moa workspace');

let container: HTMLDivElement;
let root: Root;
let createMoaHq: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setLocale('en');
  createMoaHq = vi.fn(async () => ({ ok: true }));
  useStore.setState({ toasts: [], moa: null, createMoaHq } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MoaHqMissingNotice', () => {
  it('recreates the lost workspace on its own, once, and shows no notice when that works', async () => {
    await act(async () => root.render(<MoaHqMissingNotice />));
    expect(createMoaHq).not.toHaveBeenCalled();
    await act(async () => useStore.setState({ moa: moa('hq-missing') } as never));
    expect(createMoaHq).toHaveBeenCalledTimes(1);
    expect(notices()).toHaveLength(0);
    // The same lost id never triggers a second automatic attempt.
    await act(async () => useStore.setState({ moa: { ...moa('hq-missing') } } as never));
    expect(createMoaHq).toHaveBeenCalledTimes(1);
  });

  it('when the automatic attempt fails, shows one persistent notice and hides it once the state recovers', async () => {
    createMoaHq.mockResolvedValueOnce({ ok: false, code: 'failed' });
    await act(async () => root.render(<MoaHqMissingNotice />));
    await act(async () => useStore.setState({ moa: moa('hq-missing') } as never));
    expect(notices()).toHaveLength(1);
    expect(notices()[0].message).toBe("Moa's workspace is gone. Moa can't work until it is recreated.");
    expect(notices()[0].persist).toBe(true);
    await act(async () => useStore.setState({ moa: moa('ok') } as never));
    expect(notices()).toHaveLength(0);
  });

  it('does nothing while Moa is off or its workspace is fine', async () => {
    await act(async () => root.render(<MoaHqMissingNotice />));
    for (const m of [moa('hq-missing', false), moa('ok'), moa('unset'), moa('hq-unknown')]) {
      await act(async () => useStore.setState({ moa: m } as never));
      expect(notices()).toHaveLength(0);
    }
    expect(createMoaHq).not.toHaveBeenCalled();
  });

  it('the notice\'s action recreates the workspace, and comes back if that fails', async () => {
    createMoaHq.mockResolvedValueOnce({ ok: false, code: 'failed' });
    await act(async () => useStore.setState({ moa: moa('hq-missing') } as never));
    await act(async () => root.render(<MoaHqMissingNotice />));
    createMoaHq.mockResolvedValueOnce({ ok: false, code: 'failed' });
    const first = notices()[0];
    // ToastContainer runs the action, then dismisses the toast.
    await act(async () => { first.action!.onClick(); useStore.getState().dismissToast(first.id); });
    expect(createMoaHq).toHaveBeenCalledTimes(2);
    expect(useStore.getState().toasts.some((t) => t.level === 'error')).toBe(true);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].id).not.toBe(first.id);
  });
});
