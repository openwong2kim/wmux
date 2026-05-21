import { describe, it, expect } from 'vitest';
import type { Surface, PaneLeaf, PaneBranch, Workspace } from '../../../shared/types';
import {
  buildExportPayload,
  buildPaneMarkdown,
  buildWorkspaceMarkdown,
  WMUX_EXPORT_MIME,
  WMUX_REORDER_MIME,
} from '../sessionInfoMarkdown';

function makeTerminalSurface(id: string, ptyId: string, cwd = ''): Surface {
  return { id, ptyId, title: 'Terminal', shell: 'bash', cwd };
}

function makeBrowserSurface(id: string, url: string): Surface {
  return {
    id,
    ptyId: '',
    title: 'Browser',
    shell: '',
    cwd: '',
    surfaceType: 'browser',
    browserUrl: url,
  };
}

function makeWorkspace(): Workspace {
  const srf1 = makeTerminalSurface('srf-1', 'pty-1');
  const srf2 = makeBrowserSurface('srf-2', 'https://example.com');
  const leaf1: PaneLeaf = {
    id: 'pane-1',
    type: 'leaf',
    surfaces: [srf1],
    activeSurfaceId: 'srf-1',
  };
  const leaf2: PaneLeaf = {
    id: 'pane-2',
    type: 'leaf',
    surfaces: [srf2],
    activeSurfaceId: 'srf-2',
  };
  const branch: PaneBranch = {
    id: 'branch-1',
    type: 'branch',
    direction: 'vertical',
    children: [leaf1, leaf2],
    sizes: [50, 50],
  };
  return {
    id: 'ws-1',
    name: 'My WS',
    rootPane: branch,
    activePaneId: 'pane-1',
    metadata: { cwd: '/home/user', gitBranch: 'main' },
  };
}

describe('sessionInfoMarkdown', () => {
  // ─── Workspace export ─────────────────────────────────────────────────
  // Regression lock: the markdown body MUST match what Sidebar.handleCopy
  // SessionInfo wrote to the clipboard before the util was extracted.
  // Anyone changing the format must update this fixture deliberately so
  // existing LLM consumers that key off these header strings keep working.
  it('buildWorkspaceMarkdown matches the legacy clipboard fixture byte-for-byte', () => {
    const ws = makeWorkspace();
    const expected = [
      '# wmux Workspace: "My WS"',
      '- Workspace ID: ws-1',
      '',
      '## Panes',
      '1. [ACTIVE] Terminal — bash',
      '   - Surface ID: srf-1',
      '   - PTY ID: pty-1',
      '   - CWD: /home/user',
      '   - Git: main',
      '',
      '2. Browser',
      '   - Surface ID: srf-2',
      '   - URL: https://example.com',
      '',
      '## MCP Control',
      '- Send command: terminal_send({ text: "..." })',
      '- Target specific terminal: terminal_send({ text: "...", ptyId: "<pty-id>" })',
      '- Navigate browser: browser_navigate({ url: "...", surfaceId: "<surface-id>" })',
      '- List all surfaces: surface_list()',
    ].join('\n');

    expect(buildWorkspaceMarkdown(ws)).toBe(expected);
  });

  it('buildWorkspaceMarkdown falls back to surface.cwd when workspace metadata has no cwd', () => {
    const ws = makeWorkspace();
    ws.metadata = undefined;
    ws.rootPane = {
      ...(ws.rootPane as PaneBranch).children[0] as PaneLeaf,
      surfaces: [makeTerminalSurface('srf-1', 'pty-1', '/tmp/from-surface')],
    } as PaneLeaf;
    ws.activePaneId = 'pane-1';

    const md = buildWorkspaceMarkdown(ws);
    expect(md).toContain('   - CWD: /tmp/from-surface');
    // Git line should be absent when neither metadata nor surface has it.
    expect(md).not.toContain('   - Git:');
  });

  // ─── Pane export ──────────────────────────────────────────────────────
  // Pane-scoped markdown only includes the targeted leaf's surfaces and
  // carries the pane id so the consuming LLM can resolve it via MCP.
  it('buildPaneMarkdown scopes to a single leaf and labels the active tag correctly', () => {
    const ws = makeWorkspace();
    const md = buildPaneMarkdown(ws, 'pane-1');

    expect(md).toContain('# wmux Pane in "My WS"');
    expect(md).toContain('- Workspace ID: ws-1');
    expect(md).toContain('- Pane ID: pane-1');
    expect(md).toContain('## Surfaces');
    expect(md).toContain('1. [ACTIVE] Terminal — bash');
    expect(md).toContain('   - Surface ID: srf-1');
    // Browser surface from the sibling pane must not appear.
    expect(md).not.toContain('Surface ID: srf-2');
    expect(md).not.toContain('Browser');
  });

  it('buildPaneMarkdown drops the [ACTIVE] tag for inactive panes', () => {
    const ws = makeWorkspace();
    const md = buildPaneMarkdown(ws, 'pane-2');
    expect(md).toContain('1. Browser');
    expect(md).not.toContain('[ACTIVE] Browser');
  });

  it('buildPaneMarkdown handles an unknown pane id gracefully', () => {
    const ws = makeWorkspace();
    const md = buildPaneMarkdown(ws, 'does-not-exist');
    expect(md).toContain('(pane not found)');
    expect(md).toContain('## MCP Control');
  });

  // ─── Export payload (JSON for future internal drop targets) ───────────
  it('buildExportPayload returns workspace kind with all surface ids when paneId omitted', () => {
    const ws = makeWorkspace();
    const payload = buildExportPayload(ws);
    expect(payload).toEqual({
      kind: 'workspace',
      workspaceId: 'ws-1',
      surfaceIds: ['srf-1', 'srf-2'],
    });
  });

  it('buildExportPayload returns pane kind with only the leaf surface ids', () => {
    const ws = makeWorkspace();
    const payload = buildExportPayload(ws, 'pane-2');
    expect(payload).toEqual({
      kind: 'pane',
      workspaceId: 'ws-1',
      paneId: 'pane-2',
      surfaceIds: ['srf-2'],
    });
  });

  it('buildExportPayload returns empty surfaceIds for an unknown paneId rather than throwing', () => {
    const ws = makeWorkspace();
    const payload = buildExportPayload(ws, 'missing');
    expect(payload.kind).toBe('pane');
    expect(payload.surfaceIds).toEqual([]);
  });

  // ─── MIME constants ───────────────────────────────────────────────────
  // Locked because external consumers / future internal drop targets key
  // off these exact strings.
  it('exposes stable MIME constants', () => {
    // text/* prefix is intentional — see sessionInfoMarkdown.ts. application/*
    // prefixes broke external drops into Claude Desktop because that composer
    // treats them as attachment mime types.
    expect(WMUX_EXPORT_MIME).toBe('text/x-wmux-export+json');
    expect(WMUX_REORDER_MIME).toBe('text/x-wmux-reorder');
  });
});
