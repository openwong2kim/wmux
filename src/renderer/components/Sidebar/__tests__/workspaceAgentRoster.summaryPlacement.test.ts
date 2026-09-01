/**
 * #997 item 2 — the roster summary belongs ON the workspace row, not on a line
 * of its own.
 *
 * The disclosure used to be its own row under every workspace that had any
 * agents: a chevron and "Agents 3", naming nothing, and — once expanded —
 * restating the count the rows immediately below it already showed. One line
 * per workspace, which is what stood between an eleven-workspace sidebar and
 * scrolling.
 *
 * Two things must hold for that saving to survive a refactor, and neither is a
 * value an assertion could read from a store: the summary must render inside
 * WorkspaceItem's row, and the list must no longer render a disclosure line of
 * its own. A source scan, in the same house style as the stash-pulse guard next
 * to it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rosterSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Sidebar/WorkspaceAgentRoster.tsx'),
  'utf8',
);
const itemSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/components/Sidebar/WorkspaceItem.tsx'),
  'utf8',
);

describe('#997 — roster summary sits on the workspace row', () => {
  it('WorkspaceItem renders the summary control and owns the expanded state', () => {
    expect(itemSource).toContain('WorkspaceRosterSummaryMemo');
    expect(itemSource).toContain('const [rosterOpen, setRosterOpen]');
    // The list is a sibling BELOW the row and must be told the state rather
    // than keeping its own copy, or the chevron and the list could disagree.
    expect(itemSource).toMatch(/<WorkspaceAgentRoster[\s\S]*?open=\{rosterOpen\}/);
  });

  it('the list renders no disclosure row of its own', () => {
    // The old row's two tells: a full-width toggle button carrying the count,
    // and the count label itself living in the list component.
    const listPart = rosterSource.slice(rosterSource.indexOf('function WorkspaceAgentRoster('));
    expect(listPart).not.toContain('aria-expanded');
    expect(listPart).not.toContain("t('workspace.agentCount'");
    expect(listPart).not.toContain("t('workspace.showAgents')");
  });

  it('the summary keeps the full wording in its accessible name', () => {
    const summaryPart = rosterSource.slice(
      rosterSource.indexOf('function WorkspaceRosterSummary('),
      rosterSource.indexOf('function WorkspaceAgentRoster('),
    );
    // The visible chip is a bare number; a screen reader must still hear
    // "Agents 3, Show agent list" rather than "3".
    expect(summaryPart).toContain("t('workspace.agentCount'");
    expect(summaryPart).toContain("t('workspace.showAgents')");
    expect(summaryPart).toContain("t('workspace.hideAgents')");
    expect(summaryPart).toContain('aria-expanded');
    // A workspace holding only stashed panes must not read "Agents 0".
    expect(summaryPart).toContain("t('roster.stashedOnly'");
  });

  it('the summary does not restate needs-you, which the row dot already carries', () => {
    const summaryPart = rosterSource.slice(
      rosterSource.indexOf('function WorkspaceRosterSummary('),
      rosterSource.indexOf('function WorkspaceAgentRoster('),
    );
    // WorkspaceItem's leading dot is selectWorkspaceAgentStatus — the
    // most-urgent status rolled up across the whole workspace — so it is
    // already red whenever an agent here awaits input. A count beside it would
    // render the same signal twice and spend the row's scarcest space.
    expect(summaryPart).not.toContain('needsAttentionCount');
    expect(itemSource).toContain('selectWorkspaceAgentStatus');
  });

  it('the summary stops the gesture reaching the row underneath it', () => {
    const summaryPart = rosterSource.slice(
      rosterSource.indexOf('function WorkspaceRosterSummary('),
      rosterSource.indexOf('function WorkspaceAgentRoster('),
    );
    // The row selects the workspace on click and is a native drag source;
    // without both guards the chevron would switch workspaces, or start a
    // drag instead of arming the click.
    expect(summaryPart).toContain('event.stopPropagation()');
    expect(summaryPart).toContain('onMouseDown');
    expect(summaryPart).toContain('onDragStart');
  });
});
