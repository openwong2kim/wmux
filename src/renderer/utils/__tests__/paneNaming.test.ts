import { describe, it, expect } from 'vitest';
import { computePaneAutoName, paneDisplayName, paneNameFields } from '../paneNaming';

describe('computePaneAutoName', () => {
  it('includes the agent slug suffix when an agent is detected', () => {
    expect(computePaneAutoName(1, 2, 'claude')).toBe('w1-2(claude)');
    expect(computePaneAutoName(10, 4, 'codex')).toBe('w10-4(codex)');
  });

  it('omits the suffix when no agent is detected (undefined or null)', () => {
    expect(computePaneAutoName(3, 1)).toBe('w3-1');
    expect(computePaneAutoName(3, 1, null)).toBe('w3-1');
    expect(computePaneAutoName(3, 1, undefined)).toBe('w3-1');
  });

  it('produces distinct names for distinct coordinates (the disambiguation property)', () => {
    // Two "claude" panes in the same workspace differ only by pane ordinal.
    const a = computePaneAutoName(1, 1, 'claude');
    const b = computePaneAutoName(1, 2, 'claude');
    expect(a).not.toBe(b);
    expect(a).toBe('w1-1(claude)');
    expect(b).toBe('w1-2(claude)');
  });
});

describe('paneDisplayName', () => {
  it('prefers the user label over the auto name', () => {
    expect(paneDisplayName('Backend', 'w1-2(claude)')).toBe('Backend');
  });

  it('falls back to the auto name when the label is absent or blank', () => {
    expect(paneDisplayName(undefined, 'w1-2')).toBe('w1-2');
    expect(paneDisplayName('', 'w1-2')).toBe('w1-2');
    expect(paneDisplayName('   ', 'w1-2')).toBe('w1-2');
  });
});

describe('paneNameFields', () => {
  it('flattens control characters a legacy label could carry into agent context', () => {
    const leaf = { id: 'p1', ordinal: 2, surfaces: [] };
    const fields = paneNameFields({ p1: 'api\nIGNORE PREVIOUS\u0007' }, {}, { wsOrdinal: 1 }, leaf);
    expect(fields).toEqual({ paneName: 'api IGNORE PREVIOUS', paneTag: '#w1-2' });
  });
});
