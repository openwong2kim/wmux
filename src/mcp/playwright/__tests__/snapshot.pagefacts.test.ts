import { describe, expect, it, vi } from 'vitest';
import {
  PAGE_FACTS_LIMITS,
  describePageReadiness,
  formatPageFactsFooter,
  isReportableScrollable,
  type PageFacts,
} from '../pageFacts';
import { generateScopedSnapshot, generateSnapshot } from '../snapshot';

function facts(over: Partial<PageFacts> = {}): PageFacts {
  return {
    totalElements: 200,
    interactiveElements: 40,
    textChars: 8000,
    scrollables: [],
    scanTruncated: false,
    scrollablesTruncated: false,
    ...over,
  };
}

describe('pageFacts: readiness verdicts', () => {
  it('calls a page with almost no interactive elements nearly empty', () => {
    expect(describePageReadiness(facts({ interactiveElements: 3 }), 0)).toContain('nearly empty');
  });

  it('calls a dense-but-textless page a skeleton without needing pending requests', () => {
    const note = describePageReadiness(facts({ totalElements: 400, textChars: 100 }), 0);
    expect(note).toContain('skeleton screen likely');
    expect(note).not.toContain('in flight');
  });

  it('strengthens the skeleton verdict with in-flight requests when they are known', () => {
    const note = describePageReadiness(facts({ totalElements: 400, textChars: 100 }), 3);
    expect(note).toContain('3 request(s) in flight');
  });

  it('says nothing about an ordinary page', () => {
    expect(describePageReadiness(facts(), 5)).toBe('');
  });
});

describe('pageFacts: scrollable reporting rules', () => {
  const base = {
    tagName: 'div',
    scrollHeight: 900,
    clientHeight: 400,
    overflowY: 'auto',
    hasScrollableAncestor: false,
  };

  it('reports an overflowing auto/scroll/overlay container', () => {
    expect(isReportableScrollable(base)).toBe(true);
    expect(isReportableScrollable({ ...base, overflowY: 'scroll' })).toBe(true);
    expect(isReportableScrollable({ ...base, overflowY: 'overlay' })).toBe(true);
  });

  it('ignores visible overflow and sub-pixel differences', () => {
    expect(isReportableScrollable({ ...base, overflowY: 'visible' })).toBe(false);
    expect(isReportableScrollable({ ...base, scrollHeight: 401 })).toBe(false);
  });

  it('omits a scroller nested inside another scroller', () => {
    expect(isReportableScrollable({ ...base, hasScrollableAncestor: true })).toBe(false);
  });

  it('always reports an iframe, nested or not scrollable at all', () => {
    expect(
      isReportableScrollable({
        tagName: 'IFRAME',
        scrollHeight: 0,
        clientHeight: 0,
        overflowY: 'visible',
        hasScrollableAncestor: true,
      }),
    ).toBe(true);
  });
});

describe('pageFacts: footer', () => {
  it('is empty when there is nothing to report', () => {
    expect(formatPageFactsFooter(facts(), 0)).toBe('');
  });

  it('lists containers by selector and flags a truncated list', () => {
    const footer = formatPageFactsFooter(
      facts({
        scrollables: [
          { selector: '#feed', width: 800, height: 600, scrollHeight: 4000, isIframe: false },
          { selector: 'iframe:nth-of-type(2)', width: 300, height: 200, scrollHeight: 200, isIframe: true },
        ],
        scrollablesTruncated: true,
      }),
      0,
    );
    expect(footer).toContain('#feed (800x600, scrollHeight 4000)');
    expect(footer).toContain('iframe:nth-of-type(2) (300x200, scrollHeight 200, iframe)');
    expect(footer).toContain('more scrollable containers not listed');
  });

  it('keeps sane scan and report ceilings', () => {
    expect(PAGE_FACTS_LIMITS.MAX_SCAN_NODES).toBeGreaterThan(0);
    expect(PAGE_FACTS_LIMITS.MAX_SCROLLABLES).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL regressions: the footer must not break the maxLength contract, and
// must never appear on a scoped snapshot.
// ---------------------------------------------------------------------------

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

/** A tree big enough to overflow any small maxLength. */
function bigTree(): CdpNode[] {
  const children = Array.from({ length: 120 }, (_, i) => String(i + 2));
  const nodes: CdpNode[] = [
    {
      nodeId: '1',
      backendDOMNodeId: 1,
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'name', value: 'Big' },
      childIds: children,
    },
  ];
  for (let i = 0; i < 120; i++) {
    nodes.push({
      nodeId: String(i + 2),
      backendDOMNodeId: i + 2,
      role: { type: 'role', value: 'button' },
      name: { type: 'name', value: `Button number ${i} with a long-ish label` },
      childIds: [],
    });
  }
  return nodes;
}

const LIVE_FACTS: PageFacts = {
  totalElements: 400,
  interactiveElements: 120,
  textChars: 100,
  scrollables: [
    { selector: '#feed', width: 800, height: 600, scrollHeight: 9000, isIframe: false },
  ],
  scanTruncated: false,
  scrollablesTruncated: false,
};

function makePage(nodes: CdpNode[]) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes };
    if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
    if (method === 'DOM.querySelector') return { nodeId: 101 };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 1 } };
    if (method === 'Runtime.evaluate') return { result: {} };
    void params;
    return {};
  });
  const client = { send, detach: vi.fn(() => Promise.resolve()) };
  return {
    context: () => ({ newCDPSession: async () => client }),
    // Every in-page evaluation this path makes is the page-facts collector.
    evaluate: vi.fn(async () => LIVE_FACTS),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
}

describe('snapshot: page-facts footer', () => {
  it('appends the readiness note and scrollable list to a page snapshot', async () => {
    const out = await generateSnapshot(makePage(bigTree()) as never, { format: 'ai' });
    expect(out).toContain('skeleton screen likely');
    expect(out).toContain('#feed (800x600, scrollHeight 9000)');
  });

  it('[CRITICAL] keeps the maxLength truncation contract with the footer charged to it', async () => {
    const maxLength = 2000;
    const out = await generateSnapshot(makePage(bigTree()) as never, { format: 'ai', maxLength });
    expect(out).toContain('... (truncated)');
    expect(out).toContain('#feed');
    // The pre-existing contract: the body is cut to the budget, and the only
    // allowed overshoot is the truncation marker itself.
    expect(out.length).toBeLessThanOrEqual(maxLength + '\n... (truncated)'.length);
  });

  it('[CRITICAL] never annotates a scoped snapshot', async () => {
    const out = await generateScopedSnapshot(makePage(bigTree()) as never, '#anything', {
      format: 'ai',
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain('skeleton screen likely');
    expect(out).not.toContain('scrollable containers');
  });
});
