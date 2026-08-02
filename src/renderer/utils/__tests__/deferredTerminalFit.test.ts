import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeferredTerminalFit,
  type DeferredTerminalFitOutcome,
} from '../deferredTerminalFit';

function createFrameQueue() {
  let nextId = 1;
  const frames = new Map<number, () => void>();

  return {
    request: (fn: () => void): number => {
      const id = nextId;
      nextId += 1;
      frames.set(id, fn);
      return id;
    },
    cancel: (id: number): void => {
      frames.delete(id);
    },
    flush: (): void => {
      const queued = [...frames.values()];
      frames.clear();
      for (const frame of queued) frame();
    },
    size: (): number => frames.size,
  };
}

describe('createDeferredTerminalFit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces resize requests before attempting one animation-frame fit', () => {
    const frames = createFrameQueue();
    const attemptFit = vi.fn<() => DeferredTerminalFitOutcome>(() => 'fitted');
    const fit = createDeferredTerminalFit({
      attemptFit,
      hasSelection: () => false,
      requestAnimationFrameFn: frames.request,
      cancelAnimationFrameFn: frames.cancel,
    });

    fit.requestFit();
    vi.advanceTimersByTime(40);
    fit.requestFit();
    vi.advanceTimersByTime(99);

    expect(frames.size()).toBe(0);
    expect(attemptFit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(frames.size()).toBe(1);
    frames.flush();

    expect(attemptFit).toHaveBeenCalledTimes(1);
  });

  it('supersedes an animation-frame fit when a newer resize arrives', () => {
    const frames = createFrameQueue();
    const attemptFit = vi.fn<() => DeferredTerminalFitOutcome>(() => 'fitted');
    const fit = createDeferredTerminalFit({
      attemptFit,
      hasSelection: () => false,
      requestAnimationFrameFn: frames.request,
      cancelAnimationFrameFn: frames.cancel,
    });

    fit.requestFit();
    vi.advanceTimersByTime(100);
    expect(frames.size()).toBe(1);

    fit.requestFit();
    expect(frames.size()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(frames.size()).toBe(1);
    frames.flush();

    expect(attemptFit).toHaveBeenCalledTimes(1);
  });

  it('retries a fit deferred by a live selection when the selection clears', () => {
    const frames = createFrameQueue();
    let selected = true;
    const attemptFit = vi.fn<() => DeferredTerminalFitOutcome>(
      () => (selected ? 'deferred' : 'fitted'),
    );
    const fit = createDeferredTerminalFit({
      attemptFit,
      hasSelection: () => selected,
      requestAnimationFrameFn: frames.request,
      cancelAnimationFrameFn: frames.cancel,
    });

    fit.requestFit();
    vi.advanceTimersByTime(100);
    frames.flush();
    expect(attemptFit).toHaveBeenCalledTimes(1);

    fit.onSelectionChange();
    vi.advanceTimersByTime(100);
    frames.flush();
    expect(attemptFit).toHaveBeenCalledTimes(1);

    selected = false;
    fit.onSelectionChange();
    vi.advanceTimersByTime(99);
    expect(frames.size()).toBe(0);
    vi.advanceTimersByTime(1);
    frames.flush();

    expect(attemptFit).toHaveBeenCalledTimes(2);
  });

  it('records fits deferred outside the ResizeObserver path', () => {
    const frames = createFrameQueue();
    let selected = true;
    const attemptFit = vi.fn<() => DeferredTerminalFitOutcome>(() => 'fitted');
    const fit = createDeferredTerminalFit({
      attemptFit,
      hasSelection: () => selected,
      requestAnimationFrameFn: frames.request,
      cancelAnimationFrameFn: frames.cancel,
    });

    fit.deferUntilSelectionClears();
    fit.onSelectionChange();
    vi.advanceTimersByTime(100);
    expect(frames.size()).toBe(0);

    selected = false;
    fit.onSelectionChange();
    vi.advanceTimersByTime(100);
    frames.flush();

    expect(attemptFit).toHaveBeenCalledTimes(1);
  });

  it('keeps the fit deferred if a new selection appears before the retry runs', () => {
    const frames = createFrameQueue();
    let selected = true;
    const attemptFit = vi.fn<() => DeferredTerminalFitOutcome>(
      () => (selected ? 'deferred' : 'fitted'),
    );
    const fit = createDeferredTerminalFit({
      attemptFit,
      hasSelection: () => selected,
      requestAnimationFrameFn: frames.request,
      cancelAnimationFrameFn: frames.cancel,
    });

    fit.requestFit();
    vi.advanceTimersByTime(100);
    frames.flush();

    selected = false;
    fit.onSelectionChange();
    vi.advanceTimersByTime(100);
    selected = true;
    frames.flush();

    selected = false;
    fit.onSelectionChange();
    vi.advanceTimersByTime(100);
    frames.flush();

    expect(attemptFit).toHaveBeenCalledTimes(3);
    expect(attemptFit.mock.results.map((result) => result.value)).toEqual([
      'deferred',
      'deferred',
      'fitted',
    ]);
  });

  it('does not retry an ordinary skipped fit on selection changes', () => {
    const frames = createFrameQueue();
    const attemptFit = vi.fn<() => DeferredTerminalFitOutcome>(() => 'skipped');
    const fit = createDeferredTerminalFit({
      attemptFit,
      hasSelection: () => false,
      requestAnimationFrameFn: frames.request,
      cancelAnimationFrameFn: frames.cancel,
    });

    fit.requestFit();
    vi.advanceTimersByTime(100);
    frames.flush();
    fit.onSelectionChange();
    vi.advanceTimersByTime(100);
    frames.flush();

    expect(attemptFit).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels both debounced and animation-frame work', () => {
    const frames = createFrameQueue();
    const attemptFit = vi.fn<() => DeferredTerminalFitOutcome>(() => 'fitted');
    const fit = createDeferredTerminalFit({
      attemptFit,
      hasSelection: () => false,
      requestAnimationFrameFn: frames.request,
      cancelAnimationFrameFn: frames.cancel,
    });

    fit.requestFit();
    fit.dispose();
    vi.advanceTimersByTime(100);
    expect(frames.size()).toBe(0);

    fit.requestFit();
    vi.advanceTimersByTime(100);
    expect(frames.size()).toBe(1);
    fit.dispose();
    frames.flush();

    expect(attemptFit).not.toHaveBeenCalled();
  });
});
