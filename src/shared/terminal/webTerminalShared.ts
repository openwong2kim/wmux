/**
 * Entry point for the terminal behaviour the desktop renderer and the daemon's
 * browser client share. scripts/build-daemon-web.mjs bundles this file with
 * esbuild into an IIFE that publishes `window.wmuxTerminalShared`, inlined
 * into terminal.html ahead of app.js — so the web runs the desktop's module,
 * not a copy of it. Keep this a pure re-export surface.
 */
export {
  STALE_REPLAY_ALIVE_SHELL_RESETS,
  STALE_REPLAY_DISPLAY_RESETS,
  STALE_REPLAY_INPUT_MODE_RESETS,
  staleReplayResetLevel,
} from './staleReplayModeReset';
export { gateUserInput } from './userInputGate';
