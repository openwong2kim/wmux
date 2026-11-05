/**
 * Browser-build stand-in (vite.web.config.ts) for
 * terminal/wongtty/engineController.ts: the browser build has no wongtty
 * (stubs/wongttyLoad.ts), so its terminals always run xterm.js and the
 * controller never writes uiSlice.terminalEngine.
 */
export type TerminalEngine = 'xterm' | 'wongtty';

export function ensureEngineController(): void {
  /* nothing to control: always xterm.js */
}

export function settleStartupEngine(): Promise<void> {
  return Promise.resolve();
}

export function failEngine(): void {
  /* xterm.js only: nothing to fall back from */
}
