import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/** A request as settleAfterAction reads it. */
export function fakeRequest(
  resourceType: string,
  opts: { navigation?: boolean; frame?: unknown } = {},
) {
  return {
    resourceType: () => resourceType,
    isNavigationRequest: () => opts.navigation === true,
    frame: () => opts.frame,
  };
}

export function fakeDialog(type: string, message = 'hello', defaultValue = '') {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    accept: vi.fn(async (_text?: string) => undefined),
    dismiss: vi.fn(async () => undefined),
  };
}

/**
 * Just enough of a Playwright Page: real event wiring (on/off/once/emit), a
 * main frame, a load-state waiter the test resolves, and an evaluate whose
 * stall the test controls (an open dialog stalls evaluation).
 */
export function makeFakePage() {
  const emitter = new EventEmitter();
  const mainFrame = { name: 'main' };
  let resolveLoad: (() => void) | undefined;
  const state = { evaluateStalls: true };
  const page = {
    on: (event: string, fn: (...a: unknown[]) => void) => {
      emitter.on(event, fn);
      return page;
    },
    once: (event: string, fn: (...a: unknown[]) => void) => {
      emitter.once(event, fn);
      return page;
    },
    off: (event: string, fn: (...a: unknown[]) => void) => {
      emitter.off(event, fn);
      return page;
    },
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    listenerCount: (event: string) => emitter.listenerCount(event),
    mainFrame: () => mainFrame,
    waitForLoadState: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    ),
    evaluate: vi.fn(() => (state.evaluateStalls ? new Promise(() => {}) : Promise.resolve(1))),
  };
  return {
    page,
    mainFrame,
    state,
    finishLoad: () => resolveLoad?.(),
  };
}
