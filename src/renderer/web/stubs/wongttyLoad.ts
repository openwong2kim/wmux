/**
 * Browser-build stand-in (vite.web.config.ts) for terminal/wongtty/load.ts: the
 * experimental wongtty front end is desktop-only (its WebAssembly comes from
 * main), so the browser bundle never pulls in the package or its .wasm files.
 */
export function preloadWongtty(): Promise<null> {
  return Promise.resolve(null);
}

export function loadedWongtty(): null {
  return null;
}

export function isWongttyTerminal(): boolean {
  return false;
}

export function wongttyLoadFailure(): null {
  return null;
}
