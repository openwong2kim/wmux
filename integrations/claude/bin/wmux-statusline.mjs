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
// Where the numbers come from: wmux's AccountUsageService probes Anthropic's
// rate-limit headers per account (hook-gated on agent.stop, opt-in) and mirrors
// its cache to `~/.wmux/usage/usage-cache.json`. This script only READS that
// file — it never touches credentials and never talks to the network, so it is
// safe to run at statusline frequency.
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

/** Lexical dir identity, case-folded on Windows. The cache file stores the
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

function readCache(home) {
  try {
    const raw = readFileSync(join(home, '.wmux', 'usage', 'usage-cache.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
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

  const entries = readCache(home);
  const entry = entries.find(
    (e) => e && typeof e.configDir === 'string' && normDir(e.configDir) === want,
  ) ?? null;

  const parts = [];

  const model = input?.model?.display_name;
  if (typeof model === 'string' && model.length > 0) parts.push(model);

  // Account label: registered name > 'default' for ~/.claude > dir basename.
  const name = typeof entry?.name === 'string' && entry.name.length > 0
    ? entry.name
    : (isDefaultDir ? 'default' : basename(configDir));
  parts.push(name);

  const snap = entry?.snapshot;
  if (snap && typeof snap.sessionPct === 'number' && typeof snap.weeklyPct === 'number') {
    parts.push(`5h ${snap.sessionPct}%`);
    parts.push(`7d ${snap.weeklyPct}%`);
    // Probes are hook-gated with a 5-min cooldown; anything hours old means the
    // usage feature is off or this account has not had a turn in a long while.
    const age = Date.now() - (typeof entry.fetchedAtMs === 'number' ? entry.fetchedAtMs : 0);
    if (age > 2 * 60 * 60 * 1000) parts.push('stale');
  } else {
    // No cache row yet: the wmux usage toggle is off, wmux has not run, or this
    // account has never been probed. Show a dash rather than nothing so the
    // user can tell the statusline itself is alive.
    parts.push('usage —');
  }

  process.stdout.write(parts.join(' · '));
}

main();
