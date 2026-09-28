#!/usr/bin/env node
// wmux statusline for Claude Code — renders
// `<model> · <account> · 5h N% ↺ HH:MM · 7d N% ↺ Nh` (beyond 48h: `↺ NdNh`)
// on the line under the input box (Claude Code `statusLine` command).
//
// How it knows WHICH account this session runs on: the statusline process is
// spawned by the claude process itself, so it inherits CLAUDE_CONFIG_DIR — the
// exact per-pane account selection, regardless of whether it came from a wmux
// workspace binding, a workspace profile env, or a manually-typed
// `$env:CLAUDE_CONFIG_DIR=...; claude`. No CLAUDE_CONFIG_DIR means the default
// `~/.claude` profile.
//
// Where the numbers come from — stdin ONLY, zero cost: Claude Code ≥2.1 pipes
// `rate_limits.five_hour/seven_day.used_percentage` on stdin for Pro/Max
// subscribers (absent before the session's first API response, and absent
// per-window). No network, no token spend, and inherently per-account because
// it comes from THIS session. Before the first response (or on older Claude
// Code / non-subscribers) the statusline shows `usage —`.
// The account NAME resolves, in order: wmux accounts.json registered name >
// the logged-in identity's email (oauthAccount in the config dir's
// .claude.json) > dir basename. All local reads — no dependency on wmux's
// opt-in usage-probe feature at all.
//
// This script never touches credentials and never talks to the network, so it
// is safe to run at statusline frequency. Its one write-side effect is local:
// AFTER the line is written to stdout, a changed `rate_limits` sample is
// pushed to the running wmux app over its local main pipe (`usage.rateLimits`,
// authenticated with the ~/.wmux<suffix>-auth-token file) so the usage view
// shows live numbers instead of polling. That push is fire-and-forget: sent
// only when the sample differs from the last one delivered for this config
// dir (a small state file in the OS temp dir), capped at 300 ms, every error
// swallowed, and it never changes stdout or the exit code. With wmux not
// running (no token / no pipe) it costs a file read and nothing else.
//
// Self-contained on purpose: Claude Code invokes it as a bare `node` command
// from settings.json, so no TS imports and no wmux install-dir dependency
// (installed to the stable ~/.wmux/hooks/ path by `wmux setup-statusline`).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

/** Hard cap for the live-usage push, connect to reply, all pipes included. */
const PUSH_TIMEOUT_MS = 300;
/** A push that did not get through is retried on a later render, at most this often. */
const PUSH_RETRY_MS = 60_000;

function getHome() {
  return process.env.USERPROFILE || process.env.HOME || homedir();
}

/** Lexical dir identity, case-folded on Windows. accounts.json stores the
 *  canonical (realpath) form; CLAUDE_CONFIG_DIR is usually the same literal
 *  string wmux injected, so lexical compare covers the practical cases without
 *  a realpath call on every statusline tick. */
