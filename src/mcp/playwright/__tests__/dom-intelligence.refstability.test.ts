import { describe, expect, it, vi } from 'vitest';
import {
  clearElementCache,
  getLocatorByRef,
  getSmartSnapshot,
  getSmartSnapshotViaEval,
  resolveSmartRefLocator,
} from '../dom-intelligence';

// Smart-ref stability, mirroring snapshot.refstability.test.ts for
// browser_snapshot. Smart refs used to be a running count over the a11y walk,
// so one node inserted above an element shifted its ref and every ref after it:
// replaying a smartRef clicked the neighbour, and browser_smart_snapshot could
// not diff at all because a renumber rewrites every line.

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'name', value });

/** Root plus one interactive child per entry, backend ids fixed per child. */
function tree(children: { backendId: number; role: string; name: string }[]): CdpNode[] {
  const nodes: CdpNode[] = [
    {
      nodeId: '1',
      backendDOMNodeId: 1,
      role: role('RootWebArea'),
      name: name('Page'),
      childIds: children.map((c) => String(c.backendId)),
    },
  ];
  for (const child of children) {
    nodes.push({
      nodeId: String(child.backendId),
      backendDOMNodeId: child.backendId,
      role: role(child.role),
      name: name(child.name),
      childIds: [],
    });
  }
  return nodes;
}

interface FakePage {
  nodes: CdpNode[];
  currentUrl: string;
  /** Every locator resolveSmartRefLocator asked for, as `role name#nth`. */
  asked: string[];
}

function makePage(nodes: CdpNode[], url = 'https://example.test/a') {
  const page = {
    nodes,
    currentUrl: url,
    asked: [] as string[],
    url() {
      return page.currentUrl;
    },
    title: async () => 'Page',
    innerText: async () => 'body text',
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string) =>
          method === 'Accessibility.getFullAXTree' ? { nodes: page.nodes } : {},
        ),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    locator: (selector: string) => {
      page.asked.push(selector);
      return selector as never;
    },
    getByRole: (r: string, opts?: { name?: string }) => ({
      nth: (i: number) => {
        const handle = `${r} ${opts?.name ?? ''}#${i}`;
        page.asked.push(handle);
        return handle as never;
      },
    }),
  };
  return page as unknown as FakePage & Parameters<typeof getSmartSnapshot>[0];
}

function refOf(elements: { ref: number; name: string }[], needle: string): number | undefined {
  return elements.find((e) => e.name === needle)?.ref;
}

