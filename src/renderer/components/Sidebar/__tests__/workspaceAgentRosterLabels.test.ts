/**
 * Roster row labels. The rule under test is which of the three names a row
 * carries (surface title / vendor / pane coordinate) gets to lead, because
 * that is what makes a list of same-vendor sessions readable at a glance.
 */
import { describe, expect, it } from 'vitest';
import {
  rosterPrimaryLabel,
  rosterSecondaryLabel,
} from '../WorkspaceAgentRoster';
import type { WorkspaceAgentRosterRow } from '../../../stores/selectors/workspaceAgentRoster';

function row(overrides: Partial<WorkspaceAgentRosterRow> = {}): WorkspaceAgentRosterRow {
  return {
    workspaceId: 'ws-1',
    paneId: 'pane-1',
    surfaceId: 'sf-1',
    ptyId: 'pty-1',
    agentName: 'Claude Code',
    paneName: 'w2-127',
    surfaceIndex: 0,
    surfaceCount: 1,
    status: 'running',
    hasAttention: false,
    needsAttention: false,
    isFocused: false,
    ...overrides,
  };
}

describe('roster row labels', () => {
  it('leads with the surface title when there is one', () => {
    const r = row({ surfaceTitle: 'Zwroty' });
    expect(rosterPrimaryLabel(r)).toBe('Zwroty');
    // Vendor is not lost — it moves to the muted trailer, once.
    expect(rosterSecondaryLabel(r)).toBe('Claude Code · w2-127');
  });

  it('falls back to the vendor name when the surface has no title', () => {
    const r = row();
    expect(rosterPrimaryLabel(r)).toBe('Claude Code');
    // ...and then the vendor must NOT be repeated in the trailer.
    expect(rosterSecondaryLabel(r)).toBe('w2-127');
  });

  it('treats an empty title as titleless, so a row never loses both names', () => {
    // The row type allows ''. The trailer tests truthiness, so a `??` fallback
    // in the primary label left the row with no name at all: an empty lead and
    // a trailer that withheld the vendor as "already shown above".
    const r = row({ surfaceTitle: '' });
    expect(rosterPrimaryLabel(r)).toBe('Claude Code');
    expect(rosterSecondaryLabel(r)).toBe('w2-127');
  });

  it('keeps the tab position when the leaf holds several surfaces', () => {
    expect(rosterSecondaryLabel(row({ surfaceTitle: 'AI', surfaceIndex: 1, surfaceCount: 3 })))
      .toBe('Claude Code · w2-127 · #2/3');
    expect(rosterSecondaryLabel(row({ surfaceIndex: 1, surfaceCount: 3 })))
      .toBe('w2-127 · #2/3');
  });

  it('distinguishes same-vendor rows that used to render identically', () => {
    const rows = [
      row({ ptyId: 'pty-1', paneName: 'w2-127', surfaceTitle: 'Zwroty' }),
      row({ ptyId: 'pty-2', paneName: 'w2-123', surfaceTitle: 'AI' }),
      row({ ptyId: 'pty-3', paneName: 'w2-131', surfaceTitle: 'Scalar SINOTKEN' }),
    ];
    const primaries = rows.map(rosterPrimaryLabel);
    expect(new Set(primaries).size).toBe(rows.length);
  });
});