function normDir(p) {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Registered account name for this config dir, from wmux accounts.json. */
function lookupAccountName(home, want) {
  const parsed = readJsonFile(join(home, '.wmux', 'accounts.json'));
  const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  const hit = accounts.find(
    (a) => a && a.vendor === 'claude' && typeof a.configDir === 'string' && normDir(a.configDir) === want,
  );
  return typeof hit?.name === 'string' && hit.name.length > 0 ? hit.name : null;
}

/**
 * Logged-in identity from the config dir's `.claude.json` (oauthAccount).
 * CLAUDE_CONFIG_DIR partitions the whole config, so a bound account's file
 * lives at `<configDir>/.claude.json`; the default profile's lives at
 * `~/.claude.json`. Returns the email's local part ("name" for
 * name@example.com) to keep the line compact; null when unavailable.
 */
function lookupLoginEmail(home, configDir, isDefaultDir) {
  const candidates = isDefaultDir
    ? [join(home, '.claude.json'), join(configDir, '.claude.json')]
    : [join(configDir, '.claude.json')];
  for (const c of candidates) {
    const parsed = readJsonFile(c);
    const email = parsed?.oauthAccount?.emailAddress;
    if (typeof email === 'string' && email.length > 0) {
      const at = email.indexOf('@');
      return at > 0 ? email.slice(0, at) : email;
    }
  }
  return null;
}

function main() {
  const input = readStdinJson();
  const home = getHome();

  const rawConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = typeof rawConfigDir === 'string' && rawConfigDir.length > 0
    ? rawConfigDir
    : join(home, '.claude');
  const want = normDir(configDir);
  const isDefaultDir = want === normDir(join(home, '.claude'));

  const parts = [];

  // Model label: `Opus 4.8 (xhigh)` — the model and the effort it runs at, and
  // deliberately nothing else. The context-window SIZE is not rendered: it is a
  // property of the account's model selection that rarely differs pane to pane,
  // and the live fill (`ctx N%` below) is the part that actually changes. Two
  // stdin fields feed the label:
  //   display_name — older Claude Code baked a verbose " (1M context)" suffix
  //     into it for `[1m]` model variants ("Opus 4.7 (1M context)"); ≥2.1.218
  //     sends the clean name and reports the window under context_window
  //     instead. The suffix is stripped so both versions render identically.
  //   effort.level — present only on models that expose one ("high", "xhigh"…);
  //     a model without one renders as a bare `Haiku 4.5`.
  const model = input?.model?.display_name;
  if (typeof model === 'string' && model.length > 0) {
    const name = model.replace(/ \(1M context\)$/, '');
    const effort = input?.effort?.level;
    parts.push(typeof effort === 'string' && effort.length > 0 ? `${name} (${effort})` : name);
  }

  // Account label: registered wmux name > logged-in email local part >
  // 'default' for ~/.claude > dir basename.
  const name = lookupAccountName(home, want)
    ?? lookupLoginEmail(home, configDir, isDefaultDir)
    ?? (isDefaultDir ? 'default' : basename(configDir));
  parts.push(name);

  // THIS session's live context-window fill (input-side tokens vs window
  // size). May be null early in the session and right after /compact.
  const ctx = input?.context_window?.used_percentage;
  if (typeof ctx === 'number') parts.push(`ctx ${Math.round(ctx)}%`);

  // Account-level percentages: stdin rate_limits (free, live, per-session).
  // Each window may be independently absent per the statusline contract.
  const rl = input?.rate_limits;
  const fiveHour = rl?.five_hour?.used_percentage;
  const sevenDay = rl?.seven_day?.used_percentage;
  if (typeof fiveHour === 'number') {
    // The 5h window resets within hours, so WHEN it frees up is actionable —
    // show the local reset time (HH:MM). Space after ↺ so terminal fonts that
    // render it double-width don't swallow the first digit.
    const resetsAt = rl?.five_hour?.resets_at;
    let reset = '';
    if (typeof resetsAt === 'number' && resetsAt * 1000 > Date.now()) {
      const d = new Date(resetsAt * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      reset = ` ↺ ${hh}:${mm}`;
    }
    parts.push(`5h ${Math.round(fiveHour)}%${reset}`);
  }
  if (typeof sevenDay === 'number') {
    // The 7d reset is days out, so remaining TIME (not clock time) is what's
    // actionable: `↺ 52h`, or `↺ 2d4h` once it exceeds 48h.
    const resetsAt = rl?.seven_day?.resets_at;
    let reset = '';
    const now = Date.now();
    if (typeof resetsAt === 'number' && resetsAt * 1000 > now) {
      const msLeft = resetsAt * 1000 - now;
      if (msLeft >= 48 * 3600000) {
        const hoursLeft = Math.round(msLeft / 3600000);
        const d = Math.floor(hoursLeft / 24);
        const h = hoursLeft % 24;
        reset = h > 0 ? ` ↺ ${d}d${h}h` : ` ↺ ${d}d`;
      } else {
        // ceil so a positive remainder never renders as `0h`
        reset = ` ↺ ${Math.ceil(msLeft / 3600000)}h`;
      }
    }
    parts.push(`7d ${Math.round(sevenDay)}%${reset}`);
  }

  if (typeof fiveHour !== 'number' && typeof sevenDay !== 'number') {
    // rate_limits hasn't arrived yet (first turn pending) or this session has
    // no subscription limits. Show a dash so the user can tell the statusline
    // itself is alive.
    parts.push('usage —');
  }

  const sample = rateLimitsSample(rl);
  process.stdout.write(parts.join(' · '), () => {
    if (!sample) return;
    pushRateLimits(home, typeof rawConfigDir === 'string' && rawConfigDir.length > 0 ? rawConfigDir : null, sample)
      .catch(() => { /* never let the push affect the statusline */ });
  });
}

/** The windows the app wants: `{ pct, resets_at }` (epoch seconds), only
 *  those Claude Code actually sent. Null when there is nothing to push. */
function rateLimitsSample(rl) {
  const out = {};
  for (const key of ['five_hour', 'seven_day']) {
    const pct = rl?.[key]?.used_percentage;
    const resetsAt = rl?.[key]?.resets_at;
    if (typeof pct === 'number' && typeof resetsAt === 'number') out[key] = { pct, resets_at: resetsAt };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ----- live usage push (main pipe) -----------------------------------------
// Pipe/token naming mirrors wmux-bridge.mjs (and src/shared/constants.ts
// getPipeName): WMUX_DATA_SUFFIX isolates dev/demo instances, and
// WMUX_SOCKET_PATH — injected into wmux panes — is preferred, with the derived
// name as the fallback for a stale value.

function mainPipePaths() {
  const suffix = process.env.WMUX_DATA_SUFFIX || '';
  const derived = process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux${suffix}-${userInfo().username || 'default'}`
    : join(homedir() || '/tmp', `.wmux${suffix}.sock`);
  const env = process.env.WMUX_SOCKET_PATH;
  return typeof env === 'string' && env.length > 0 && env !== derived ? [env, derived] : [derived];
}

function readState(path) {
  const parsed = readJsonFile(path);
  return parsed && typeof parsed.sig === 'string' ? parsed : null;
}

function writeState(path, state) {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Unwritable temp dir: the next render simply pushes again.
  }
}

async function pushRateLimits(home, configDir, rateLimits) {
  const pipes = mainPipePaths();
  const sig = JSON.stringify({ configDir, rateLimits });
  const key = createHash('sha1').update(`${pipes[0]}\0${configDir ?? ''}`).digest('hex').slice(0, 16);
  const statePath = join(tmpdir(), `wmux-statusline-${key}.json`);
  const prev = readState(statePath);
  const now = Date.now();
  if (prev && prev.sig === sig && (prev.ok || now - (prev.at || 0) < PUSH_RETRY_MS)) return;

  let token = null;
  try {
    token = readFileSync(join(home, `.wmux${process.env.WMUX_DATA_SUFFIX || ''}-auth-token`), 'utf8').trim() || null;
  } catch {
    token = null;
  }
  if (!token) return; // wmux has never run here — nothing to tell

  const request = {
    id: `statusline-${randomUUID()}`,
    method: 'usage.rateLimits',
    params: { configDir, ptyId: process.env.WMUX_PTY_ID || null, rateLimits },
    token,
  };
  const deadline = now + PUSH_TIMEOUT_MS;
  let delivered = false;
  for (const pipe of pipes) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const res = await sendOnce(pipe, request, remaining);
    if (res === 'reply') { delivered = true; break; }
    if (res !== 'no-pipe') break; // reached something but no answer — don't double-send
  }
  writeState(statePath, { sig, ok: delivered, at: Date.now() });
}

/** One request over one pipe. Resolves 'reply' (any response with our id —
 *  the app heard it, whatever it decided), 'no-pipe' (could not connect; safe
 *  to try the next pipe) or 'fail'. Never rejects. */
function sendOnce(pipe, request, timeoutMs) {
  return new Promise((resolveResult) => {
    let settled = false;
    let wrote = false;
    let buffer = '';
    const sock = createConnection(pipe);
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      resolveResult(r);
    };
    const timer = setTimeout(() => settle('fail'), timeoutMs);
    sock.on('connect', () => {
      wrote = true;
      sock.write(JSON.stringify(request) + '\n');
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          if (JSON.parse(line)?.id === request.id) { settle('reply'); return; }
        } catch { /* not ours */ }
      }
    });
    sock.on('error', () => settle(wrote ? 'fail' : 'no-pipe'));
    sock.on('close', () => settle(wrote ? 'fail' : 'no-pipe'));
  });
}

main();
