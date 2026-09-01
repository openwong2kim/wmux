// Multi-target MCP registration registry.
//
// wmux registers its MCP server (`wmux`) into the config files of the AI-agent
// CLIs installed on the machine so each can discover the wmux MCP
// tools. Historically this was Claude-only (`~/.claude.json`). This table
// generalizes the set of supported targets; `McpRegistrar` (main process) and
// the `wmux mcp` CLI both iterate it through the shared `configIO` adapters so
// the two registration code paths stay in lock-step.
//
// EMPIRICAL GATE (see McpRegistrar.ts header): a target is only shipped as
// `verified` after its CLI was confirmed to (a) discover the wmux MCP server in
// the written config and (b) actually USE the tools (pass the daemon permission
// enforcer + resolve a workspace identity). Codex was verified 2026-06-15
// (clientName `codex-mcp-client`, added to FIRST_PARTY_CLIENT_NAMES). Gemini CLI
// is not installed here, so it stays unverified and is never created.

import * as path from 'path';
import { dataSuffix } from './constants';

export type McpConfigFormat = 'json' | 'toml';

/**
 * #1151 — why external agent-config registration is being skipped, or null to
 * proceed. Every target in this table lives at a suffix-BLIND path
 * (`~/.claude.json`, `~/.codex/config.toml`, …), so an isolated instance
 * (WMUX_DATA_SUFFIX set — dev's automatic "-dev" included) writing them
 * retargets the user's production agents at this instance's bundle.
 * WMUX_MCP_REGISTER_EXTERNAL=1 opts back in for dogfood runs that
 * deliberately claim the slot. The two callers deliberately DIVERGE on what
 * they do with it: `McpRegistrar` (daemon boot, Settings — implicit actions)
 * skips; the `wmux mcp` CLI (an explicit user action) warns and proceeds.
 */
export function externalRegistrationSkipReason(): string | null {
  const suffix = dataSuffix();
  if (suffix === '') return null;
  if (process.env.WMUX_MCP_REGISTER_EXTERNAL === '1') return null;
  return `WMUX_DATA_SUFFIX=${suffix} — skipping external agent config registration ` +
    '(production ~/.claude.json et al. stay untouched; set WMUX_MCP_REGISTER_EXTERNAL=1 to override)';
}

export interface McpTarget {
  /** Stable id used in status payloads, CLI `--target`, and UI keys. */
  id: 'claude' | 'codex' | 'gemini';
  /** Human label for Settings / CLI output. */
  displayName: string;
  /** Config file syntax. Drives which `configIO` adapter is used. */
  format: McpConfigFormat;
  /** Absolute config path for a given home directory. */
  configPath: (home: string) => string;
  /**
   * When false, wmux NEVER creates this target's config file — it only writes
   * if the file already exists. Claude owns `~/.claude.json` so it is created
   * on demand; Codex/Gemini configs belong to those tools and are only touched
   * when the user has them installed (their CLI created the file).
   */
  createIfMissing: boolean;
  /**
   * Whether wmux's integration with this agent is empirically verified to work
   * end-to-end. Unverified targets are surfaced as "experimental / not
   * detected" and never created speculatively.
   */
  verified: boolean;
}

// The MCP server key wmux owns in every target config. (A formerly-paired
// `wmux-a2a` server was removed as dead code: no a2a bundle was ever built or
// packaged, so it never registered — the A2A tools live in the main `wmux`
// server.) Kept as an array so unregister can sweep any historical strays.
export const WMUX_SERVER_KEY = 'wmux';
export const WMUX_SERVER_KEYS: readonly string[] = [WMUX_SERVER_KEY];

export const MCP_TARGETS: readonly McpTarget[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    format: 'json',
    configPath: (home) => path.join(home, '.claude.json'),
    createIfMissing: true,
    verified: true,
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    format: 'toml',
    configPath: (home) => path.join(home, '.codex', 'config.toml'),
    createIfMissing: false,
    verified: true,
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    format: 'json',
    configPath: (home) => path.join(home, '.gemini', 'settings.json'),
    createIfMissing: false,
    verified: false,
  },
];

/** Look up a target by id. */
export function getMcpTarget(id: string): McpTarget | undefined {
  return MCP_TARGETS.find((t) => t.id === id);
}
