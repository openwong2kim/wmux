#!/usr/bin/env node
// wmux ↔ Claude Code hook bridge.
//
// Invoked by Claude Code when one of its hooks fires (PostToolUse, Stop,
// SubagentStop, SessionStart). This script:
//   1. Determines the hook name from process.argv[2].
//   2. Reads the Claude Code hook payload from stdin (JSON).
//   3. Builds the canonical AgentSignal envelope.
//   4. Reads the wmux auth token from ~/.wmux-auth-token.
//   5. Connects to the wmux main-process named pipe.
//   6. Sends an RPC: hooks.signal { ...envelope }
//   7. Logs the outcome to ~/.wmux/bridge.log.
//   8. Exits 0 ALWAYS (so a wmux problem never breaks Claude Code).
//
// THIS FILE IS SELF-CONTAINED. It runs from inside a Claude Code plugin
// where TypeScript transpilation is NOT available. Do not import anything
// from src/, integrations/shared/, or node_modules — only Node built-ins.
//
// Codex review 2026-05-22 P0 #2: bridges must be JS-only.
// Codex review 2026-05-22 P0 #4: token is read from disk, not env.

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';

const HOOK_TIMEOUT_MS = 2000; // hard cap so we never slow Claude
const BRIDGE_VERSION = '0.1.0';

// ----- Hook name → AgentSignal kind ---------------------------------------

const HOOK_TO_KIND = {
  PostToolUse: 'agent.activity',
  Stop: 'agent.stop',
  SubagentStop: 'agent.subagent_stop',
  SessionStart: 'agent.session_start',
};

// ----- Path helpers (Node built-ins only) ---------------------------------

function getAuthTokenPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  return join(home, '.wmux-auth-token');
}

function getPipeName() {
  if (process.platform === 'win32') {
    const username = userInfo().username || 'default';
    return `\\\\.\\pipe\\wmux-${username}`;
  }
  return join(homedir() || '/tmp', '.wmux.sock');
}

function getBridgeLogPath() {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const dir = join(home, '.wmux');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // mkdir failures fall through; appendFileSync below will also fail
    // and the catch in logEvent will silently drop. We never throw
    // upward from this script.
  }
  return join(dir, 'bridge.log');
}

// ----- Logging (best-effort, never throws) --------------------------------

function logEvent(outcome, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    bridge: BRIDGE_VERSION,
    pid: process.pid,
    hook: process.argv[2] ?? '?',
    outcome,
    ...(extra ?? {}),
  });
  try {
    appendFileSync(getBridgeLogPath(), line + '\n', { encoding: 'utf8' });
  } catch {
    // No writable home → swallow. Nothing more we can do.
  }
}

// ----- stdin reader -------------------------------------------------------

async function readStdin() {
  const chunks = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const buf = Buffer.concat(chunks).toString('utf8').trim();
      if (!buf) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on('error', reject);
  });
}

// ----- RPC over named pipe ------------------------------------------------

function sendRpc(pipePath, request) {
  return new Promise((resolve) => {
    const sock = createConnection(pipePath);
    let buffer = '';
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* socket already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: 'timeout' });
    }, HOOK_TIMEOUT_MS);

    sock.on('connect', () => {
      sock.write(JSON.stringify(request) + '\n');
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const line = buffer.slice(0, nl);
        clearTimeout(timer);
        try {
          settle(JSON.parse(line));
        } catch {
          settle({ ok: false, error: 'malformed-response' });
        }
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, error: 'connect-error', detail: err.code ?? err.message });
    });
    sock.on('close', () => {
      clearTimeout(timer);
      settle({ ok: false, error: 'closed-without-response' });
    });
  });
}

// ----- Main ---------------------------------------------------------------

async function main() {
  const hookName = process.argv[2];
  if (!hookName || !HOOK_TO_KIND[hookName]) {
    logEvent('unknown-hook-name', { argv: process.argv });
    return; // exit 0 below
  }

  let payload;
  try {
    payload = await readStdin();
  } catch (err) {
    logEvent('malformed-stdin', { error: String(err) });
    return;
  }
  // Empty stdin is allowed for SessionStart per Claude Code spec.
  if (payload === null && hookName !== 'SessionStart') {
    logEvent('empty-stdin', { hook: hookName });
    return;
  }

  const tokenPath = getAuthTokenPath();
  if (!existsSync(tokenPath)) {
    logEvent('no-auth-token', { path: tokenPath });
    return;
  }
  let token;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch (err) {
    logEvent('auth-token-read-error', { error: String(err) });
    return;
  }
  if (!token) {
    logEvent('empty-auth-token', {});
    return;
  }

  // Build the AgentSignal envelope. Schema mirrors
  // integrations/shared/signal-types.ts (kept in sync manually because
  // this is JS-only).
  const envelope = {
    kind: HOOK_TO_KIND[hookName],
    agent: 'claude',
    agentSessionId: (payload && typeof payload.session_id === 'string') ? payload.session_id : undefined,
    cwd: process.cwd(),
    payload: payload ?? {},
    ts: Date.now(),
  };

  const request = {
    id: `bridge-${randomUUID()}`,
    method: 'hooks.signal',
    params: envelope,
    token,
  };

  const result = await sendRpc(getPipeName(), request);

  if (result.ok) {
    logEvent('ok', { hook: hookName });
  } else {
    logEvent('rpc-failed', { hook: hookName, error: result.error, reason: result.reason });
  }
}

// Run; never throw upward (every error path logs and falls through to exit 0).
main()
  .catch((err) => {
    logEvent('uncaught', { error: String(err) });
  })
  .finally(() => {
    process.exit(0);
  });
