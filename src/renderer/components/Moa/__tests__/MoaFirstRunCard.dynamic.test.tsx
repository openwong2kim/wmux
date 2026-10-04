// @vitest-environment jsdom
//
// The Moa first-run card: what it says, that confirming runs setup, that a
// failure stays on the card with the reason, and that the store-wired card
// raises the archive notice as one toast.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MoaFirstRunCard, { MoaFirstRunCardView, type MoaSetupResult } from '../MoaFirstRunCard';
import { useStore } from '../../../stores';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="moa-first-run"]');
const confirmBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="moa-first-run-confirm"]')!;

describe('MoaFirstRunCardView', () => {
  it('is a labelled, described dialog that says what Moa does and does not do', async () => {
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm: vi.fn(), onClose: vi.fn() })));
    const d = dialog()!;
    expect(d.getAttribute('role')).toBe('dialog');
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Turn on Moa');
    expect(d.getAttribute('aria-describedby')).toBeTruthy();
    expect(d.textContent).toContain("It doesn't write code itself.");
    expect(d.textContent).toContain('level 1');
    expect(d.textContent).toContain('turn it fully off');
  });

  it('runs setup on confirm, then closes and reports success', async () => {
    const onConfirm = vi.fn(async (): Promise<MoaSetupResult> => ({ ok: true, archived: 0 }));
    const onClose = vi.fn();
    const onTurnedOn = vi.fn();
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm, onClose, onTurnedOn })));
    await act(async () => { confirmBtn().click(); });
    await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onTurnedOn).toHaveBeenCalledWith({ ok: true, archived: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the card open with the error when setup fails', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn(async (): Promise<MoaSetupResult> => ({ ok: false, code: 'store_corrupt' }));
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm, onClose })));
    await act(async () => { confirmBtn().click(); });
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    const err = document.querySelector('[data-testid="moa-first-run-error"]')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain("can't be read");
    expect(confirmBtn().disabled).toBe(false);
  });

  it('a failure main committed turns the button into Finish setting up Moa', async () => {
    const onConfirm = vi.fn(async (): Promise<MoaSetupResult> => ({ ok: false, code: 'failed', committed: true }));
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm, onClose: vi.fn() })));
    await act(async () => { confirmBtn().click(); });
    await flush();
    expect(document.querySelector('[data-testid="moa-first-run-error"]')?.textContent).toContain("setup didn't finish");
    expect(confirmBtn().textContent).toBe('Finish setting up Moa');
  });

  it('opened with a pending setup, the button already says Finish', async () => {
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm: vi.fn(), onClose: vi.fn(), pending: true })));
    expect(confirmBtn().textContent).toBe('Finish setting up Moa');
  });

  it('offers turn-on-only only when given, and closes once the switch is on', async () => {
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm: vi.fn(), onClose: vi.fn() })));
    expect(document.querySelector('[data-testid="moa-first-run-turn-on-only"]')).toBeNull();
    const onTurnOnOnly = vi.fn(async () => true);
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm, onClose, onTurnOnOnly })));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="moa-first-run-turn-on-only"]')!.click(); });
    await flush();
    expect(onTurnOnOnly).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown setup as a failure', async () => {
    const onConfirm = vi.fn(async (): Promise<MoaSetupResult> => { throw new Error('ipc down'); });
    await act(async () => root.render(createElement(MoaFirstRunCardView, { onConfirm, onClose: vi.fn() })));
    await act(async () => { confirmBtn().click(); });
    await flush();
    expect(document.querySelector('[data-testid="moa-first-run-error"]')?.textContent).toContain("couldn't be turned on");
  });
});

describe('MoaFirstRunCard (store-wired)', () => {
  it('confirms through createMoaHq and pushes one archive toast', async () => {
    const createMoaHq = vi.fn(async () => ({ ok: true, archived: 3 }));
    const saved = { createMoaHq: useStore.getState().createMoaHq, toasts: useStore.getState().toasts };
    act(() => useStore.setState({ createMoaHq, toasts: [] }));
    try {
      const onClose = vi.fn();
      await act(async () => root.render(createElement(MoaFirstRunCard, { onClose })));
      await act(async () => { confirmBtn().click(); });
      await flush();
      expect(createMoaHq).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      const toasts = useStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toContain("3 pending decisions were moved to Moa's archive");
    } finally {
      act(() => useStore.setState(saved));
    }
  });
});
