// Shared MCP registration orchestration (fs + configIO), used by BOTH the
// main-process McpRegistrar and the standalone `wmux mcp` CLI so the two
// registration paths stay byte-identical. Pure Node fs — no Electron — so it
// imports cleanly into the CLI bundle.
//
// Per-target rules (see mcpTargets.ts / McpRegistrar.ts header):
//   - uninstalled agent (config absent + !createIfMissing) → skipped, never created
//   - malformed config → left untouched (never clobbered)
//   - foreign entry (a `wmux` key whose command !== node) → left untouched
//   - TOML writes are surgical (configIO) so comments / order / quoted keys survive
//   - all writes atomic (tmp + rename)

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  MCP_TARGETS,
  WMUX_SERVER_KEY,
  WMUX_SERVER_KEYS,
  getMcpTarget,
  type McpTarget,
  type McpConfigFormat,
} from './mcpTargets';
import {
  parseConfig,
  getMcpServerEntry,
  getMcpServerScript,
  isWmuxOwnedEntry,
  upsertMcpServer,
  wmuxEntryArgs,
  removeMcpServers,
  isWmuxOwnedNotify,
  upsertNotifyToml,
  removeNotifyToml,
  type WmuxMcpEntryProfile,
} from './configIO';

export interface ServerRegState {
  registered: boolean;
  path: string | null;
}

export interface TargetRegStatus {
  id: string;
  displayName: string;
  format: McpConfigFormat;
  configPath: string;
  configExists: boolean;
  configModified: Date | null;
  verified: boolean;
  wmux: ServerRegState;
}

/** Atomic write (tmp + rename), creating the parent dir if needed. The temp
 *  name carries a per-process random suffix so two concurrent writers (CLI +
 *  GUI registrar, or parallel CLI invocations) can't collide on a shared
 *  `.tmp`; the temp file is cleaned up if the rename fails. */
export function writeFileAtomic(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
}

/** Pure read of one target's registration state. Never creates / throws. */
export function readTargetStatus(target: McpTarget, home: string): TargetRegStatus {
  const configPath = target.configPath(home);
  let configExists = false;
  let configModified: Date | null = null;
  try {
    const stat = fs.statSync(configPath);
    configExists = stat.isFile();
    configModified = configExists ? stat.mtime : null;
  } catch {
    configExists = false;
  }

  let wmuxPath: string | null = null;
  if (configExists) {
    try {
      const parsed = parseConfig(fs.readFileSync(configPath, 'utf8'), target.format);
      wmuxPath = getMcpServerScript(parsed, target.format, WMUX_SERVER_KEY);
    } catch {
      // corrupted → not registered
    }
  }

  return {
    id: target.id,
    displayName: target.displayName,
    format: target.format,
    configPath,
    configExists,
    configModified,
    verified: target.verified,
    wmux: { registered: wmuxPath !== null, path: wmuxPath },
  };
}

