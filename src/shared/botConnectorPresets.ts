// ─── Connection presets — data only, each checked against its vendor ───────
//
// A preset fills the connection dialog; the owner still reviews and saves it,
// and main validates it like any other connection. Only servers whose setup
// was checked against the vendor's own documentation ship here (checked
// 2026-10-15); anything else is a Custom connection. Every preset blocks its
// server's write tools, so a worker can read with it but not act.
//
// GitHub: the remote server at api.githubcopilot.com, signed in with a
// personal access token as a Bearer header. The `/readonly` path and the
// `X-MCP-Readonly` header each restrict it to read tools (github/
// github-mcp-server docs/remote-server.md); the write tools of its default
// toolsets are blocked as well.
// Filesystem: @modelcontextprotocol/server-filesystem, pinned (an unpinned
// `npx -y` would run whatever version is newest at each launch). Its tool
// names were read from the pinned package itself.

import type { ConnectorDraft, ConnectorPresetId } from './botConnector';

export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/readonly';

/** GitHub's write tools in its default toolsets (issues, pull requests,
 *  repositories, labels, custom properties). */
export const GITHUB_WRITE_TOOLS: readonly string[] = [
  'add_issue_comment', 'issue_write', 'sub_issue_write', 'update_issue_comment', 'label_write',
  'add_comment_to_pending_review', 'add_reply_to_pull_request_comment', 'create_pull_request', 'merge_pull_request',
  'pull_request_review_write', 'update_pull_request', 'update_pull_request_branch',
  'create_branch', 'create_or_update_file', 'create_repository', 'delete_file', 'delete_repository', 'fork_repository', 'push_files',
  'custom_properties_write',
];

export const FILESYSTEM_MCP_PACKAGE = '@modelcontextprotocol/server-filesystem@2026.8.31';

/** The filesystem server's tools that change files. */
export const FILESYSTEM_WRITE_TOOLS: readonly string[] = ['create_directory', 'edit_file', 'move_file', 'write_file'];

export interface ConnectorPreset {
  id: ConnectorPresetId;
  /** i18n key of the chip label. */
  labelKey: string;
  /** i18n key of the dialog's hint for this preset. */
  hintKey: string;
  draft: ConnectorDraft;
}

export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [
  {
    id: 'github',
    labelKey: 'settings.factory.connections.preset.github',
    hintKey: 'settings.factory.connections.preset.githubHint',
    draft: {
      name: 'github',
      preset: 'github',
      transport: 'http',
      remote: { url: GITHUB_MCP_URL, headers: { 'X-MCP-Readonly': 'true' } },
      secrets: [{ secret: 'GITHUB_MCP_TOKEN', as: 'header', header: 'Authorization', scheme: 'bearer' }],
      tools: { mode: 'all', blocked: [...GITHUB_WRITE_TOOLS] },
      scope: { kind: 'all' },
      enabled: true,
    },
  },
  {
    id: 'filesystem',
    labelKey: 'settings.factory.connections.preset.filesystem',
    hintKey: 'settings.factory.connections.preset.filesystemHint',
    draft: {
      name: 'files',
      preset: 'filesystem',
      transport: 'stdio',
      // The last argument is the folder it may read; the owner sets it.
      stdio: { command: 'npx', args: ['-y', FILESYSTEM_MCP_PACKAGE], env: {} },
      secrets: [],
      tools: { mode: 'all', blocked: [...FILESYSTEM_WRITE_TOOLS] },
      scope: { kind: 'all' },
      enabled: true,
    },
  },
];

/** A Custom connection's starting point: only the tools the owner lists. */
export function customConnectorDraft(): ConnectorDraft {
  return {
    name: '',
    transport: 'stdio',
    stdio: { command: '', args: [], env: {} },
    secrets: [],
    tools: { mode: 'listed', allowed: [] },
    scope: { kind: 'all' },
    enabled: true,
  };
}
