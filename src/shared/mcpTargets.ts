// Multi-target MCP registration registry.
//
// wmux registers its MCP servers (`wmux`, `wmux-a2a`) into the config files of
// the AI-agent CLIs installed on the machine so each can discover the wmux MCP
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

export type McpConfigFormat = 'json' | 'toml';

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

// The two MCP server keys wmux owns in every target config.
export const WMUX_SERVER_KEY = 'wmux';
export const WMUX_A2A_SERVER_KEY = 'wmux-a2a';
export const WMUX_SERVER_KEYS: readonly string[] = [WMUX_SERVER_KEY, WMUX_A2A_SERVER_KEY];

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
