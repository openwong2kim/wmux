// wmux-managed: kiro-lifecycle-bridge
// wmux ↔ Kiro CLI hook bridge — now a thin entry point onto the shared
// Claude-compatible hook bridge (integrations/shared/bin/wmux-hooks-bridge.mjs,
// flavour `kiro`). Everything this file used to do — the trigger map, the
// metadata-only envelope, the drop-without-WMUX_PTY_ID rule, the daemon-then-
// main send walk, the always-exit-0 watchdog, kiro-bridge.log — lives in that
// flavour row and runs unchanged. Kiro's measured contract (kiro-cli 2.15.1,
// 2026-08-16) is recorded there.
//
// Registered inside a wmux-owned Kiro agent config (`~/.kiro/agents/wmux.json`):
//   "hooks": { "stop": [{ "command": "node \"<abs path to this file>\"" }] }
// so the command Kiro runs is unchanged by the move.
//
// Two layouts, one file:
//   * installed: copied next to wmux-hooks-bridge.mjs (both in one directory);
//   * source checkout: the shared bridge lives in integrations/shared/bin/.
// The import below tries them in that order. A copy taken from an older wmux
// (before this move) is self-contained and keeps working as it was.
//
// NO SHEBANG, deliberately: Kiro invokes this as `node "<path>"`, and Vitest
// cannot parse a `.mjs` that starts with one.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

async function loadShared() {
  try {
    // Present only in the installed layout; the catch covers a source checkout.
    // eslint-disable-next-line import/no-unresolved
    return await import('./wmux-hooks-bridge.mjs');
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return import('../../shared/bin/wmux-hooks-bridge.mjs');
  }
}

const shared = await loadShared();

/** The Kiro envelope builder — the shared normaliser with the `kiro` flavour. */
export function buildKiroEnvelope(payload, options = {}) {
  return shared.buildHookEnvelope('kiro', payload, options);
}

export const shouldTryNextTarget = shared.shouldTryNextTarget;

// Run only when Kiro spawned THIS file. Fails OPEN, like every bridge: a bridge
// that silently declines to run is the worse failure.
function invokedAsScript() {
  try {
    if (!process.argv[1]) return true;
    const real = (p) => {
      try {
        return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
      } catch {
        return p;
      }
    };
    const norm = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
    return norm(fileURLToPath(import.meta.url)) === norm(resolve(process.argv[1]));
  } catch {
    return true;
  }
}

if (invokedAsScript()) {
  // The Kiro config passes no event name; the payload's hook_event_name
  // carries it, exactly as before.
  shared.runHookProcess('kiro', undefined);
}
