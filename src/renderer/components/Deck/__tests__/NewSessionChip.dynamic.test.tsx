// @vitest-environment jsdom
//
// NewSessionChip: the two-step armed confirm, and the clear→wake pairing that
// keeps the operator from being left with a dead dock. Injected fake api so no
// preload/IPC is needed.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { NewSessionChip, type NewSessionApi } from '../NewSessionChip';

// Silences React's "not configured to support act(...)" warning — the same
// opt-in the other dynamic component tests in this repo use.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (k: string) => k; // identity — assert on keys

function render(ui: React.ReactElement): { container: HTMLElement; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    cleanup: () => { act(() => root.unmount()); container.remove(); },
  };
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function mount(api: NewSessionApi, props: { busy?: boolean; workspaceId?: string } = {}) {
  const r = render(
    <NewSessionChip
      workspaceId={props.workspaceId ?? 'ws-1'}
      api={api}
      busy={props.busy}
      t={t}
    />,
  );
  cleanups.push(r.cleanup);
  const btn = () => r.container.querySelector('[data-deck-new-session]') as HTMLButtonElement;
  return { ...r, btn };
}

function fakeApi(overrides: Partial<NewSessionApi> = {}) {
  const calls: string[] = [];
  const api: NewSessionApi = {
    clear: vi.fn(async (id: string) => { calls.push(`clear:${id}`); return { ok: true }; }),
    wake: vi.fn(async (id: string) => { calls.push(`wake:${id}`); return { ok: true }; }),
    ...overrides,
  };
  return { api, calls };
}

describe('NewSessionChip — two-step armed confirm', () => {
  it('does NOT fire on the first click; it arms', async () => {
    const { api } = fakeApi();
    const { btn } = mount(api);
    await act(async () => { btn().click(); });
    expect(btn().dataset.armed).toBe('true');
    expect(api.clear).not.toHaveBeenCalled();
  });

  it('fires on the second click', async () => {
    const { api, calls } = fakeApi();
    const { btn } = mount(api);
    await act(async () => { btn().click(); });
    await act(async () => { btn().click(); });
    await flush();
    expect(calls).toEqual(['clear:ws-1', 'wake:ws-1']);
  });

  it('disarms on mouse-leave, so a stray second click cannot commit', async () => {
    const { api } = fakeApi();
    const { btn } = mount(api);
    await act(async () => { btn().click(); });
    await act(async () => { btn().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(btn().dataset.armed).toBe('false');
    await act(async () => { btn().click(); });
    expect(api.clear).not.toHaveBeenCalled();
  });

  it('disarms when the workspace changes — arming intent must not follow the operator', async () => {
    const { api } = fakeApi();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const ui = (wsId: string) => (
      <NewSessionChip workspaceId={wsId} api={api} t={t} />
    );
    act(() => root.render(ui('ws-1')));
    cleanups.push(() => { act(() => root.unmount()); container.remove(); });
    const btn = () => container.querySelector('[data-deck-new-session]') as HTMLButtonElement;
    await act(async () => { btn().click(); });
    expect(btn().dataset.armed).toBe('true');
    act(() => root.render(ui('ws-2')));
    expect(btn().dataset.armed).toBe('false');
    // A click now only re-arms — it must not clear the workspace the operator
    // just switched to.
    await act(async () => { btn().click(); });
    expect(api.clear).not.toHaveBeenCalled();
  });
});

describe('NewSessionChip — clear and wake are a pair', () => {
  it('wakes after a successful clear, so the fresh brain is already looking around', async () => {
    const { api, calls } = fakeApi();
    const { btn } = mount(api);
    await act(async () => { btn().click(); });
    await act(async () => { btn().click(); });
    await flush();
    expect(calls).toEqual(['clear:ws-1', 'wake:ws-1']);
  });

  it('does NOT wake a clear that failed — that would revive the old conversation', async () => {
    const { api, calls } = fakeApi({
      clear: vi.fn(async () => ({ ok: false, code: 'invalid_workspace' })),
    });
    const { btn } = mount(api);
    await act(async () => { btn().click(); });
    await act(async () => { btn().click(); });
    await flush();
    expect(calls).toEqual([]);
    expect(api.wake).not.toHaveBeenCalled();
  });

  it('survives a rejected wake — the clear still counts', async () => {
    const { api } = fakeApi({ wake: vi.fn(async () => { throw new Error('busy'); }) });
    const { btn } = mount(api);
    await act(async () => { btn().click(); });
    await act(async () => { btn().click(); });
    await flush();
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(btn().disabled).toBe(false);
  });
});

describe('NewSessionChip — busy', () => {
  it('stays ENABLED while a turn streams (a stuck turn is the reason to use it)', async () => {
    const { api } = fakeApi();
    const { btn } = mount(api, { busy: true });
    expect(btn().disabled).toBe(false);
    await act(async () => { btn().click(); });
    await act(async () => { btn().click(); });
    await flush();
    expect(api.clear).toHaveBeenCalledTimes(1);
  });

  it('says the click will interrupt when busy', async () => {
    const { api } = fakeApi();
    const { btn } = mount(api, { busy: true });
    await act(async () => { btn().click(); });
    expect(btn().textContent).toContain('deck.newSessionConfirmBusy');
  });

  it('uses the plain confirm wording when idle', async () => {
    const { api } = fakeApi();
    const { btn } = mount(api);
    await act(async () => { btn().click(); });
    expect(btn().textContent).toContain('deck.newSessionConfirm');
  });
});
