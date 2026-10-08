import type { Pane, PaneLeaf, Workspace } from '../../shared/types';
import { getLeafPanes } from '../../shared/paneUtils';
import type { AgentSlug } from '../../shared/events';
import { surfaceForegroundProgram, type SurfaceAgentNames, type SurfaceProgramLiveness } from './surfaceProgram';
import { paneNameFields } from './paneNaming';

// MIME types for drag-and-drop payloads.
// External AI chats (Claude Desktop, ChatGPT, Cursor) read text/plain.
// Future internal drop targets inside wmux can parse the JSON variant.
// Both use the `text/*` prefix on purpose: `application/*` prefixes flip
// Claude Desktop (and likely other chat composers) into attachment-drop
// mode, which silently rejects the actual text payload. `text/x-*` is
// a vendor-specific text MIME and behaves like any other text/* type.
export const WMUX_EXPORT_MIME = 'text/x-wmux-export+json';
export const WMUX_REORDER_MIME = 'text/x-wmux-reorder';

export interface WmuxExportPayload {
  kind: 'workspace' | 'pane';
  workspaceId: string;
  paneId?: string;
  surfaceIds: string[];
}

// Collect every leaf pane in a tree, depth-first, preserving on-screen order.
// Alias for the canonical `getLeafPanes`; the name is kept because SurfaceTabs /
// drag handlers import it from here.
export const collectLeaves = getLeafPanes;

