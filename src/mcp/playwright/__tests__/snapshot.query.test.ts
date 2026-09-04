import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot } from '../snapshot';

// `q` — a 250-option listbox costs ~4k tokens every time it is snapshotted, and
// an agent looking for one country in it pays that to read 249 lines it did not
// want (dogfood 2026-09-04). Same fake Page harness as snapshot.filter.test.ts.

interface CdpNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'name', value });

const TREE: CdpNode[] = [
  { nodeId: '1', role: role('RootWebArea'), name: name('Settings'), childIds: ['2', '9'] },
  { nodeId: '2', role: role('listbox'), name: name('Country'), childIds: ['3', '4', '5'] },
  { nodeId: '3', role: role('option'), name: name('Germany'), childIds: [] },
  { nodeId: '4', role: role('option'), name: name('Republic of Korea'), childIds: [] },
  { nodeId: '5', role: role('option'), name: name('United States'), childIds: [] },
  { nodeId: '9', role: role('paragraph'), name: name('Choose a country'), childIds: [] },
];

function makePage(nodes: CdpNode[]) {
  const client = {
    send: vi.fn(async (method: string) =>
      method === 'Accessibility.getFullAXTree' ? { nodes } : {},
    ),
    detach: vi.fn(() => Promise.resolve()),
  };
  return {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: vi.fn(async () => ''),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
}

describe('generateSnapshot q', () => {
  it('keeps the match and its ancestors, and drops the siblings', async () => {
    const out = await generateSnapshot(makePage(TREE) as never, { format: 'ai', q: 'korea' });

    // Case-insensitive substring: the ordinary case must not need escaping.
    expect(out).toContain('option "Republic of Korea"');
    // The ancestor chain stays, or a ref would come back with no context.
    expect(out).toContain('listbox "Country"');
    expect(out).not.toContain('Germany');
    expect(out).not.toContain('United States');
    // Never silently: a pruned tree reads as a page that lost those elements.
    expect(out).toContain('(q="korea": matching nodes and their ancestors only)');
  });

  it('reads /pattern/ as a regular expression', async () => {
    const out = await generateSnapshot(makePage(TREE) as never, {
      format: 'ai',
      q: '/^option (Germany|United)/',
    });

    expect(out).toContain('option "Germany"');
    expect(out).toContain('option "United States"');
    expect(out).not.toContain('Republic of Korea');
  });

  it('falls back to a substring when the pattern will not compile', async () => {
    // The caller asked for a smaller tree, not for an error.
    const out = await generateSnapshot(makePage(TREE) as never, { format: 'ai', q: '/[unclosed/' });
    expect(out).toContain('no nodes match');
  });

  it('says so when nothing matches, instead of returning the whole page', async () => {
    const out = await generateSnapshot(makePage(TREE) as never, { format: 'ai', q: 'Andorra' });
    expect(out).toBe('(no nodes match q="Andorra")');
  });

  it('composes with filter:"interactive" — the question narrows first', async () => {
    const out = await generateSnapshot(makePage(TREE) as never, {
      format: 'ai',
      filter: 'interactive',
      q: 'Country',
    });

    // `q` matched the listbox, which the interactive filter then kept.
    expect(out).toContain('listbox "Country"');
    // The prose that mentions "country" is not interactive, so it is gone even
    // though it matched the query.
    expect(out).not.toContain('Choose a country');
  });
});
