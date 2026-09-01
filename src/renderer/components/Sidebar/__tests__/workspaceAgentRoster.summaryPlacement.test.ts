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
    // The list is mounted only while expanded — a collapsed list would still
    // subscribe to the whole roster projection to render nothing, and with
    // eleven collapsed workspaces that is eleven pointless subscriptions.
    expect(itemSource).toMatch(/rosterOpen && \(\s*<WorkspaceAgentRoster/);
  });

  it('the list renders no disclosure row of its own', () => {
    // The old row's two tells: a full-width toggle button carrying the count,
    // and the count label itself living in the list component.
    const listPart = rosterSource.slice(rosterSource.indexOf('function WorkspaceAgentRoster('));
    expect(listPart).not.toContain('aria-expanded');
    expect(listPart).not.toContain("t('workspace.agentCount'");
    expect(listPart).not.toContain("t('workspace.showAgents')");
  });

  it('the toggle says what it expands, now that its visible label is a number', () => {
    const summaryPart = rosterSource.slice(
      rosterSource.indexOf('function WorkspaceRosterSummary('),
      rosterSource.indexOf('export const WorkspaceRosterSummaryMemo'),
    );
    expect(summaryPart).toContain('aria-expanded');
    expect(summaryPart).toContain('aria-controls');
    // The list is no longer the button's next sibling — five controls sit
    // between them in DOM order — so the relationship has to be explicit.
    expect(rosterSource).toContain('id={rosterListId(workspaceId)}');
  });

  it('the chevron neither selects the workspace nor starts its drag', () => {
    const summaryPart = rosterSource.slice(
      rosterSource.indexOf('function WorkspaceRosterSummary('),
      rosterSource.indexOf('export const WorkspaceRosterSummaryMemo'),
    );
    // Click: the row underneath selects the workspace, so the toggle must
    // stop the gesture in its OWN onClick — not merely somewhere in the file.
    const onClick = summaryPart.slice(summaryPart.indexOf('onClick='), summaryPart.indexOf('onMouseDown='));
    expect(onClick).toContain('event.stopPropagation()');
    // Drag: the row is a native drag source. Two independent guards — the
    // marker the row's own handleDragStart tests for, and the mousedown
    // default that would otherwise arm a drag.
    expect(summaryPart).toContain('data-workspace-agent-roster');
    expect(itemSource).toContain('[data-workspace-agent-roster]');
    const onMouseDown = summaryPart.slice(summaryPart.indexOf('onMouseDown='));
    expect(onMouseDown).toContain('event.preventDefault()');
    // …and that preventDefault costs the button its focus unless it is given
    // back, which would leave the focus ring unreachable by mouse.
    expect(onMouseDown).toContain('event.currentTarget.focus()');
  });

  it('the summary subscribes on counts alone, not on every roster field', () => {
    // The projection's reference changes whenever any row field does — an
    // activity string, a focus flag. This control draws two integers, and it
    // now sits on a row that renders for every workspace.
    expect(rosterSource).toContain('createWorkspaceRosterCountsSelector(workspaceId)');
  });
});

// ─── The accessible name, asserted rather than grepped ───────────────────────

import { rosterSummaryAriaLabel } from '../WorkspaceAgentRoster';

/** Stands in for useT: renders the real en strings' shape without i18n setup. */
const t = ((key: string, vars?: Record<string, string | number>) => {
  switch (key) {
    case 'workspace.agentCount': return `Agents ${vars?.count}`;
    case 'roster.stashedCount': return `Stashed ${vars?.count}`;
    case 'roster.stashedOnly': return `Stashed ${vars?.count}`;
    case 'workspace.showAgents': return 'Show agent list';
    case 'workspace.hideAgents': return 'Hide agent list';
    default: return key;
  }
}) as Parameters<typeof rosterSummaryAriaLabel>[2];

describe('#997 — the summary chip is a number, its accessible name is not', () => {
  it('agents only: the count keeps its noun and the toggle its verb', () => {
    expect(rosterSummaryAriaLabel({ agentCount: 3, stashedCount: 0 }, false, t))
      .toBe('Agents 3, Show agent list');
  });

  it('expanded: the verb flips, so the control never lies about what it does', () => {
    expect(rosterSummaryAriaLabel({ agentCount: 3, stashedCount: 0 }, true, t))
      .toBe('Agents 3, Hide agent list');
  });

  it('agents and stash: both counts are announced, the chip only draws them', () => {
    expect(rosterSummaryAriaLabel({ agentCount: 2, stashedCount: 1 }, false, t))
      .toBe('Agents 2, Stashed 1, Show agent list');
  });

  it('stash only: leads with the stash, never "Agents 0"', () => {
    const label = rosterSummaryAriaLabel({ agentCount: 0, stashedCount: 1 }, false, t);
    expect(label).toBe('Stashed 1, Show agent list');
    expect(label).not.toContain('Agents 0');
  });
});