export function readAllTargetStatuses(home: string): TargetRegStatus[] {
  return MCP_TARGETS.map((t) => readTargetStatus(t, home));
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface RegisterTargetResult {
  configPath: string;
  /** 'absent' = uninstalled (skipped, not created); 'malformed' = corrupt (untouched). */
  skipped: 'absent' | 'malformed' | null;
  /** keys written/updated this call. */
  wrote: string[];
  /** keys left untouched because a foreign (non-node) entry occupies them. */
  foreign: string[];
}

/**
 * Ensure the `wmux` MCP server points at `wmuxScript` in one target's config.
 * `ownedKeys` (optional) tracks keys written this session so a key wmux already
 * owns is updated even if its on-disk shape looks foreign-adjacent.
 *
 * `profile` (optional) is an explicit surface choice — `wmux mcp register
 * --profile core|full`. Automatic callers (McpRegistrar on boot, lifecycle
 * refresh) pass nothing, which preserves the profile already on disk.
 */
export function registerTarget(
  target: McpTarget,
  home: string,
  wmuxScript: string,
  ownedKeys?: Set<string>,
  profile?: WmuxMcpEntryProfile,
): RegisterTargetResult {
  const configPath = target.configPath(home);
  const exists = fs.existsSync(configPath);
  if (!exists && !target.createIfMissing) {
    return { configPath, skipped: 'absent', wrote: [], foreign: [] };
  }

  let text = '';
  if (exists) {
    try {
      text = fs.readFileSync(configPath, 'utf8');
    } catch {
      return { configPath, skipped: 'malformed', wrote: [], foreign: [] };
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfig(text, target.format);
  } catch {
    return { configPath, skipped: 'malformed', wrote: [], foreign: [] };
  }

  let newText = text;
  const wrote: string[] = [];
  const foreign: string[] = [];
  // Build + validate the new text. Parse/edit failures mean the config is in a
  // shape we can't safely edit → 'malformed' (graceful skip, never clobber).
  // The actual WRITE is intentionally OUTSIDE this catch so a permission/rename
  // failure propagates to the caller (McpRegistrar surfaces the macOS hint; the
  // CLI exits non-zero) instead of being misreported as "malformed".
  try {
    const existing = getMcpServerEntry(parsed, target.format, WMUX_SERVER_KEY);
    let skip = false;
    if (existing && !ownedKeys?.has(WMUX_SERVER_KEY)) {
      if (!isWmuxOwnedEntry(existing)) {
        foreign.push(WMUX_SERVER_KEY); // foreign hand-authored entry — never modify
        skip = true;
      } else if (
        // Compare the WHOLE args array, not just args[0]. The profile flags
        // live in args too, so a script-path match alone would call an entry
        // "up to date" while an explicit `--profile core|full` sat unapplied.
        // With no explicit profile the desired args preserve the on-disk ones,
        // so this still short-circuits every unchanged boot re-registration.
        arraysEqual(existing.args, wmuxEntryArgs(wmuxScript, profile, existing))
      ) {
        ownedKeys?.add(WMUX_SERVER_KEY); // already up to date
        skip = true;
      }
      // else: ours but stale path / different profile → update below
    }
    if (!skip) {
      // upsert validates its INPUT and OUTPUT, so an inline-table entry the
      // line-based editor can't target (which would duplicate) throws here.
      newText = upsertMcpServer(newText, target.format, WMUX_SERVER_KEY, wmuxScript, profile);
      wrote.push(WMUX_SERVER_KEY);
      ownedKeys?.add(WMUX_SERVER_KEY);
    }

    // Legacy cleanup only applies to Claude's JSON (old wmux-playwright keys
    // plus the removed wmux-a2a server, in case a historical stray exists).
    if (target.id === 'claude') {
      newText = removeMcpServers(newText, 'json', ['wmux-playwright', 'wmux-devtools', 'wmux-a2a']);
    }
  } catch {
    return { configPath, skipped: 'malformed', wrote: [], foreign };
  }

  if (newText !== text) writeFileAtomic(configPath, newText); // write errors propagate
  return { configPath, skipped: null, wrote, foreign };
}

export interface UnregisterTargetResult {
  configPath: string;
  removed: string[];
  configExisted: boolean;
}

/** Remove the wmux-owned `wmux` key from one target's config. */
export function unregisterTarget(target: McpTarget, home: string): UnregisterTargetResult {
  const configPath = target.configPath(home);
  if (!fs.existsSync(configPath)) return { configPath, removed: [], configExisted: false };

  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { configPath, removed: [], configExisted: true };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfig(text, target.format);
  } catch {
    return { configPath, removed: [], configExisted: true };
  }

  const toRemove = WMUX_SERVER_KEYS.filter((k) =>
    isWmuxOwnedEntry(getMcpServerEntry(parsed, target.format, k)),
  );
  if (toRemove.length === 0) return { configPath, removed: [], configExisted: true };

  const newText = removeMcpServers(text, target.format, toRemove);
  // No textual change → nothing was actually removed. This happens when the
  // entry exists only in a form the line-based editor can't target (e.g. an
  // inline table `wmux = { ... }` under a `[mcp_servers]` parent). Report an
  // honest empty `removed` rather than claiming a removal that didn't happen.
  if (newText === text) return { configPath, removed: [], configExisted: true };
  // Output-validation guard: never write a config that no longer parses.
  let reparsed: Record<string, unknown>;
  try {
    reparsed = parseConfig(newText, target.format);
  } catch {
    return { configPath, removed: [], configExisted: true };
  }
  writeFileAtomic(configPath, newText);
  // Report only keys that are ACTUALLY gone — a mixed config (one removable
  // header-form key + one un-targetable inline key) must not claim the inline
  // one was removed.
  const removed = toRemove.filter((k) => getMcpServerEntry(reparsed, target.format, k) === null);
  return { configPath, removed, configExisted: true };
}

// ── Codex `notify` resume-capture registration ───────────────────────────────
//
// Registers wmux's Codex resume-capture bridge (integrations/codex/bin/
// wmux-codex-notify.mjs) as Codex's `notify` program so a turn-complete captures
// the resume binding. Rides the same TOML-safe / only-if-installed / idempotent
// discipline as the MCP registration, plus skip-if-foreign (eng review decision
// 1: never clobber a user's own notify — a single root slot, unlike namespaced
// mcp_servers). Main-process only for v1 (McpRegistrar); the `wmux mcp` CLI does
// not resolve the packaged notify path, and the capture only functions while the
// wmux daemon is up anyway — the next boot registers it.

export interface RegisterNotifyResult {
  configPath: string;
  /** 'absent' = Codex not installed; 'malformed' = unparseable; 'foreign' = a
   *  user notify occupies the slot (left untouched); null = ours/absent. */
  skipped: 'absent' | 'malformed' | 'foreign' | null;
  wrote: boolean;
}

const norm = (p: string): string => p.replace(/\\/g, '/');

/** Preserve any present root notify value we cannot prove is wmux-owned. */
function inspectNotifySlot(parsed: Record<string, unknown>): {
  present: boolean;
  validStringArray: boolean;
  notify: string[] | null;
} {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'notify')) {
    return { present: false, validStringArray: true, notify: null };
  }
  const raw = parsed['notify'];
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === 'string')) {
    return { present: true, validStringArray: false, notify: null };
  }
  // An explicit empty array names no program, so it is safe for wmux to claim.
  if (raw.length === 0) {
    return { present: false, validStringArray: true, notify: null };
  }
  return { present: true, validStringArray: true, notify: raw as string[] };
}

