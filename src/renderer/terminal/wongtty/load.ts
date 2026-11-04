// Lazy loader for the wongtty front end (`wongtty/xterm`, a Rust/WebAssembly
// terminal with the xterm.js API).
//
// EXPERIMENTAL (uiSlice.terminalWongtty, default off). Only the engine
// controller (engineController.ts) calls preloadWongtty, so with the switch
// off nothing of wongtty is fetched. The renderer page cannot fetch file://
// URLs, so main reads the .wasm bytes and hands them over IPC
// (settings.getWongttyWasm).

import type * as WongttyModule from 'wongtty/xterm';

export type Wongtty = typeof WongttyModule;

let loaded: Wongtty | null = null;
let pending: Promise<Wongtty | null> | null = null;
let failure: string | null = null;

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

/** Start loading wongtty, once. Resolves to the module after init() and the
 *  probe, or null when either failed (wongttyLoadFailure says why); a failed
 *  load is retried on the next call. */
export function preloadWongtty(): Promise<Wongtty | null> {
  pending ??= (async () => {
    // eslint-disable-next-line import/no-unresolved -- the resolver does not read the package's `exports` subpath
    const [mod, wasm] = await Promise.all([import('wongtty/xterm'), window.electronAPI.settings.getWongttyWasm()]);
    await mod.init(wasm.engine, wasm.frontEnd);
    probe(mod);
    loaded = mod;
    failure = null;
    return mod;
  })().catch((err: unknown) => {
    failure = err instanceof Error ? err.message : String(err);
    console.warn('[wmux:wongtty] could not load the wongtty front end', err);
    pending = null;
    return null;
  });
  return pending;
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
