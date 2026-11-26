// wmux-managed: omp-extension
// wmux ↔ Oh My Pi (omp) lifecycle status (#3276).
//
// omp runs no hook commands from a config file; it imports every module in
// ~/.omp/agent/extensions/. `wmux setup-hooks --agent omp` copies this file
// there as wmux.js (--status reports it, --remove deletes it). It subscribes to
// omp's lifecycle events and, for each one, runs the shared hook bridge:
//
//   node ~/.wmux/hooks/wmux-hooks-bridge.mjs omp <omp event name>
//
// with `{"session_id", "cwd"}` on stdin. The bridge turns that into the
// standard AgentSignal envelope and sends it over `hooks.signal`, attributing
// it to the pane through the WMUX_* env this process inherited, exactly as it
// does for every other flavour. The event mapping lives in the bridge's
// flavour table (row `omp`), not here.
//
// Written against omp's public extension API (@oh-my-pi/pi-coding-agent
// 19.2.1, src/extensibility/extensions/types.ts): a default-exported factory
// receiving ExtensionAPI, `pi.on(event, (event, ctx) => …)`, and ctx.cwd,
// ctx.sessionManager.getSessionId() and ctx.agent.kind.
//
// Rules:
//   * Metadata only: the prompt, messages and tool inputs in omp's events are
//     never read or forwarded.
//   * Never in omp's way: handlers return at once (nothing is awaited), every
//     failure is swallowed, and outside a wmux pane nothing is subscribed.
//   * Main session only: omp rebinds extensions to every subagent, whose
//     turn ends are not the pane's.
//   * Bridge runs are queued, so the daemon sees events in the order omp
//     fired them. A run starts inside the handler whenever none is pending,
//     and session_shutdown always does: omp may exit as soon as its handlers
//     return (print mode exits right after agent_end), so anything left for
//     later would be lost.
//   * The payload reaches the bridge's stdin from a file, not a pipe: it is
//     there before the bridge starts, so it survives omp exiting at once.
//
// SELF-CONTAINED: plain JavaScript, Node built-ins only (omp runs it under Bun).

import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const FLAVOUR = 'omp';
const BRIDGE_BASENAME = 'wmux-hooks-bridge.mjs';
// The bridge caps itself at 2s; a run that outlives this no longer holds the queue.
const RUN_WAIT_MS = 3000;

/** The omp events this module forwards. Each is mapped in the bridge's `omp` row. */
export const EVENTS = [
  'session_start', 'before_agent_start', 'agent_end', 'tool_approval_requested', 'tool_approval_resolved', 'session_shutdown',
];

/** Whether an event is the main session's and marks a state change. */
function forwards(name, event, ctx) {
  if (ctx?.agent?.kind === 'sub') return false;
  // Not a settle: omp continues on its own, or a parked subagent wakes.
  if (name === 'agent_end' && event?.willContinue === true) return false;
  if (name === 'before_agent_start' && event?.reason === 'revive') return false;
  // Without a UI (print, RPC) omp denies an approval at once: nobody waits.
  if (name.startsWith('tool_approval_') && ctx?.hasUI === false) return false;
  return true;
}

function sessionIdOf(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The extension, with its process seams injectable for tests: `env` decides
 * whether this is a wmux pane, `spawn` starts the bridge, `bridgePath` names it.
 */
export function createWmuxExtension({
  env = process.env,
  spawn = nodeSpawn,
  bridgePath = join(homedir(), '.wmux', 'hooks', BRIDGE_BASENAME),
  platform = process.platform,
  tempDir = tmpdir(),
} = {}) {
  return function wmuxExtension(pi) {
    if (!env.WMUX_PTY_ID) return;
    let queue = Promise.resolve();
    let pending = 0;
    // After session_shutdown a run still queued would land after session_end.
    let closed = false;

    /** Starts one bridge run now; resolves when it is over (or has had its time). */
    const run = (name, payload) => new Promise((resolve) => {
      if (closed && name !== 'session_shutdown') { resolve(); return; }
      const file = join(tempDir, `wmux-omp-${process.pid}-${randomBytes(6).toString('hex')}.json`);
      let fd = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // Windows refuses to unlink a file the bridge still has open; it is
        // gone by `close`, which is when this runs there.
        try { unlinkSync(file); } catch { /* already gone */ }
        resolve();
      };
      const timer = setTimeout(finish, RUN_WAIT_MS);
      try {
        writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
        fd = openSync(file, 'r');
        const child = spawn('node', [bridgePath, FLAVOUR, name], {
          env,
          stdio: [fd, 'ignore', 'ignore'],
          windowsHide: true,
          // Outlives omp on session_shutdown; Windows keeps the default so no
          // console window is created.
          detached: platform !== 'win32',
        });
        child.on('error', finish);
        child.on('close', finish);
        child.unref?.();
        // The bridge holds its own copy of the descriptor; on POSIX the file
        // can go at once.
        if (platform !== 'win32') { try { unlinkSync(file); } catch { /* finish retries */ } }
      } catch {
        finish();
      } finally {
        if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
      }
    });

    const settled = () => { pending -= 1; };

    for (const name of EVENTS) {
      pi.on(name, (event, ctx) => {
        try {
          if (!forwards(name, event, ctx)) return;
          const payload = { session_id: sessionIdOf(ctx), cwd: typeof ctx?.cwd === 'string' ? ctx.cwd : undefined };
          pending += 1;
          if (name === 'session_shutdown') closed = true;
          if (pending === 1 || name === 'session_shutdown') {
            queue = run(name, payload).then(settled);
          } else {
            queue = queue.then(() => run(name, payload)).then(settled);
          }
        } catch { /* never in omp's way */ }
      });
    }
  };
}

export default createWmuxExtension();
