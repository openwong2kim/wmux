import type { Page } from 'playwright-core';

// ---------------------------------------------------------------------------
// Run our own page scripts in an isolated world.
// ---------------------------------------------------------------------------
//
// Everything wmux injected used to run in the page's MAIN world: the same
// JavaScript realm the site's own code lives in. Measured against a
// bot-detector page, `window.dummyFn()` defined by the page was callable from
// browser_evaluate, and the detector's "main world execution" probe — it hooks
// `document.getElementsByClassName` and friends and watches for calls that do
// not come from page code — went red the moment our snapshot scan ran.
//
// That is not only a fingerprint. A page can redefine the DOM methods our
// scripts call and hand back whatever it likes, so a hostile site can both
// SEE and TAMPER WITH the agent's view of itself.
//
// An isolated world fixes both: it shares the DOM (same document, same
// elements, same attributes) but not the JavaScript globals, so page code
// cannot see our scripts, and page-installed hooks on built-ins do not run for
// us. Playwright's own locator/click/fill internals already work this way —
// this module brings OUR scripts up to the same footing.
//
// Not in scope: the main-process RPC lane (page-eval.ts's rpcEvaluator), which
// has no Playwright Page to attach a session to, and the `Runtime.enable`
// fingerprint, which measured clean on current Chrome.

/**
 * Name of the world we create. It never reaches the page — only CDP traffic —
 * but it stays bland anyway so that nothing product-specific is written down
 * anywhere a devtools listener could read it.
 */
const WORLD_NAME = 'util';

/** How often a wait predicate is re-evaluated. */
const POLL_INTERVAL_MS = 100;

/** Just enough of a CDP session to create a world on it. */
export interface IsolatedCdpSender {
  send: (method: string, params?: unknown) => Promise<unknown>;
}

/** The slice of a CDP session this module needs (also what fakes implement). */
export interface IsolatedCdpSession extends IsolatedCdpSender {
  on: (event: string, handler: (payload: any) => void) => void;
}

/** A page function, or a bare JavaScript expression to evaluate. */
export type IsolatedScript<A, R> = string | ((arg: A) => R | Promise<R>);

export interface IsolatedEvalOptions {
  /** Treat the call as user-initiated (transient activation). Default false. */
  userGesture?: boolean;
}

interface PageState {
  /** null when this Page cannot give us a CDP session at all. */
  client: IsolatedCdpSession | null;
  /** Cached context id for the main frame; null once it is known to be stale. */
  contextId: number | null;
  /** In-flight creation, so concurrent callers share one round trip. */
  creating: Promise<number | null> | null;
  /** Set when the world could not be created — stop retrying every call. */
  unavailable: boolean;
}

/**
 * One state per live Page. Entries are dropped when the page closes or
 * crashes, which is also what detaches the session — a plain Map is therefore
 * enough (and tsconfig.mcp.json targets ES2020, where WeakRef does not exist).
 */
const states = new Map<Page, Promise<PageState>>();

