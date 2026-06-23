// ─── Regression guard: Sidebar must consume sidebarMode → render CompanyPanel ─
//
// Bug: the palette's "Company: …" commands set `sidebarMode = 'company'`, but
// NOTHING in the renderer read `sidebarMode` to swap the sidebar content — the
// `CompanyPanel` component was never rendered (orphaned). So company commands
// mutated state with no visible effect ("보이는데 눌러도 무반응").
//
// The store-connected <Sidebar /> can't be behavior-tested in this repo's
// node-env harness (renderToStaticMarkup doesn't run effects, and the store
// can't be seeded reliably without a mount — the same reason AppLayout/Sidebar
// have no render fixtures). So this is a SOURCE-SCAN lockstep guard (the same
// pattern as firstParty.test.ts scanning src/mcp): it pins the wiring in source
// so the consumer can't silently regress to orphaned again.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest runs from the repo root — resolve sources from cwd (avoids
// import.meta, which tsconfig's module target rejects).
const SIDEBAR_DIR = resolve(process.cwd(), 'src/renderer/components/Sidebar');
const sidebarSrc = readFileSync(resolve(SIDEBAR_DIR, 'Sidebar.tsx'), 'utf8');
const companyPanelSrc = readFileSync(resolve(SIDEBAR_DIR, 'CompanyPanel.tsx'), 'utf8');

describe('Sidebar — company mode wiring (regression guard)', () => {
  it('imports CompanyPanel', () => {
    expect(sidebarSrc).toMatch(/import\s+CompanyPanel\s+from\s+['"]\.\/CompanyPanel['"]/);
  });

  it('reads sidebarMode from the store', () => {
    expect(sidebarSrc).toMatch(/useStore\(\(s\)\s*=>\s*s\.sidebarMode\)/);
  });

  it("renders <CompanyPanel /> gated on sidebarMode === 'company'", () => {
    // The conditional must reference company mode AND mount CompanyPanel.
    expect(sidebarSrc).toContain("sidebarMode === 'company'");
    expect(sidebarSrc).toMatch(/<CompanyPanel\s*\/>/);
  });

  it('provides a UI affordance to toggle modes (entry + exit)', () => {
    // Without a toggle the only entry was the palette and there was no exit.
    expect(sidebarSrc).toContain('data-company-toggle');
    expect(sidebarSrc).toMatch(/setSidebarMode\(\s*sidebarMode === 'company'\s*\?\s*'workspaces'\s*:\s*'company'\s*\)/);
  });

  it('CompanyPanel still exposes its no-company empty state (the surface that was invisible)', () => {
    expect(companyPanelSrc).toContain('No company created yet');
  });
});
