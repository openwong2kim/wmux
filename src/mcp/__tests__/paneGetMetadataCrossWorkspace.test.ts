import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * #1018 — pane_get_metadata was hard-scoped to the caller's own workspace
 * (always forced `requireWorkspaceId()`), so another agent could not read a
 * DIFFERENT workspace's pane metadata even read-only, and had no way to tell
 * panes apart before addressing one. pane.rpc's resolveTarget already accepts
 * any workspaceId (it only checks paneId belongs to it) — the MCP tool
 * wrapper was the only thing forcing it to the caller's own id. This locks
 * the fix as read-only and additive: pane_set_metadata gets no such override.
 */
describe('pane_get_metadata — cross-workspace read (#1018)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  function region(start: string, end: string): string {
    const m = src.match(new RegExp(`${start}[\\s\\S]*?${end}`));
    if (!m) throw new Error(`region ${start} → ${end} not found in mcp/index.ts`);
    return m[0];
  }

  it('PANE_GET_METADATA_SHAPE accepts an optional workspaceId override', () => {
    const shape = region('const PANE_GET_METADATA_SHAPE = \\{', '\\};');
    expect(shape).toMatch(/workspaceId: z\.string\(\)\.optional\(\)/);
    expect(shape).toMatch(/paneId: z\.string\(\)\.optional\(\)/);
  });

  it('pane_get_metadata prefers the explicit workspaceId over the caller\'s own', () => {
    const block = region("'pane_get_metadata',", "callRpc\\('pane\\.getMetadata', params\\);");
    expect(block).toMatch(/const workspaceId = targetWorkspaceId \|\| \(await requireWorkspaceId\(\)\)/);
  });

  it('pane_set_metadata keeps no such override — write path stays own-workspace-only', () => {
    const block = region("'pane_set_metadata',", "callRpc\\('pane\\.setMetadata', params\\);");
    expect(block).toMatch(/const workspaceId = await requireWorkspaceId\(\);/);
    expect(block).not.toMatch(/targetWorkspaceId/);
  });
});
