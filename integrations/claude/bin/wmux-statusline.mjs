#!/usr/bin/env node
// wmux statusline for Claude Code — renders `<model> · <account> · 5h N% · 7d N%`
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
// The account NAME comes from wmux's accounts.json (registered accounts), so
// this script has no dependency on wmux's opt-in usage-probe feature at all.
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

  // Account label: registered name > 'default' for ~/.claude > dir basename.
  const name = lookupAccountName(home, want) ?? (isDefaultDir ? 'default' : basename(configDir));
  parts.push(name);

  // Percentages: stdin rate_limits (free, live, per-session) first. Each
  // window may be independently absent per the statusline contract.
  const rl = input?.rate_limits;
  const fiveHour = rl?.five_hour?.used_percentage;
  const sevenDay = rl?.seven_day?.used_percentage;
  if (typeof fiveHour === 'number') parts.push(`5h ${Math.round(fiveHour)}%`);
  if (typeof sevenDay === 'number') parts.push(`7d ${Math.round(sevenDay)}%`);

  if (typeof fiveHour !== 'number' && typeof sevenDay !== 'number') {
    // rate_limits hasn't arrived yet (first turn pending) or this session has
    // no subscription limits. Show a dash so the user can tell the statusline
    // itself is alive.
    parts.push('usage —');
  }

  process.stdout.write(parts.join(' · '));
}

main();
