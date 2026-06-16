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
  type McpTarget,
  type McpConfigFormat,
} from './mcpTargets';
import {
  parseConfig,
  getMcpServerEntry,
  getMcpServerScript,
  isWmuxOwnedEntry,
  upsertMcpServer,
  removeMcpServers,
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
 */
export function registerTarget(
  target: McpTarget,
  home: string,
  wmuxScript: string,
  ownedKeys?: Set<string>,
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
      } else if (existing.args[0] === wmuxScript) {
        ownedKeys?.add(WMUX_SERVER_KEY); // already up to date
        skip = true;
      }
      // else: ours but stale path → update below
    }
    if (!skip) {
      // upsert validates its INPUT and OUTPUT, so an inline-table entry the
      // line-based editor can't target (which would duplicate) throws here.
      newText = upsertMcpServer(newText, target.format, WMUX_SERVER_KEY, wmuxScript);
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
