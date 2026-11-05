// Lazy loader for the wongtty front end (`wongtty/xterm`, a Rust/WebAssembly
// terminal with the xterm.js API).
//
// EXPERIMENTAL (uiSlice.terminalWongtty, default off). Only the engine
// controller (engineController.ts) calls preloadWongtty, so with the switch
// off nothing of wongtty is fetched. The renderer page cannot fetch file://
// URLs, so main reads the .wasm bytes and hands them over IPC
// (settings.getWongttyWasm).
//
// Turned off, the switch gives the memory back: once the controller has asked
// for it (releaseWongttyWhenIdle) and the last wongtty terminal is disposed,
// the loader drops the module, and with it the WebAssembly instances and
// everything they hold. The package comes bundled into a function
// (factory.ts, built by vite.renderer.config.ts) because an ES module, once
// imported, is never collected; the next load calls it again.

import type * as WongttyModule from 'wongtty/xterm';

export type Wongtty = typeof WongttyModule;

let loaded: Wongtty | null = null;
let pending: Promise<Wongtty | null> | null = null;
let failure: string | null = null;
// wongtty terminals built from `loaded` and not disposed yet.
let live = 0;
let releaseWanted = false;
// Callers that will build a wongtty terminal soon (holdWongtty).
let holds = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

/** Build one terminal, open it into a 1x1 element off screen and dispose it:
 *  what a pane does first, so a wasm fetch or compile error, a failed init or
 *  a missing WebGL2 fails the load once, before any pane is built with it. */
function probe(mod: Wongtty): void {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
  document.body.appendChild(host);
  let terminal: { open(parent: HTMLElement): void; dispose(): void } | null = null;
  try {
    terminal = new mod.Terminal({ cols: 2, rows: 1 });
    terminal.open(host);
  } finally {
    try { terminal?.dispose(); } catch { /* the probe's own teardown */ }
    host.remove();
  }
}

/** The module, with a Terminal that counts itself from construction to dispose. */
function counted(mod: Wongtty): Wongtty {
  class Terminal extends mod.Terminal {
    #alive = true;
    constructor(...args: ConstructorParameters<Wongtty['Terminal']>) {
      super(...args);
      live++;
    }
    dispose(): void {
      if (this.#alive) {
        this.#alive = false;
        live--;
        scheduleRelease();
      }
      super.dispose();
    }
  }
  return { ...mod, Terminal };
}

function scheduleRelease(): void {
  if (!releaseWanted || live > 0 || holds > 0 || loaded === null || releaseTimer !== null) return;
  // A task later: the teardown that disposed the last terminal may still ask
  // isWongttyTerminal about it.
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (!releaseWanted || live > 0 || holds > 0 || loaded === null) return;
    loaded = null;
    pending = null;
    releaseWanted = false;
    console.log('[wmux:wongtty] released: no terminal uses wongtty');
  }, 0);
}

/** Start loading wongtty, once. Resolves to the module after init() and the
 *  probe, or null when either failed (wongttyLoadFailure says why); a failed
 *  load is retried on the next call. */
export function preloadWongtty(): Promise<Wongtty | null> {
  releaseWanted = false;
  pending ??= (async () => {
    const [{ createWongtty }, wasm] = await Promise.all([import('./factory'), window.electronAPI.settings.getWongttyWasm()]);
    const mod = createWongtty();
    await mod.init(wasm.engine, wasm.frontEnd);
    probe(mod);
    loaded = counted(mod);
    failure = null;
    // Turned off while it loaded.
    scheduleRelease();
    return loaded;
  })().catch((err: unknown) => {
    failure = err instanceof Error ? err.message : String(err);
    console.warn('[wmux:wongtty] could not load the wongtty front end', err);
    pending = null;
    return null;
  });
  return pending;
}

/** Let go of the module once no wongtty terminal is left (the switch is off):
 *  its memory can then be collected. A later preloadWongtty loads it afresh. */
export function releaseWongttyWhenIdle(): void {
  releaseWanted = true;
  scheduleRelease();
}

/** Keep the module loaded until the returned function is called: for a swap
 *  that will build a wongtty terminal once it has captured the old one. */
export function holdWongtty(): () => void {
  holds++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds--;
    scheduleRelease();
  };
}

/** The module once init() has finished; null before (the caller uses xterm.js). */
export function loadedWongtty(): Wongtty | null {
  return loaded;
}

/** Why the last load failed; null after a successful one, or before any. */
export function wongttyLoadFailure(): string | null {
  return failure;
}

/** Whether `terminal` was built by wongtty. */
export function isWongttyTerminal(terminal: unknown): boolean {
  return loaded !== null && terminal instanceof loaded.Terminal;
}