function findLeaf(pane: Pane, paneId: string): PaneLeaf | null {
  if (pane.type === 'leaf') return pane.id === paneId ? pane : null;
  for (const child of pane.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

const MCP_CONTROL_LINES = [
  '## MCP Control',
  '- Send command: terminal_send({ text: "..." })',
  '- Target specific terminal: terminal_send({ text: "...", ptyId: "<pty-id>" })',
  '- Navigate browser: browser_navigate({ url: "...", surfaceId: "<surface-id>" })',
  '- List all surfaces: surface_list()',
];

type MarkdownSurfaceAgents = SurfaceAgentNames & Readonly<Record<string, { slug?: AgentSlug } | undefined>>;

/** Pane-chosen text on one line: a legacy label could still carry a newline,
 *  which would otherwise forge a line of this markdown. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

/** `- Pane tag: #w1-2`, plus `- Pane name: …` when the user labelled the pane.
 *  The tag is what an agent passes to wmux tools in place of the ids. A pane
 *  with no ordinals yet (a hand-built fixture, never a live pane) has no tag
 *  worth printing — `#w0-0` would resolve to nothing. */
function paneNameLines(
  ws: Workspace,
  leaf: PaneLeaf,
  surfaceAgent: MarkdownSurfaceAgents,
  paneLabel: Record<string, string> | undefined,
  indent: string,
): string[] {
  const { paneName, paneTag } = paneNameFields(paneLabel, surfaceAgent as Record<string, { slug?: AgentSlug }>, ws, leaf);
  const label = paneLabel?.[leaf.id] ?? leaf.metadata?.label;
  const lines: string[] = [];
  if (typeof ws.wsOrdinal === 'number' && typeof leaf.ordinal === 'number') lines.push(`${indent}- Pane tag: ${paneTag}`);
  if (label && label.trim()) lines.push(`${indent}- Pane name: ${oneLine(paneName)}`);
  return lines;
}

function renderSurfaceLines(
  leaf: PaneLeaf,
  paneIndex: number,
  isActive: boolean,
  meta: Workspace['metadata'],
  out: string[],
  surfaceAgent: SurfaceAgentNames,
  liveness: SurfaceProgramLiveness,
  // Pane-level lines (the pane tag) repeated under each of its surfaces, so the
  // numbered list keeps its legacy shape.
  paneLines: readonly string[] = [],
): number {
  let idx = paneIndex;
  for (const s of leaf.surfaces) {
    const surfaceType = s.surfaceType || 'terminal';
    const activeTag = isActive ? '[ACTIVE] ' : '';

    if (surfaceType === 'browser') {
      out.push(`${idx}. ${activeTag}Browser`);
      out.push(...paneLines);
      out.push(`   - Surface ID: ${s.id}`);
      if (s.browserUrl) out.push(`   - URL: ${s.browserUrl}`);
    } else if (surfaceType === 'diff') {
      // J2 — diff 서피스는 PTY 없음. taskId만 표시(PTY ID 오표기 방지).
      out.push(`${idx}. ${activeTag}Diff`);
      out.push(...paneLines);
      out.push(`   - Surface ID: ${s.id}`);
      if (s.diffTaskId) out.push(`   - Task ID: ${s.diffTaskId}`);
    } else if (surfaceType === 'remote-terminal') {
      // Same reason the diff branch exists, plus one more. A remote surface
      // has no local PTY (`ptyId` is ''), so the shared branch printed an
      // empty "PTY ID:" line; and its cwd is a real path on ANOTHER machine,
      // so pasting this into an agent's prompt handed it a directory that
      // does not exist here, labelled exactly like one that does.
      // No `— ${shell}` on the heading: nothing populates a remote surface's
      // shell. `addRemoteSurface` is called from exactly one place and passes
      // undefined for it, and only the title is updated afterwards, so the
      // usual fallback rendered a permanent "— unknown". The OSC title the
      // remote shell reports is the one live description, so it goes on its
      // own line where it is not pretending to be a shell name.
      out.push(`${idx}. ${activeTag}Remote terminal`);
      out.push(...paneLines);
      out.push(`   - Surface ID: ${s.id}`);
      if (s.remoteHostId) out.push(`   - Host ID: ${s.remoteHostId}`);
      if (s.remoteSessionId) out.push(`   - Remote session: ${s.remoteSessionId}`);
      if (s.title) out.push(`   - Title: ${s.title}`);
      // Guarded, and labelled as remote when it does arrive: `meta.cwd` is
      // this desktop's probe of a LOCAL pane and must never stand in for the
      // other machine's directory.
      if (s.cwd) out.push(`   - CWD (remote): ${s.cwd}`);
    } else {
      out.push(`${idx}. ${activeTag}Terminal — ${surfaceForegroundProgram(s, surfaceAgent, liveness) || s.shell || 'unknown'}`);
      out.push(...paneLines);
      out.push(`   - Surface ID: ${s.id}`);
      out.push(`   - PTY ID: ${s.ptyId}`);
      const cwd = meta?.cwd || s.cwd;
      if (cwd) out.push(`   - CWD: ${cwd}`);
      if (meta?.gitBranch) out.push(`   - Git: ${meta.gitBranch}`);
    }
    out.push('');
    idx++;
  }
  return idx;
}

// Workspace-scoped markdown. Plain shells keep the legacy clipboard format.
export function buildWorkspaceMarkdown(
  ws: Workspace,
  surfaceAgent: MarkdownSurfaceAgents = {},
  liveness: SurfaceProgramLiveness = {},
  paneLabel?: Record<string, string>,
): string {
  const leaves = collectLeaves(ws.rootPane);
  const meta = ws.metadata;

  const lines: string[] = [
    `# wmux Workspace: "${ws.name}"`,
    `- Workspace ID: ${ws.id}`,
    '',
    '## Panes',
  ];

  let paneIndex = 1;
  for (const leaf of leaves) {
    const isActive = leaf.id === ws.activePaneId;
    const paneLines = paneNameLines(ws, leaf, surfaceAgent, paneLabel, '   ');
    paneIndex = renderSurfaceLines(leaf, paneIndex, isActive, meta, lines, surfaceAgent, liveness, paneLines);
  }

  lines.push(...MCP_CONTROL_LINES);

  return lines.join('\n');
}

// Pane-scoped markdown. Same body shape as workspace export, narrowed to a
// single leaf so an external LLM can reason about one terminal/browser
// without the noise of sibling panes.
export function buildPaneMarkdown(
  ws: Workspace,
  paneId: string,
  surfaceAgent: MarkdownSurfaceAgents = {},
  liveness: SurfaceProgramLiveness = {},
  paneLabel?: Record<string, string>,
): string {
  const leaf = findLeaf(ws.rootPane, paneId);
  const meta = ws.metadata;

  const lines: string[] = [
    `# wmux Pane in "${ws.name}"`,
    ...(leaf ? paneNameLines(ws, leaf, surfaceAgent, paneLabel, '') : []),
    `- Workspace ID: ${ws.id}`,
    `- Pane ID: ${paneId}`,
    '',
    '## Surfaces',
  ];

  if (leaf) {
    const isActive = leaf.id === ws.activePaneId;
    renderSurfaceLines(leaf, 1, isActive, meta, lines, surfaceAgent, liveness);
  } else {
    lines.push('(pane not found)');
    lines.push('');
  }

  lines.push(...MCP_CONTROL_LINES);

  return lines.join('\n');
}

export function buildExportPayload(
  ws: Workspace,
  paneId?: string,
): WmuxExportPayload {
  if (paneId) {
    const leaf = findLeaf(ws.rootPane, paneId);
    return {
      kind: 'pane',
      workspaceId: ws.id,
      paneId,
      surfaceIds: leaf ? leaf.surfaces.map((s) => s.id) : [],
    };
  }
  const surfaceIds = collectLeaves(ws.rootPane).flatMap((l) =>
    l.surfaces.map((s) => s.id),
  );
  return { kind: 'workspace', workspaceId: ws.id, surfaceIds };
}
