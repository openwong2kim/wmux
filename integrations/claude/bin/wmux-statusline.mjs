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
// This script only READS local files — it never touches credentials and never
// talks to the network, so it is safe to run at statusline frequency.
//
// Self-contained on purpose: Claude Code invokes it as a bare `node` command
// from settings.json, so no TS imports and no wmux install-dir dependency
// (installed to the stable ~/.wmux/hooks/ path by `wmux setup-statusline`).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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
 * `~/.claude.json`. Returns the email's local part ("wykim777" for
 * wykim777@naver.com) to keep the line compact; null when unavailable.
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

  const model = input?.model?.display_name;
  if (typeof model === 'string' && model.length > 0) parts.push(model);

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

  process.stdout.write(parts.join(' · '));
}

main();
