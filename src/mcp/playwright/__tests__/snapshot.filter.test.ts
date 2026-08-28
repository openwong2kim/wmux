import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot } from '../snapshot';

// filter:'interactive' (Phase 1): strip non-interactive nodes up front, not
// just on maxLength overflow — the measured-dominant agent usage. Same fake
// Page harness as snapshot.fallthrough.test.ts.

interface CdpNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

const TREE: CdpNode[] = [
  { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'name', value: 'Page' }, childIds: ['2', '3', '4'] },
  { nodeId: '2', role: { type: 'role', value: 'paragraph' }, name: { type: 'name', value: 'Some prose' }, childIds: [] },
  { nodeId: '3', role: { type: 'role', value: 'button' }, name: { type: 'name', value: 'OK' }, childIds: [] },
  { nodeId: '4', role: { type: 'role', value: 'link' }, name: { type: 'name', value: 'Docs' }, childIds: [] },
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

describe('generateSnapshot filter:"interactive"', () => {
  it('strips non-interactive nodes and keeps sequential refs', async () => {
    const page = makePage(TREE);
    const out = await generateSnapshot(page as never, { format: 'ai', filter: 'interactive' });

    expect(out).not.toContain('paragraph');
    expect(out).toContain('button');
    expect(out).toContain('ref="0"');
    expect(out).toContain('link');
    expect(out).toContain('ref="1"');
  });

  it('without the filter, non-interactive nodes remain', async () => {
    const page = makePage(TREE);
    const out = await generateSnapshot(page as never, { format: 'ai' });
    expect(out).toContain('paragraph');
    expect(out).toContain('button');
  });
});
