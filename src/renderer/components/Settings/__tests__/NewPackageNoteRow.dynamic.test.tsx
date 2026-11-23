// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewPackageNoteRow } from '../ClaudeIntegrationSection';

let container: HTMLDivElement;
let root: Root;
const get = vi.fn();
const set = vi.fn();
const t = (key: string) => key;
const sw = () => container.querySelector('[data-new-package-note]') as HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  set.mockReset();
  vi.stubGlobal('electronAPI', { newPackageNote: { get, set } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('NewPackageNoteRow', () => {
  it('a failed read is retried, and the switch comes back once a read succeeds', async () => {
    get.mockRejectedValueOnce(new Error('ipc down')).mockResolvedValueOnce({ enabled: false });
    await act(async () => root.render(<NewPackageNoteRow t={t} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(sw().dataset.newPackageNote).toBe('unknown');
    expect(sw().disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(get).toHaveBeenCalledTimes(2);
    expect(sw().dataset.newPackageNote).toBe('off');
    expect(sw().disabled).toBe(false);
  });

  it('after a write the saved value is read back, retrying a failed read too', async () => {
    get.mockResolvedValueOnce({ enabled: true });
    await act(async () => root.render(<NewPackageNoteRow t={t} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(sw().dataset.newPackageNote).toBe('on');
    set.mockResolvedValueOnce({ ok: true });
    get.mockRejectedValueOnce(new Error('ipc down')).mockResolvedValueOnce({ enabled: false });
    await act(async () => { sw().click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(set).toHaveBeenCalledWith(false);
    expect(sw().dataset.newPackageNote).toBe('unknown');
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(sw().dataset.newPackageNote).toBe('off');
  });

  it('stops retrying once the row is gone', async () => {
    get.mockRejectedValue(new Error('ipc down'));
    await act(async () => root.render(<NewPackageNoteRow t={t} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => root.render(<></>));
    const calls = get.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(get.mock.calls.length).toBe(calls);
  });
});
