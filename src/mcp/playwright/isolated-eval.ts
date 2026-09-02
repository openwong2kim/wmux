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

/** Thrown when `requireIsolated` is set and no isolated world can be had. */
export class IsolatedWorldUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolatedWorldUnavailableError';
  }
}

export interface IsolatedEvalOptions {
  /** Treat the call as user-initiated (transient activation). Default false. */
  userGesture?: boolean;
  /**
   * Refuse to run in the page's own world when no isolated one is available,
   * throwing instead. For scripts whose whole point is that page code cannot
   * observe or redirect them — a navigation the page could hijack by hooking
   * `setTimeout` or `location.assign` — running in the main world is worse
   * than not running at all.
   */
  requireIsolated?: boolean;
}

interface PageState {
  /** null when this Page cannot give us a CDP session at all. */
  client: IsolatedCdpSession | null;
  /** Cached context id for the main frame; null once it is known to be stale. */
  contextId: number | null;
  /** In-flight creation, so concurrent callers share one round trip. */
  creating: Promise<number | null> | null;
  /**
   * Bumped every time the document underneath us changes. A creation that was
   * already in flight when that happened describes the OLD document, so its
   * result is discarded rather than cached.
   */
  epoch: number;
  /**
   * True only when this Page can never give us an isolated world: no CDP
   * session, or a session we could not subscribe to. A world that merely
   * FAILED to be created is retried — a getFrameTree that lost a race with a
   * navigation must not downgrade the page to the main world for its lifetime.
   */
  sessionUnusable: boolean;
  /** One main-world warning per page is diagnosable; one per call is noise. */
  warned: boolean;
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
      // Parity with the main world is the goal, not extra privilege: universal
      // access would let an agent-supplied browser_evaluate script reach into
      // cross-origin frames that main-world code cannot touch.
      grantUniveralAccess: false,
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
    epoch: 0,
    sessionUnusable: client === null,
    warned: false,
  };
  if (!client) return state;

  /** The document changed: retire the context AND any creation in flight. */
  const invalidate = (): void => {
    state.contextId = null;
    state.epoch += 1;
  };

  // Cache invalidation is not optional: a context id that outlives its
  // document silently evaluates nothing. If the subscriptions below cannot be
  // set up, the honest answer is to not use an isolated world on this page at
  // all rather than to serve a stale context.
  try {
    // Runtime must be enabled for the lifecycle events. Playwright already
    // enables it on its own session, so this adds no new observable signal.
    await client.send('Runtime.enable').catch(() => undefined);
    await client.send('Page.enable').catch(() => undefined);

    client.on('Runtime.executionContextsCleared', invalidate);
    client.on('Runtime.executionContextDestroyed', (payload: { executionContextId?: number }) => {
      if (payload?.executionContextId === state.contextId) invalidate();
    });
    client.on('Page.frameNavigated', (payload: { frame?: { parentId?: string } }) => {
      // Only the main frame's navigation retires our world; a subframe moving
      // is none of our business. (Same-document navigation arrives as
      // navigatedWithinDocument and keeps the context, correctly.)
      if (!payload?.frame?.parentId) invalidate();
    });

    const drop = (): void => {
      states.delete(page);
      void Promise.resolve()
        .then(() => (client as unknown as { detach?: () => Promise<void> }).detach?.())
        .catch(() => undefined);
    };
    page.on('close', drop);
    page.on('crash', drop);
    // A page that was ALREADY closed never fires 'close', so the entry (and
    // its session) would sit in the map for the rest of the process.
    if (page.isClosed()) drop();
  } catch {
    state.client = null;
    state.sessionUnusable = true;
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

/**
 * Resolve the page's isolated context id, creating the world on demand.
 *
 * A failure is transient by default — a getFrameTree that lost a race with a
 * navigation says nothing about the next call — so nothing is latched here.
 * Only a Page that could never give us a session is written off, in openState.
 */
async function contextIdFor(state: PageState): Promise<number | null> {
  // Two attempts: one for the ordinary case, one for a document that changed
  // WHILE the world was being created (the id we got describes the old one).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (state.contextId !== null) return state.contextId;
    const client = state.client;
    if (!client || state.sessionUnusable) return null;
    if (!state.creating) {
      const epoch = state.epoch;
      state.creating = createIsolatedContext(client)
        .then((id) => {
          if (id !== null && state.epoch === epoch) state.contextId = id;
          return id;
        })
        .finally(() => {
          state.creating = null;
        });
    }
    const created = await state.creating;
    if (created === null) return null;
    if (state.contextId !== null) return state.contextId;
  }
  return null;
}

