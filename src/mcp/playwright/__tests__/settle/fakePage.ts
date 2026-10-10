import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

let requestSeq = 0;

/** A request as settleAfterAction reads it. */
export function fakeRequest(
  resourceType: string,
  opts: { navigation?: boolean; frame?: unknown; url?: string } = {},
) {
  const url = opts.url ?? `https://site.test/${++requestSeq}`;
  return {
    url: () => url,
    method: () => 'GET',
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
    accept: vi.fn(async (text?: string) => {
      void text;
    }),
    dismiss: vi.fn(async () => undefined),
  };
}

/**
 * Just enough of a Playwright Page: real event wiring (on/off/once/emit), a
 * main frame, a context that can close, and a load-state waiter the test
 * resolves.
 */
export function makeFakePage() {
  const emitter = new EventEmitter();
  const contextEmitter = new EventEmitter();
  const mainFrame = { name: 'main' };
  let resolveLoad: (() => void) | undefined;
  const context = {
    on: (event: string, fn: (...a: unknown[]) => void) => contextEmitter.on(event, fn),
    newCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: 'tab-1' } }),
      detach: async () => undefined,
    }),
  };
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
    context: () => context,
    closeContext: () => contextEmitter.emit('close'),
    waitForLoadState: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    ),
  };
  return {
    page,
    mainFrame,
    finishLoad: () => resolveLoad?.(),
  };
}
