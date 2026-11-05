// The one writer of uiSlice.terminalEngine: which terminal engine every
// useTerminal pane runs (Labs wongtty switch, uiSlice.terminalWongtty).
//
// The switch is the request; the engine changes only once wongtty has loaded
// for an on request, so a pane is never built with an engine that is not
// there. Panes rebuild themselves when terminalEngine changes (useTerminal's
// mount effect depends on it), which makes a switch apply to open terminals.
//
// Toggles at run time settle over a short quiet window, so a quick on/off/on
// costs one swap; during startup (before settleStartupEngine) a change is
// acted on at once, so the load overlaps the daemon wait and the reconcile.
// A generation counter keeps a load that finished after a later toggle from
// writing a stale answer.

import { preloadWongtty, releaseWongttyWhenIdle, wongttyLoadFailure } from './load';
import { useStore } from '../../stores';
import { t } from '../../i18n';

export type TerminalEngine = 'xterm' | 'wongtty';

/** Quiet window that groups run-time toggles into one decision. */
export const ENGINE_TOGGLE_QUIET_MS = 150;
/** Longest an on request waits for wongtty before it counts as failed. */
export const ENGINE_LOAD_TIMEOUT_MS = 10_000;

/** What a request settles on: `wait` while an on request's load is pending. */
export function decideEngine(requested: boolean, load: 'pending' | 'loaded' | 'failed'): TerminalEngine | 'wait' {
  if (!requested) return 'xterm';
  if (load === 'pending') return 'wait';
  return load === 'loaded' ? 'wongtty' : 'xterm';
}

export interface EngineControllerDeps {
  getRequested(): boolean;
  subscribeRequested(listener: (requested: boolean) => void): () => void;
  getEngine(): TerminalEngine;
  setEngine(engine: TerminalEngine): void;
  setFailure(failure: { message: string } | null): void;
  /** Resolves to a truthy module once wongtty has loaded, null on failure. */
  load(): Promise<unknown>;
  /** Why the last load failed. */
  loadFailure(): string | null;
  /** Give wongtty's memory back once no pane uses it (the engine is xterm.js). */
  release(): void;
  /** Tell the user, once per distinct message (the caller dedupes). */
  report(message: string): void;
  quietMs?: number;
  loadTimeoutMs?: number;
}

export interface EngineController {
  /** Act on a pending toggle now and end the startup phase; resolves when the
   *  current request has settled, or after `timeoutMs` (false then). */
  settleStartup(timeoutMs: number): Promise<boolean>;
  /** wongtty failed to build or open a pane: every pane goes back to xterm.js
   *  and the switch keeps its value (turning it off and on retries). */
  fail(err: unknown): void;
  dispose(): void;
}

export function createEngineController(deps: EngineControllerDeps): EngineController {
  const quietMs = deps.quietMs ?? ENGINE_TOGGLE_QUIET_MS;
  const loadTimeoutMs = deps.loadTimeoutMs ?? ENGINE_LOAD_TIMEOUT_MS;
  let generation = 0;
  let startup = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> = Promise.resolve();
  const reported = new Set<string>();

  const write = (engine: TerminalEngine) => {
    if (deps.getEngine() !== engine) deps.setEngine(engine);
    if (engine === 'xterm') deps.release();
  };
  const failWith = (message: string) => {
    write('xterm');
    deps.setFailure({ message });
    console.warn(`[wmux:wongtty] terminals use xterm.js: ${message}`);
    if (!reported.has(message)) {
      reported.add(message);
      deps.report(message);
    }
  };

  const evaluate = (): Promise<void> => {
    const gen = ++generation;
    if (decideEngine(deps.getRequested(), 'pending') === 'xterm') {
      deps.setFailure(null);
      write('xterm');
      return Promise.resolve();
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<'timeout'>((resolve) => { timeout = setTimeout(() => resolve('timeout'), loadTimeoutMs); });
    return Promise.race([deps.load(), timedOut]).then((mod) => {
      if (timeout !== null) clearTimeout(timeout);
      if (gen !== generation || !deps.getRequested()) return;
      const decided = decideEngine(true, mod === 'timeout' || !mod ? 'failed' : 'loaded');
      if (decided === 'wongtty') {
        deps.setFailure(null);
        write('wongtty');
      } else {
        failWith(mod === 'timeout' ? `wongtty did not load within ${loadTimeoutMs} ms` : deps.loadFailure() ?? 'wongtty did not load');
      }
    });
  };
  const run = () => {
    timer = null;
    current = evaluate();
  };
  const onRequest = () => {
    if (timer !== null) clearTimeout(timer);
    if (startup) run();
    else timer = setTimeout(run, quietMs);
  };

  const unsubscribe = deps.subscribeRequested(onRequest);
  if (deps.getRequested()) run();

  return {
    async settleStartup(timeoutMs) {
      if (timer !== null) { clearTimeout(timer); run(); }
      startup = false;
      if (!deps.getRequested()) return true;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const late = new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); });
      const settled = await Promise.race([current.then(() => true as const), late]);
      if (timeout !== null) clearTimeout(timeout);
      return settled;
    },
    fail(err) {
      // A load still in flight must not switch the panes back on.
      generation++;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      failWith(err instanceof Error ? err.message : String(err));
    },
    dispose() {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    },
  };
}

let controller: EngineController | null = null;

/** The app's controller, installed on first use (idempotent). */
export function ensureEngineController(): EngineController {
  controller ??= createEngineController({
    getRequested: () => useStore.getState().terminalWongtty === true,
    subscribeRequested: (listener) => useStore.subscribe((state, prev) => {
      if (state.terminalWongtty !== prev.terminalWongtty) listener(state.terminalWongtty === true);
    }),
    getEngine: () => useStore.getState().terminalEngine,
    setEngine: (engine) => {
      useStore.getState().setTerminalEngine(engine);
      document.documentElement.dataset.terminalEngine = engine;
    },
    setFailure: (failure) => useStore.getState().setTerminalEngineFailure(failure),
    load: preloadWongtty,
    loadFailure: wongttyLoadFailure,
    release: releaseWongttyWhenIdle,
    report: (message) => useStore.getState().pushToast({ message: t('settings.labsWongttyFailed', { message }), level: 'error' }),
  });
  if (typeof document !== 'undefined' && document.documentElement.dataset.terminalEngine === undefined) {
    document.documentElement.dataset.terminalEngine = useStore.getState().terminalEngine;
  }
  return controller;
}

/** Startup (AppLayout, before the pane gate opens): wait for the saved
 *  request to settle so each pane is built once with its engine. Returns at
 *  once with the switch off. A load slower than `timeoutMs` lets the panes
 *  build as xterm.js; they swap when it finishes. */
export async function settleStartupEngine({ timeoutMs }: { timeoutMs: number }): Promise<void> {
  // Never throws: the pane gate opens after it whatever happened.
  try {
    const settled = await ensureEngineController().settleStartup(timeoutMs);
    if (!settled) console.warn(`[wmux:wongtty] startup-late: wongtty not loaded after ${timeoutMs} ms; panes start as xterm.js`);
  } catch (err) {
    console.warn('[wmux:wongtty] startup engine check failed; panes start as xterm.js', err);
  }
}

/** A pane could not be built or opened with wongtty. */
export function failEngine(err: unknown): void {
  ensureEngineController().fail(err);
}

/** Test seam. */
export function __resetEngineControllerForTests(): void {
  controller?.dispose();
  controller = null;
}
