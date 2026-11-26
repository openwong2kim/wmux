// wmux-managed: jcode-hooks-bridge
// wmux ↔ jcode observer hooks: a thin entry point onto the shared hook bridge
// (wmux-hooks-bridge.mjs, flavour `jcode`).
//
// jcode (docs/HOOKS.md) spawns each hook command directly, detached, and passes
// the event in JCODE_HOOK_* environment variables rather than JSON on stdin.
// This file turns that environment into the payload the shared bridge reads
// and hands it over, so stdin is never touched. Everything else (the event
// map, the drop-without-WMUX_PTY_ID rule, the daemon-then-main send, the
// always-exit-0 watchdog, jcode-hooks.log) is the shared bridge's.
//
// Registered in ~/.jcode/config.toml, one entry per event:
//   [hooks]
//   turn_end = ["node /abs/path/to/wmux-jcode-bridge.mjs"]
// jcode parses the line shell-style (backslash escapes), so Windows paths are
// written with forward slashes.
//
// METADATA ONLY. Reads JCODE_HOOK_EVENT, JCODE_HOOK_SESSION_ID, JCODE_HOOK_CWD
// and JCODE_HOOK_SOURCE, nothing else: JCODE_HOOK_PAYLOAD and
// JCODE_HOOK_LAST_ASSISTANT_TEXT carry content and are never read.
//
// Two layouts, one file: installed next to wmux-hooks-bridge.mjs, or the
// source checkout (integrations/shared/bin/). NO SHEBANG: jcode runs it through
// `node`, and Vitest cannot parse a `.mjs` that starts with one.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

async function loadShared() {
  // The first path exists only in the installed layout.
  // eslint-disable-next-line import/no-unresolved
  for (const load of [() => import('./wmux-hooks-bridge.mjs'), () => import('../../shared/bin/wmux-hooks-bridge.mjs')]) {
    try {
      return await load();
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    }
  }
  return null;
}

// jcode's session_start source → the start source wmux gives meaning to.
// The daemon treats every agent.session_start as a fresh session on the pane
// (it clears the previous one's labels), so a start whose source is not one of
// these (`attach`: an existing session object attached, or none) sends nothing.
const JCODE_SOURCES = { create: 'startup', resume: 'resume' };

/** The shared bridge payload for one jcode hook invocation, from its env. */
export function jcodePayloadFromEnv(env = process.env) {
  const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const event = str(env.JCODE_HOOK_EVENT);
  const sessionId = str(env.JCODE_HOOK_SESSION_ID);
  const cwd = str(env.JCODE_HOOK_CWD);
  const rawSource = str(env.JCODE_HOOK_SOURCE);
  const source = rawSource && Object.hasOwn(JCODE_SOURCES, rawSource) ? JCODE_SOURCES[rawSource] : undefined;
  if (event === 'session_start' && !source) return {};
  return {
    ...(event ? { hook_event_name: event } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(event === 'session_start' && source ? { source } : {}),
  };
}

let shared = null;
let loadError = null;
try {
  shared = await loadShared();
} catch (err) {
  loadError = err;
}
if (!shared) {
  // Spawned by jcode with the shared bridge missing or broken: still exit 0,
  // silently. Imported (tests): fail loudly instead.
  if (invokedAsScript()) process.exit(0);
  throw loadError ?? new Error('wmux-jcode-bridge: wmux-hooks-bridge.mjs not found beside it or in the source tree');
}

/** The jcode envelope builder: the shared normaliser over the env payload. */
export function buildJcodeEnvelope(env = process.env, options = {}) {
  return shared.buildHookEnvelope('jcode', jcodePayloadFromEnv(env), { env, ...options });
}

// Run only when jcode spawned THIS file. Fails OPEN, like every bridge.
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
  shared.runHookProcess('jcode', undefined, { payload: jcodePayloadFromEnv(process.env) });
}