/** Errors that mean "the context you had is gone", not "the script failed". */
function isStaleContextError(message: string): boolean {
  return /Cannot find context|Execution context was destroyed|Inspected target navigated|Target closed|Session closed/i.test(
    message,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create an isolated world on `client` and return its execution context id.
 *
 * Exported for callers that already hold their own short-lived session and
 * pass the id straight into a raw `Runtime.evaluate` (snapshot's occlusion
 * probe, which needs remote handles rather than values). Returns null when the
 * world cannot be created, and every caller treats that as "use the main
 * world" rather than failing the whole operation.
 */
export async function createIsolatedContext(
  client: IsolatedCdpSender,
  frameId?: string,
): Promise<number | null> {
  try {
    await client.send('Page.enable');
    let targetFrameId = frameId;
    if (!targetFrameId) {
      const tree = (await client.send('Page.getFrameTree')) as {
        frameTree?: { frame?: { id?: string } };
      };
      targetFrameId = tree?.frameTree?.frame?.id;
    }
    if (!targetFrameId) return null;
    const world = (await client.send('Page.createIsolatedWorld', {
      frameId: targetFrameId,
      worldName: WORLD_NAME,
      // The DOM is shared regardless; universal access additionally lets the
      // script reach same-page cross-origin objects the way main-world code
      // reaching them would, so behaviour does not change under our feet.
      grantUniveralAccess: true,
    })) as { executionContextId?: number };
    return typeof world?.executionContextId === 'number' ? world.executionContextId : null;
  } catch {
    return null;
  }
}

/** Open (once) the long-lived session this module drives a page through. */
async function openState(page: Page): Promise<PageState> {
  // A Page that cannot give us a CDP session (a backend Playwright reached
  // some other way) is not a failure: the caller still gets its script run,
  // in the main world, exactly as before this module existed.
  const client = (await Promise.resolve()
    .then(() => page.context().newCDPSession(page))
    .catch(() => null)) as unknown as IsolatedCdpSession | null;

  const state: PageState = {
    client,
    contextId: null,
    creating: null,
    unavailable: client === null,
  };
  if (!client) return state;

  // Cache invalidation is not optional: a context id that outlives its
  // document silently evaluates nothing. If the subscriptions below cannot be
  // set up, the honest answer is to not use an isolated world on this page at
  // all rather than to serve a stale context.
  try {
    // Runtime must be enabled for the lifecycle events. Playwright already
    // enables it on its own session, so this adds no new observable signal.
    await client.send('Runtime.enable').catch(() => undefined);
    await client.send('Page.enable').catch(() => undefined);

    client.on('Runtime.executionContextsCleared', () => {
      state.contextId = null;
    });
    client.on('Runtime.executionContextDestroyed', (payload: { executionContextId?: number }) => {
      if (payload?.executionContextId === state.contextId) state.contextId = null;
    });
    client.on('Page.frameNavigated', (payload: { frame?: { parentId?: string } }) => {
      // Only the main frame's navigation retires our world; a subframe moving
      // is none of our business.
      if (!payload?.frame?.parentId) state.contextId = null;
    });

    const drop = (): void => {
      states.delete(page);
    };
    page.on('close', drop);
    page.on('crash', drop);
  } catch {
    state.client = null;
    state.unavailable = true;
  }

  return state;
}

async function stateFor(page: Page): Promise<PageState> {
  const existing = states.get(page);
  if (existing) return existing;
  const created = openState(page).catch((error) => {
    states.delete(page);
    throw error;
  });
  states.set(page, created);
  return created;
}

/** Resolve the page's isolated context id, creating the world on demand. */
async function contextIdFor(state: PageState): Promise<number | null> {
  if (state.contextId !== null) return state.contextId;
  if (state.unavailable) return null;
  if (!state.creating) {
    const client = state.client;
    if (!client) return null;
    state.creating = createIsolatedContext(client)
      .then((id) => {
        state.contextId = id;
        if (id === null) state.unavailable = true;
        return id;
      })
      .finally(() => {
        state.creating = null;
      });
  }
  return state.creating;
}

/**
 * Wrap a script for `Runtime.callFunctionOn`.
 *
 * A function is sent as-is and receives `arg` as its single parameter, exactly
 * like `page.evaluate(fn, arg)`. A string is treated as an expression, exactly
 * like `page.evaluate(expression)` — the newlines matter, so a trailing line
 * comment in the source cannot swallow the closing parenthesis.
 */
function functionDeclarationFor<A, R>(script: IsolatedScript<A, R>): string {
  if (typeof script === 'function') return script.toString();
  return `function () { return (\n${script}\n); }`;
}

/**
 * Evaluate one of OUR scripts in the page's isolated world.
 *
 * Same call shape and same return shape as `page.evaluate(fn, arg)` /
 * `page.evaluate(expression)`: the value comes back JSON-serialised, a
 * returned promise is awaited, and an exception inside the page is re-thrown
 * here with the page's own message.
 *
 * If the isolated world cannot be created at all (a target that refuses
 * Page.createIsolatedWorld), this falls back to `page.evaluate` rather than
 * failing the tool: losing the privacy property is bad, losing every browser
 * tool is worse.
 */
export async function evaluateIsolated<R = unknown, A = unknown>(
  page: Page,
  script: IsolatedScript<A, R>,
  arg?: A,
  options?: IsolatedEvalOptions,
): Promise<R> {
  const state = await stateFor(page);
  const declaration = functionDeclarationFor(script);

  // Main-world fallback, used only when no isolated world can be had. Called
  // with the SAME arity as before this module existed, so a one-argument
  // page.evaluate stays a one-argument call.
  const mainWorld = (): Promise<R> => {
    const evaluatable = script as unknown as (a: unknown) => R;
    return (arg === undefined
      ? page.evaluate(evaluatable)
      : page.evaluate(evaluatable, arg)) as Promise<R>;
  };

  const call = async (contextId: number, client: IsolatedCdpSession): Promise<R> => {
    const result = (await client.send('Runtime.callFunctionOn', {
      functionDeclaration: declaration,
      executionContextId: contextId,
      arguments: [{ value: arg }],
      returnByValue: true,
      awaitPromise: true,
      userGesture: options?.userGesture ?? false,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result?.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Isolated evaluation threw an exception',
      );
    }
    return result?.result?.value as R;
  };

  let contextId = await contextIdFor(state);
  const client = state.client;
  if (contextId === null || !client) {
    // No isolated world available — keep the tool working in the main world.
    return await mainWorld();
  }

  try {
    return await call(contextId, client);
  } catch (error) {
    // A navigation between "read the cached id" and "use it" is ordinary, and
    // the retry costs one round trip.
    if (!isStaleContextError(errorMessage(error))) throw error;
    state.contextId = null;
    contextId = await contextIdFor(state);
    if (contextId === null) return await mainWorld();
    return await call(contextId, client);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an isolated-world predicate until it is truthy — the isolated-world
 * stand-in for `page.waitForFunction`.
 *
 * `timeoutMs` of 0 means "wait forever", matching Playwright. The first
 * evaluation is allowed to throw straight through, so a malformed predicate
 * still fails fast instead of expiring as a timeout; later failures are the
 * ordinary mid-navigation ones and keep polling.
 */
export async function waitForIsolated<A = unknown>(
  page: Page,
  script: IsolatedScript<A, unknown>,
  arg: A | undefined,
  timeoutMs: number,
): Promise<void> {
  const hasDeadline = timeoutMs > 0;
  const deadline = Date.now() + timeoutMs;
  let first = true;
  for (;;) {
    try {
      if (await evaluateIsolated<unknown, A>(page, script, arg)) return;
    } catch (error) {
      if (first) throw error;
    }
    first = false;
    if (hasDeadline && Date.now() >= deadline) {
      throw new Error(`Timeout ${timeoutMs}ms exceeded`);
    }
    await sleep(
      hasDeadline ? Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())) : POLL_INTERVAL_MS,
    );
  }
}

/** Forget a page's cached session — tests, and anything that reuses a Page. */
export function resetIsolatedEval(page?: Page): void {
  if (page) states.delete(page);
  else states.clear();
}
