import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { FAKE_MAIN_FRAME_ID, fakeNetwork } from '../fakeNetworkSession';

let requestSeq = 0;

/**
 * A request, in Playwright's shape for the tests to read; makeFakePage's emit
 * turns it into the CDP Network events settle actually listens to.
 */
export function fakeRequest(
  resourceType: string,
  opts: { navigation?: boolean; frame?: unknown; url?: string } = {},
) {
  const url = opts.url ?? `https://site.test/${++requestSeq}`;
  return {
    id: `fake-${requestSeq}-${Math.random().toString(36).slice(2)}`,
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

type FakeRequest = ReturnType<typeof fakeRequest>;

/**
 * Just enough of a Playwright Page: real event wiring (on/off/once/emit), a
 * main frame, a context that can close, and a load-state waiter the test
 * resolves. Its CDP session is the fake Network session pageNetwork listens
 * on: emit('request' | 'requestfinished' | 'requestfailed', fakeRequest)
 * fires the matching Network event there.
 */
export function makeFakePage() {
  const emitter = new EventEmitter();
  const contextEmitter = new EventEmitter();
  const mainFrame = { name: 'main' };
  let resolveLoad: (() => void) | undefined;
  const { newCDPSession, net } = fakeNetwork();
  const context = {
    on: (event: string, fn: (...a: unknown[]) => void) => contextEmitter.on(event, fn),
    newCDPSession,
  };
  const network = (event: string, request: FakeRequest): boolean => {
    if (event === 'request') {
      net.request(request.url(), {
        id: request.id,
        method: request.method(),
        type: request.resourceType(),
        navigation: request.isNavigationRequest(),
        frameId: request.frame() === mainFrame ? FAKE_MAIN_FRAME_ID : 'child-frame',
      });
    } else if (event === 'requestfinished') {
      net.finish(request.id);
    } else {
      net.fail(request.id);
    }
    return true;
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
    emit: (event: string, ...args: unknown[]) =>
      event === 'request' || event === 'requestfinished' || event === 'requestfailed'
        ? network(event, args[0] as FakeRequest)
        : emitter.emit(event, ...args),
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
    net,
    mainFrame,
    finishLoad: () => resolveLoad?.(),
  };
}