describe('smart snapshot refs are keyed on DOM node identity', () => {
  it('keeps every surviving ref when a node is inserted ahead of them', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 10, role: 'button', name: 'OK' },
        { backendId: 11, role: 'link', name: 'Docs' },
      ]),
    );

    const before = await getSmartSnapshot(page);
    expect(refOf(before.elements, 'OK')).toBe(1);
    expect(refOf(before.elements, 'Docs')).toBe(2);

    // A click opened a banner above the pair — the exact shape that used to
    // shift every ref by one.
    (page as unknown as FakePage).nodes = tree([
      { backendId: 12, role: 'button', name: 'Dismiss' },
      { backendId: 10, role: 'button', name: 'OK' },
      { backendId: 11, role: 'link', name: 'Docs' },
    ]);
    const after = await getSmartSnapshot(page);

    expect(refOf(after.elements, 'OK')).toBe(1);
    expect(refOf(after.elements, 'Docs')).toBe(2);
    expect(refOf(after.elements, 'Dismiss')).toBe(3);
  });

  it('still clicks the element a ref was issued for after an insertion', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 10, role: 'button', name: 'OK' },
        { backendId: 11, role: 'link', name: 'Docs' },
      ]),
    );
    await getSmartSnapshot(page);

    (page as unknown as FakePage).nodes = tree([
      { backendId: 12, role: 'button', name: 'Dismiss' },
      { backendId: 10, role: 'button', name: 'OK' },
      { backendId: 11, role: 'link', name: 'Docs' },
    ]);
    await getSmartSnapshot(page);

    // The ref the agent is holding from the first snapshot.
    expect(resolveSmartRefLocator(page, 1)).toBe('button OK#0');
    expect((page as unknown as FakePage).asked).toEqual(['button OK#0']);
  });

  it('pins the right instance when several elements share role and name', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 20, role: 'button', name: 'Row' },
        { backendId: 21, role: 'button', name: 'Row' },
      ]),
    );
    await getSmartSnapshot(page);

    expect(resolveSmartRefLocator(page, 1)).toBe('button Row#0');
    expect(resolveSmartRefLocator(page, 2)).toBe('button Row#1');
  });

  it('never reissues the number of a removed node', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 30, role: 'button', name: 'Gone' },
        { backendId: 31, role: 'button', name: 'Stay' },
      ]),
    );
    await getSmartSnapshot(page);

    (page as unknown as FakePage).nodes = tree([
      { backendId: 31, role: 'button', name: 'Stay' },
      { backendId: 32, role: 'button', name: 'Fresh' },
    ]);
    const after = await getSmartSnapshot(page);

    expect(refOf(after.elements, 'Stay')).toBe(2);
    expect(refOf(after.elements, 'Fresh')).toBe(3);
    // Ref 1 named the removed element and stays retired.
    expect(after.elements.map((e) => e.ref)).not.toContain(1);
    expect(getLocatorByRef(1)).toBeNull();
  });

  it('does not reissue old numbers on a different document', async () => {
    clearElementCache();
    const page = makePage(tree([{ backendId: 40, role: 'button', name: 'A' }]));
    const before = await getSmartSnapshot(page);
    expect(refOf(before.elements, 'A')).toBe(1);

    (page as unknown as FakePage).currentUrl = 'https://example.test/b';
    (page as unknown as FakePage).nodes = tree([{ backendId: 50, role: 'button', name: 'B' }]);
    const after = await getSmartSnapshot(page);

    expect(refOf(after.elements, 'B')).toBe(2);
  });

  it('treats a fragment change as the same document', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 60, role: 'button', name: 'Copy' },
        { backendId: 61, role: 'link', name: 'API' },
      ]),
    );
    await getSmartSnapshot(page);

    (page as unknown as FakePage).currentUrl = 'https://example.test/a#section-4';
    const after = await getSmartSnapshot(page);

    expect(refOf(after.elements, 'Copy')).toBe(1);
    expect(refOf(after.elements, 'API')).toBe(2);
  });
});

describe('ref lookup no longer assumes a dense 1..n cache', () => {
  it('finds an element by its stored ref, not by its position', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 70, role: 'button', name: 'Gone' },
        { backendId: 71, role: 'button', name: 'Stay' },
      ]),
    );
    await getSmartSnapshot(page);
    (page as unknown as FakePage).nodes = tree([{ backendId: 71, role: 'button', name: 'Stay' }]);
    await getSmartSnapshot(page);

    // The survivor is the only cache entry but still carries ref 2. Positional
    // lookup (`cache[ref - 1]`) would miss it and hand back nothing.
    expect(getLocatorByRef(2)).toBe("getByRole('button', { name: 'Stay' })");
    expect(getLocatorByRef(1)).toBeNull();
  });
});

describe('RPC lane keeps positional refs', () => {
  it('resolves a smart ref through the data attribute it tagged', async () => {
    clearElementCache();
    // The RPC script cannot hold identity — browser_snapshot's RPC fallback
    // strips data-wmux-ref document-wide — so refs stay 1-based walk order and
    // resolve as a CSS selector rather than a role locator.
    const evaluate = async () => ({
      url: 'https://example.test/a',
      title: 'Page',
      content: '',
      elements: [
        { ref: 1, role: 'button', name: 'OK' },
        { ref: 2, role: 'link', name: 'Docs' },
      ],
    });
    const snapshot = await getSmartSnapshotViaEval(evaluate as never);
    expect(snapshot.elements.map((e) => e.ref)).toEqual([1, 2]);

    const page = makePage(tree([]));
    expect(resolveSmartRefLocator(page, 2)).toBe('[data-wmux-ref="2"]');
  });
});
