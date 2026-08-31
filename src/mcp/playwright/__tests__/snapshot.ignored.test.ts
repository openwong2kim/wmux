import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot } from '../snapshot';

// Chrome's real AX tree hangs a chain of `ignored: true` /
// `ignoredReasons: ["uninteresting"]` wrappers (html → body → generic)
// directly under the RootWebArea. buildTree() used to DROP an ignored node
// together with its whole subtree, which left the root with zero children on
// every real page: isRootOnly() went true and each snapshot was silently
// demoted to the DOM listing (killing format:'aria' and filter:'interactive',
// which only exist on the a11y path). Measured on a live page: 8 ignored nodes
// out of 1126 collapsed the entire tree. These tests pin the splice behaviour —
// an ignored node disappears, its children take its place.

interface CdpNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
  ignored?: boolean;
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'computedString', value });

/** An "uninteresting" wrapper, exactly as Chrome reports it. */
const wrapper = (nodeId: string, childIds: string[]): CdpNode => ({
  nodeId,
  role: role('none'),
  ignored: true,
  childIds,
});

// Shape of the measured HN tree: RootWebArea → 3 ignored wrappers → content.
const IGNORED_CHAIN: CdpNode[] = [
  { nodeId: '479', role: role('RootWebArea'), name: name('Hacker News'), childIds: ['482'] },
  wrapper('482', ['490']),
  wrapper('490', ['491']),
  wrapper('491', ['492']),
  { nodeId: '492', role: role('LayoutTable'), name: name('stories'), childIds: ['493', '494', '495'] },
  { nodeId: '493', role: role('link'), name: name('First story'), childIds: [] },
  { nodeId: '494', role: role('link'), name: name('Second story'), childIds: [] },
  { nodeId: '495', role: role('paragraph'), name: name('42 points'), childIds: [] },
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
    evaluate: vi.fn(async () => 'DOM-FALLBACK'),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
}

describe('buildTree — ignored nodes are spliced, not dropped', () => {
  it('keeps the document reachable through a 3-deep ignored wrapper chain', async () => {
    const page = makePage(IGNORED_CHAIN);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    // The whole point: no demotion to the DOM listing.
    // The a11y path does evaluate once — the page-facts footer collector — so
    // what must not appear is the DOM interactive listing expression.
    expect(page.evaluate).not.toHaveBeenCalledWith(
      expect.stringContaining('const interactiveOnly'),
    );
    expect(out).not.toBe('DOM-FALLBACK');

    // Real content survived, refs and all.
    expect(out).toContain('LayoutTable "stories"');
    expect(out).toContain('link "First story" ref="0"');
    expect(out).toContain('link "Second story" ref="1"');
    expect(out).toContain('paragraph "42 points"');
  });

  it('does not emit the ignored wrappers themselves', async () => {
    const out = await generateSnapshot(makePage(IGNORED_CHAIN) as never, { format: 'ai' });
    // The wrappers all carry role 'none' — none of them may reach the output.
    expect(out).not.toContain('none');
    // The spliced content is hoisted to the root's own child level.
    expect(out.split('\n')[0]).toBe('- LayoutTable "stories"');
  });

  it('preserves sibling order when an ignored node sits between real ones', async () => {
    const nodes: CdpNode[] = [
      { nodeId: '1', role: role('RootWebArea'), name: name('Page'), childIds: ['2', '3', '6'] },
      { nodeId: '2', role: role('button'), name: name('before'), childIds: [] },
      wrapper('3', ['4', '5']),
      { nodeId: '4', role: role('button'), name: name('a'), childIds: [] },
      { nodeId: '5', role: role('button'), name: name('b'), childIds: [] },
      { nodeId: '6', role: role('button'), name: name('after'), childIds: [] },
    ];
    const out = await generateSnapshot(makePage(nodes) as never, { format: 'ai' });

    expect(out.split('\n')).toEqual([
      '- button "before" ref="0"',
      '- button "a" ref="1"',
      '- button "b" ref="2"',
      '- button "after" ref="3"',
    ]);
  });

  it('keeps the tree when the root itself is ignored', async () => {
    const nodes: CdpNode[] = [
      { ...wrapper('1', ['2']), role: role('RootWebArea'), name: name('Page') },
      { nodeId: '2', role: role('button'), name: name('OK'), childIds: [] },
    ];
    const page = makePage(nodes);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    // The ignored root stays as a container so its children are not lost, and
    // serializeTree emits the children rather than the root line itself.
    // The a11y path does evaluate once — the page-facts footer collector — so
    // what must not appear is the DOM interactive listing expression.
    expect(page.evaluate).not.toHaveBeenCalledWith(
      expect.stringContaining('const interactiveOnly'),
    );
    expect(out).toBe('- button "OK" ref="0"');
  });

  it('applies filter:"interactive" across a spliced tree', async () => {
    const out = await generateSnapshot(makePage(IGNORED_CHAIN) as never, {
      format: 'ai',
      filter: 'interactive',
    });

    expect(out).toContain('link "First story" ref="0"');
    expect(out).toContain('link "Second story" ref="1"');
    // Non-interactive nodes are stripped — including the LayoutTable that only
    // became reachable because of the splice.
    expect(out).not.toContain('paragraph');
  });

  it('renders format:"aria" from the spliced tree instead of the collapse note', async () => {
    const out = await generateSnapshot(makePage(IGNORED_CHAIN) as never, { format: 'aria' });

    expect(out).not.toContain('aria format unavailable');
    // aria mints no refs but keeps the full nesting.
    expect(out).not.toContain('ref=');
    expect(out).toBe(
      [
        '- LayoutTable "stories"',
        '  - link "First story"',
        '  - link "Second story"',
        '  - paragraph "42 points"',
      ].join('\n'),
    );
  });
});