export function registerCodexNotify(home: string, notifyScript: string): RegisterNotifyResult {
  const target = getMcpTarget('codex');
  if (!target) return { configPath: '', skipped: 'absent', wrote: false };
  const configPath = target.configPath(home);
  if (!fs.existsSync(configPath)) return { configPath, skipped: 'absent', wrote: false };

  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { configPath, skipped: 'malformed', wrote: false };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfig(text, 'toml');
  } catch {
    return { configPath, skipped: 'malformed', wrote: false };
  }

  const slot = inspectNotifySlot(parsed);
  // A root notify slot that is non-array, contains non-string values, or names
  // another program is user-owned/unknown. Treat all of those as a conflict so
  // setup never rewrites a value it cannot prove belongs to wmux.
  if (slot.present && (!slot.validStringArray || !isWmuxOwnedNotify(slot.notify))) {
    return { configPath, skipped: 'foreign', wrote: false };
  }
  const notify = slot.notify;
  if (isWmuxOwnedNotify(notify) && norm(notify?.[1] ?? '') === norm(notifyScript)) {
    return { configPath, skipped: null, wrote: false }; // already current — idempotent
  }

  let newText: string;
  try {
    newText = upsertNotifyToml(text, notifyScript);
  } catch {
    return { configPath, skipped: 'malformed', wrote: false };
  }
  if (newText !== text) writeFileAtomic(configPath, newText); // write errors propagate
  return { configPath, skipped: null, wrote: newText !== text };
}

/** Remove wmux's own notify entry from Codex config (foreign notify untouched). */
export function unregisterCodexNotify(home: string): { configPath: string; removed: boolean } {
  const target = getMcpTarget('codex');
  if (!target) return { configPath: '', removed: false };
  const configPath = target.configPath(home);
  if (!fs.existsSync(configPath)) return { configPath, removed: false };
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { configPath, removed: false };
  }
  let newText: string;
  try {
    newText = removeNotifyToml(text);
  } catch {
    return { configPath, removed: false };
  }
  if (newText === text) return { configPath, removed: false };
  writeFileAtomic(configPath, newText);
  return { configPath, removed: true };
}

export interface CodexNotifyStatus {
  configPath: string;
  configExists: boolean;
  /** 'wmux' = our bridge is registered; 'foreign' = a user notify occupies the
   *  slot; 'malformed' = config could not be parsed and was left untouched;
   *  'none' = no notify. */
  state: 'wmux' | 'foreign' | 'malformed' | 'none';
  /** Our script path when state === 'wmux'. */
  path: string | null;
}

/** Read-only snapshot of Codex notify registration. Never creates / throws. */
export function readCodexNotifyStatus(home: string): CodexNotifyStatus {
  const target = getMcpTarget('codex');
  const configPath = target ? target.configPath(home) : '';
  let configExists = false;
  try {
    configExists = fs.statSync(configPath).isFile();
  } catch {
    configExists = false;
  }
  if (!configExists) return { configPath, configExists, state: 'none', path: null };
  try {
    const parsed = parseConfig(fs.readFileSync(configPath, 'utf8'), 'toml');
    const slot = inspectNotifySlot(parsed);
    if (!slot.present) return { configPath, configExists, state: 'none', path: null };
    if (!slot.validStringArray || !isWmuxOwnedNotify(slot.notify)) {
      return { configPath, configExists, state: 'foreign', path: null };
    }
    return { configPath, configExists, state: 'wmux', path: slot.notify?.[1] ?? null };
  } catch {
    return { configPath, configExists, state: 'malformed', path: null };
  }
}
