import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { evaluateIsolated, resetIsolatedEval, waitForIsolated } from '../isolated-eval';

type Handler = (payload: any) => void;

interface FakeOptions {
  /** Value the isolated call resolves to, or a function of the sent params. */
  result?: unknown | ((params: any) => unknown);
  /** Return null from Page.createIsolatedWorld (no isolated world available). */
  noWorld?: boolean;
}

/** Fake Page + CDP session recording exactly what the helper sends. */
function makePage(options: FakeOptions = {}) {
  const sent: Array<{ method: string; params: any }> = [];
  const handlers = new Map<string, Handler[]>();
  let worldId = 100;

  const client = {
    send: vi.fn(async (method: string, params?: any) => {
      sent.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'FRAME-1' } } };
      if (method === 'Page.createIsolatedWorld') {
        if (options.noWorld) return {};
        worldId += 1;
        return { executionContextId: worldId };
      }
      if (method === 'Runtime.callFunctionOn') {
        const value =
          typeof options.result === 'function'
            ? (options.result as (p: any) => unknown)(params)
            : options.result;
        return { result: { value } };
      }
      return {};
    }),
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  const page = {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: vi.fn(async () => 'main-world'),
    on: vi.fn(),
  };

  const emit = (event: string, payload?: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };

  return { page: page as unknown as Page, client, sent, emit, rawPage: page };
}

const callsTo = (sent: Array<{ method: string }>, method: string): number =>
  sent.filter((entry) => entry.method === method).length;

describe('evaluateIsolated', () => {
  beforeEach(() => {
    resetIsolatedEval();
  });

  it('runs the script in a created isolated world and returns its value', async () => {
    const { page, sent } = makePage({ result: 42 });

    expect(await evaluateIsolated(page, '1 + 41')).toBe(42);

    const world = sent.find((entry) => entry.method === 'Page.createIsolatedWorld');
    expect(world?.params.frameId).toBe('FRAME-1');
    expect(world?.params.grantUniveralAccess).toBe(true);
    // The world name must not name the product — it is the one string about us
    // that reaches the browser at all.
    expect(String(world?.params.worldName)).not.toMatch(/wmux|automation|playwright/i);

    const call = sent.find((entry) => entry.method === 'Runtime.callFunctionOn');
    expect(call?.params.executionContextId).toBe(101);
    expect(call?.params.returnByValue).toBe(true);
    expect(call?.params.awaitPromise).toBe(true);
  });

  it('passes arg as the function\'s single parameter, like page.evaluate(fn, arg)', async () => {
    const { page, sent } = makePage({ result: 'ok' });

    await evaluateIsolated(page, (n: number) => n * 2, 21);

    const call = sent.find((entry) => entry.method === 'Runtime.callFunctionOn');
    expect(call?.params.arguments).toEqual([{ value: 21 }]);
    expect(String(call?.params.functionDeclaration)).toContain('n * 2');
  });

  it('creates the world once and reuses the cached context', async () => {
    const { page, sent } = makePage({ result: 1 });

    await evaluateIsolated(page, 'a');
    await evaluateIsolated(page, 'b');
    await evaluateIsolated(page, 'c');

    expect(callsTo(sent, 'Page.createIsolatedWorld')).toBe(1);
    expect(callsTo(sent, 'Runtime.callFunctionOn')).toBe(3);
  });

  it('drops the cached context when the page clears its execution contexts', async () => {
    const { page, sent, emit } = makePage({ result: 1 });

    await evaluateIsolated(page, 'a');
    emit('Runtime.executionContextsCleared');
    await evaluateIsolated(page, 'b');

    expect(callsTo(sent, 'Page.createIsolatedWorld')).toBe(2);
    const calls = sent.filter((entry) => entry.method === 'Runtime.callFunctionOn');
    expect(calls.map((entry) => entry.params.executionContextId)).toEqual([101, 102]);
  });

  it('re-throws a page exception with the page\'s own message', async () => {
    const { page } = makePage({});
    (page as any).context = () => ({
      newCDPSession: async () => ({
        on: () => undefined,
        send: async (method: string) => {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
          if (method === 'Runtime.callFunctionOn') {
            return {
              exceptionDetails: {
                text: 'Uncaught',
                exception: { description: 'TypeError: nope is not a function' },
              },
            };
          }
          return {};
        },
      }),
    });

    await expect(evaluateIsolated(page, 'nope()')).rejects.toThrow(
      'TypeError: nope is not a function',
    );
  });

  it('falls back to the main world when no isolated world can be created', async () => {
    const { page, rawPage, sent } = makePage({ noWorld: true });

    expect(await evaluateIsolated(page, 'x')).toBe('main-world');
    expect(rawPage.evaluate).toHaveBeenCalledTimes(1);
    // One argument, exactly as the pre-existing page.evaluate(expression) call.
    expect(rawPage.evaluate.mock.calls[0]).toHaveLength(1);
    expect(callsTo(sent, 'Runtime.callFunctionOn')).toBe(0);
  });
});

describe('waitForIsolated', () => {
  beforeEach(() => {
    resetIsolatedEval();
  });

  it('resolves once the predicate turns truthy', async () => {
    let polls = 0;
    const { page } = makePage({
      result: () => {
        polls += 1;
        return polls >= 3;
      },
    });

    await waitForIsolated(page, 'ready', undefined, 5000);
    expect(polls).toBe(3);
  });

  it('throws a timeout error when the predicate never satisfies', async () => {
    const { page } = makePage({ result: false });

    await expect(waitForIsolated(page, 'never', undefined, 30)).rejects.toThrow(
      'Timeout 30ms exceeded',
    );
  });
});
