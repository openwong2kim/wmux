// ─── Wiring guard: both sidebar surfaces order through attentionOrder ────────
//
// The behavior itself is covered by attentionOrder.test.ts (pure). What can
// regress silently is the WIRING: mapping over the raw list again, or letting
// the display position leak into the Ctrl+N label / reorder payload, which
// would renumber the shortcuts the moment a row got pinned. The store-connected
// <Sidebar /> can't be mounted in this repo's node-env harness (see
// Sidebar.companyMode.test.tsx for why), so this is a source-scan lockstep
// guard in the same style.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolved from this file, not process.cwd(): a run whose cwd is a sibling
// checkout would otherwise scan the WRONG copy of the sources and pass or fail
// for reasons that have nothing to do with the tree under test.
const SIDEBAR_DIR = resolve(__dirname, '..');
const sidebarSrc = readFileSync(resolve(SIDEBAR_DIR, 'Sidebar.tsx'), 'utf8');
const miniSrc = readFileSync(resolve(SIDEBAR_DIR, 'MiniSidebar.tsx'), 'utf8');
const itemSrc = readFileSync(resolve(SIDEBAR_DIR, 'WorkspaceItem.tsx'), 'utf8');

describe('Sidebar — needs-you-first ordering wiring', () => {
  it('imports and applies orderByAttention', () => {
    expect(sidebarSrc).toMatch(/import\s+\{\s*orderByAttention\s*\}\s+from\s+['"]\.\/attentionOrder['"]/);
    expect(sidebarSrc).toContain('orderByAttention(');
  });

  it('reads the opt-in setting from the store', () => {
    expect(sidebarSrc).toMatch(/useStore\(\(s\)\s*=>\s*s\.sidebarAttentionFirst\)/);
  });

  it('renders the ordered list, not the filtered one', () => {
    expect(sidebarSrc).toContain('orderedWorkspaces.map(');
    expect(sidebarSrc).not.toContain('filteredWorkspaces.map(');
  });

  it('still hands WorkspaceItem the UNFILTERED index', () => {
    // Ctrl+N labels and reorder are defined against `workspaces`; the display
    // order must never become the index.
    expect(sidebarSrc).toContain('index={workspaces.indexOf(ws)}');
  });
});

describe('MiniSidebar — needs-you-first ordering wiring', () => {
  it('imports and applies orderByAttention', () => {
    expect(miniSrc).toMatch(/import\s+\{\s*orderByAttention\s*\}\s+from\s+['"]\.\/attentionOrder['"]/);
    expect(miniSrc).toContain('orderByAttention(');
  });

  it('renders the ordered rail', () => {
    expect(miniSrc).toContain('orderedWorkspaces.map(');
    expect(miniSrc).not.toMatch(/\{workspaces\.map\(/);
  });

  it('labels and tooltips the rail with the unfiltered position', () => {
    expect(miniSrc).toContain('const railIndex = workspaces.indexOf(ws);');
    expect(miniSrc).toContain('${railIndex + 1}');
    expect(miniSrc).not.toContain('${i + 1}');
  });

  it('sends the unfiltered position as the reorder payload', () => {
    expect(miniSrc).toContain("e.dataTransfer.setData('text/plain', String(railIndex));");
    expect(miniSrc).not.toMatch(/fromIndex\s*===?\s*i\b/);
  });

  it('mirrors the error cross instead of a second red dot', () => {
    expect(miniSrc).toContain("agentIcon.shape === 'cross'");
  });
});

describe('drag reorder is paused while the ordering is on', () => {
  // A drop is judged against the DISPLAY order while the index it reorders is
  // the array position, so with rows pinned the indicator and the result
  // disagree. Both surfaces gate `draggable` on the setting rather than each
  // shipping its own translation between the two orders.
  it('gates draggable on the setting, on both surfaces', () => {
    expect(itemSrc).toContain('draggable={!sidebarAttentionFirst}');
    expect(miniSrc).toContain('draggable={!sidebarAttentionFirst}');
  });
});