/**
 * CDP hands NaN, +/-Infinity and -0 back as `unserializableValue` instead of
 * `value`, because JSON has no spelling for them. `page.evaluate` restores
 * them, so this does too — otherwise they would silently arrive as undefined.
 */
function decodeResult(result?: { value?: unknown; unserializableValue?: string }): unknown {
  if (!result) return undefined;
  if (result.unserializableValue === undefined) return result.value;
  switch (result.unserializableValue) {
    case 'NaN':
      return NaN;
    case 'Infinity':
      return Infinity;
    case '-Infinity':
      return -Infinity;
    case '-0':
      return -0;
    default:
      // Anything else (BigInt literals) has no JSON form either way.
      return undefined;
  }
}

function throwPageException(details?: {
  text?: string;
  exception?: { description?: string };
}): void {
  if (!details) return;
  throw new Error(
    details.exception?.description ?? details.text ?? 'Isolated evaluation threw an exception',
  );
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

  // Main-world fallback, used only when no isolated world can be had. Called
  // with the SAME arity as before this module existed, so a one-argument
  // page.evaluate stays a one-argument call.
  const mainWorld = (): Promise<R> => {
    if (options?.requireIsolated) {
      throw new IsolatedWorldUnavailableError(
        'no isolated world on this page, and this script refuses the main world',
      );
    }
    if (!state.warned) {
      state.warned = true;
      console.warn(
        '[isolated-eval] no isolated world on this page; page scripts run in the main world',
      );
    }
    const evaluatable = script as unknown as (a: unknown) => R;
    return (arg === undefined
      ? page.evaluate(evaluatable)
      : page.evaluate(evaluatable, arg)) as Promise<R>;
  };

  type EvalReply = {
    result?: { value?: unknown; unserializableValue?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };

  const call = async (contextId: number, client: IsolatedCdpSession): Promise<R> => {
    // A STRING goes through Runtime.evaluate, not callFunctionOn: the old
    // page.evaluate(string) / Runtime.evaluate({expression}) path accepted
    // whole scripts ("const a = document.title; a.length"), and wrapping those
    // in `return (...)` would turn them into a SyntaxError.
    const reply = (await (typeof script === 'string'
      ? client.send('Runtime.evaluate', {
          expression: script,
          contextId,
          returnByValue: true,
          awaitPromise: true,
          userGesture: options?.userGesture ?? false,
        })
      : client.send('Runtime.callFunctionOn', {
          functionDeclaration: script.toString(),
          executionContextId: contextId,
          arguments: [{ value: arg }],
          returnByValue: true,
          awaitPromise: true,
          userGesture: options?.userGesture ?? false,
        }))) as EvalReply;
    throwPageException(reply?.exceptionDetails);
    return decodeResult(reply?.result) as R;
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

/**
 * The cached session and isolated context for `page`, for callers that must
 * send raw CDP themselves (the occlusion probe needs remote handles, not
 * values). Reusing this session is what keeps Chromium from minting a fresh
 * isolated world per snapshot: worlds are cached per (session, frame, name),
 * so a new session per snapshot would accumulate them in the renderer.
 *
 * Null when the page has no isolated world; the caller then does what it did
 * before, in the main world.
 */
export async function isolatedProbeTarget(
  page: Page,
): Promise<{ client: IsolatedCdpSession; contextId: number } | null> {
  const state = await stateFor(page).catch(() => null);
  if (!state) return null;
  const contextId = await contextIdFor(state);
  if (contextId === null || !state.client) return null;
  return { client: state.client, contextId };
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
      // A malformed predicate must fail fast rather than expire as a timeout,
      // so the first evaluation re-throws — except for the context error a
      // wait started right after a click or a navigation routinely hits, which
      // page.waitForFunction simply waited out.
      if (first && !isStaleContextError(errorMessage(error))) throw error;
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
