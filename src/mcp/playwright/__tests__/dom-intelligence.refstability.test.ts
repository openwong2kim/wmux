import { describe, expect, it, vi } from 'vitest';
import {
  clearElementCache,
  getLocatorByRef,
  getSmartElementByRef,
  getSmartSnapshot,
  getSmartSnapshotViaEval,
  resolveSmartRefLocator,
  smartPageToken,
  smartRefAxisEntry,
  StaleSmartRefError,
} from '../dom-intelligence';

// Smart-ref stability, mirroring snapshot.refstability.test.ts for
// browser_snapshot. Smart refs used to be a running count over the a11y walk,
// so one node inserted above an element shifted its ref and every ref after it:
// replaying a smartRef clicked the neighbour, and browser_smart_snapshot could
// not diff at all because a renumber rewrites every line.
//
// The resolution half mirrors resolveRefViaAxMap: a stable NUMBER only says the
// element was not renumbered, not that it is still there, so every way the page
// can move out from under a ref has to be caught and reported rather than
// resolved to whatever now sits at that index.

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'name', value });

interface Child {
  backendId?: number;
  role: string;
  name: string;
}

/** Root plus one interactive child per entry, backend ids fixed per child. */
function tree(children: Child[]): CdpNode[] {
  const nodes: CdpNode[] = [
    {
      nodeId: '1',
      backendDOMNodeId: 1,
      role: role('RootWebArea'),
      name: name('Page'),
      childIds: children.map((c, i) => `c${c.backendId ?? `x${i}`}`),
    },
  ];
  children.forEach((child, i) => {
    nodes.push({
      nodeId: `c${child.backendId ?? `x${i}`}`,
      ...(child.backendId !== undefined && { backendDOMNodeId: child.backendId }),
      role: role(child.role),
      name: name(child.name),
      childIds: [],
    });
  });
  return nodes;
}

interface RoleQuery {
  role: string;
  name?: string;
  exact?: boolean;
}

interface FakePage {
  nodes: CdpNode[];
  currentUrl: string;
  /** Live match count per `role|name` the locator should report. */
  liveCounts: Map<string, number>;
  /** Every getByRole query resolution made. */
  queries: RoleQuery[];
  /** Locators actually returned, as `role|name#nth`. */
  picked: string[];
  /** Fire a main-frame navigation the way Playwright would. */
  navigate: (url?: string) => void;
  axTreeCalls: unknown[][];
}

function makePage(nodes: CdpNode[], url = 'https://example.test/a') {
  const listeners: ((frame: unknown) => void)[] = [];
  const mainFrame = { id: 'main' };
  const page = {
    nodes,
    currentUrl: url,
    liveCounts: new Map<string, number>(),
    queries: [] as RoleQuery[],
    picked: [] as string[],
    axTreeCalls: [] as unknown[][],
    url: () => page.currentUrl,
    title: async () => 'Page',
    innerText: async () => 'body text',
    on: (event: string, fn: (frame: unknown) => void) => {
      if (event === 'framenavigated') listeners.push(fn);
    },
    mainFrame: () => mainFrame,
    navigate: (next?: string) => {
      if (next !== undefined) page.currentUrl = next;
      for (const fn of listeners) fn(mainFrame);
    },
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string, params?: unknown) => {
          if (method !== 'Accessibility.getFullAXTree') return {};
          page.axTreeCalls.push([method, params]);
          return { nodes: page.nodes };
        }),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    locator: (selector: string) => {
      page.picked.push(selector);
      return selector as never;
    },
    getByRole: (r: string, opts?: { name?: string; exact?: boolean }) => {
      page.queries.push({ role: r, ...(opts?.name !== undefined && { name: opts.name }), ...(opts?.exact !== undefined && { exact: opts.exact }) });
      const key = `${r}|${opts?.name ?? ''}`;
      return {
        count: async () => page.liveCounts.get(key) ?? countInTree(page.nodes, r, opts?.name),
        nth: (i: number) => {
          const handle = `${key}#${i}`;
          page.picked.push(handle);
          return handle as never;
        },
      };
    },
  };
  return page as unknown as FakePage & Parameters<typeof getSmartSnapshot>[0];
}

/** What the live page would report for a role (+ optional exact name). */
function countInTree(nodes: CdpNode[], r: string, wanted?: string): number {
  return nodes.filter(
    (n) =>
      n.role?.value === r && (wanted === undefined || (n.name?.value ?? '') === wanted),
  ).length;
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
    expect(await resolveSmartRefLocator(page, 1)).toBe('button|OK#0');
  });

  it('asks for an EXACT name match', async () => {
    clearElementCache();
    // getByRole's name filter is substring- and case-insensitive by default, so
    // a ref for "Save" used to match "Save draft" too — and the index it was
    // paired with then indexed into a population the snapshot never counted.
    const page = makePage(
      tree([
        { backendId: 20, role: 'button', name: 'Save' },
        { backendId: 21, role: 'button', name: 'Save draft' },
      ]),
    );
    await getSmartSnapshot(page);

    expect(await resolveSmartRefLocator(page, 1)).toBe('button|Save#0');
    expect((page as unknown as FakePage).queries).toContainEqual({
      role: 'button',
      name: 'Save',
      exact: true,
    });
  });

  it('pins the right instance when several elements share role and name', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 30, role: 'button', name: 'Row' },
        { backendId: 31, role: 'button', name: 'Row' },
      ]),
    );
    await getSmartSnapshot(page);

    expect(await resolveSmartRefLocator(page, 1)).toBe('button|Row#0');
    expect(await resolveSmartRefLocator(page, 2)).toBe('button|Row#1');
  });

  it('indexes an UNNAMED element against the whole role population', async () => {
    clearElementCache();
    // `getByRole('button')` counts the named siblings too, so the name-keyed
    // index is not an index into what that locator returns.
    const page = makePage(
      tree([
        { backendId: 40, role: 'button', name: 'Named' },
        { backendId: 41, role: 'button', name: '' },
      ]),
    );
    const snap = await getSmartSnapshot(page);
    const unnamed = snap.elements.find((e) => e.name === '');

    expect(unnamed?.sameNameIndex).toBe(0);
    expect(unnamed?.roleIndex).toBe(1);
    // Index 1 of the role population, not index 0 of the nameless one.
    expect(await resolveSmartRefLocator(page, unnamed!.ref)).toBe('button|#1');
    expect((page as unknown as FakePage).queries).toContainEqual({ role: 'button' });
  });

  it('never reissues the number of a removed node', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 50, role: 'button', name: 'Gone' },
        { backendId: 51, role: 'button', name: 'Stay' },
      ]),
    );
    await getSmartSnapshot(page);

    (page as unknown as FakePage).nodes = tree([
      { backendId: 51, role: 'button', name: 'Stay' },
      { backendId: 52, role: 'button', name: 'Fresh' },
    ]);
    const after = await getSmartSnapshot(page);

    expect(refOf(after.elements, 'Stay')).toBe(2);
    expect(refOf(after.elements, 'Fresh')).toBe(3);
    expect(after.elements.map((e) => e.ref)).not.toContain(1);
  });

  it('does not reissue old numbers on a different document', async () => {
    clearElementCache();
    const page = makePage(tree([{ backendId: 60, role: 'button', name: 'A' }]));
    const before = await getSmartSnapshot(page);
    expect(refOf(before.elements, 'A')).toBe(1);

    (page as unknown as FakePage).currentUrl = 'https://example.test/b';
    (page as unknown as FakePage).nodes = tree([{ backendId: 70, role: 'button', name: 'B' }]);
    const after = await getSmartSnapshot(page);

    expect(refOf(after.elements, 'B')).toBe(2);
  });

  it('treats a fragment change as the same document', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 80, role: 'button', name: 'Copy' },
        { backendId: 81, role: 'link', name: 'API' },
      ]),
    );
    await getSmartSnapshot(page);

    (page as unknown as FakePage).currentUrl = 'https://example.test/a#section-4';
    const after = await getSmartSnapshot(page);

    expect(refOf(after.elements, 'Copy')).toBe(1);
    expect(refOf(after.elements, 'API')).toBe(2);
  });

  it('skips a node with no backendDOMNodeId instead of renumbering it forever', async () => {
    clearElementCache();
    // Such a node has nothing to key a ref on, so it drew a fresh number on
    // every snapshot: the ref an agent read was never the one the next snapshot
    // printed, and its line changed in every diff.
    const page = makePage(
      tree([
        { role: 'button', name: 'Anonymous' },
        { backendId: 90, role: 'button', name: 'Real' },
      ]),
    );
    const first = await getSmartSnapshot(page);
    expect(first.elements.map((e) => e.name)).toEqual(['Real']);

    const second = await getSmartSnapshot(page);
    expect(second.elements).toEqual(first.elements);
  });

  it('gives a toggled element its old ref back — trimming waits for the cap', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 100, role: 'button', name: 'Menu item' },
        { backendId: 101, role: 'button', name: 'Toggle' },
      ]),
    );
    await getSmartSnapshot(page);

    // The menu closed…
    (page as unknown as FakePage).nodes = tree([
      { backendId: 101, role: 'button', name: 'Toggle' },
    ]);
    await getSmartSnapshot(page);

    // …and reopened. Forgetting the id while the map still fits would renumber
    // the item on every open/close cycle — a diff line each time, and a ref the
    // agent was holding gone for no reason.
    (page as unknown as FakePage).nodes = tree([
      { backendId: 100, role: 'button', name: 'Menu item' },
      { backendId: 101, role: 'button', name: 'Toggle' },
    ]);
    const back = await getSmartSnapshot(page);

    expect(refOf(back.elements, 'Menu item')).toBe(1);
    expect(refOf(back.elements, 'Toggle')).toBe(2);
  });

  it('reads one accessibility tree per snapshot, so refs come from one document', async () => {
    clearElementCache();
    // getFullAXTree on a page target stops AT an <iframe> — childIds: [], the
    // child document absent (snapshot.ts, measured on Chrome 141). Frame
    // contents only arrive through an extra getFullAXTree({ frameId }), which
    // this walk never makes: that is what keeps every backendDOMNodeId it sees
    // inside one id space, and the sameNameIndex population the same set as the
    // one page.getByRole sweeps.
    const page = makePage(tree([{ backendId: 110, role: 'button', name: 'Outer' }]));
    await getSmartSnapshot(page);

    expect((page as unknown as FakePage).axTreeCalls).toEqual([
      ['Accessibility.getFullAXTree', undefined],
    ]);
  });
});

describe('ref lookup no longer assumes a dense 1..n cache', () => {
  it('finds an element by its stored ref, not by its position', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 120, role: 'button', name: 'Gone' },
        { backendId: 121, role: 'button', name: 'Stay' },
      ]),
    );
    await getSmartSnapshot(page);
    (page as unknown as FakePage).nodes = tree([
      { backendId: 121, role: 'button', name: 'Stay' },
    ]);
    await getSmartSnapshot(page);

    // The survivor is the only cache entry but still carries ref 2. Positional
    // lookup (`cache[ref - 1]`) would miss it and hand back nothing.
    expect(getLocatorByRef(2)).toBe("getByRole('button', { name: 'Stay' })");
    expect(getLocatorByRef(1)).toBeNull();
    expect(getSmartElementByRef(2)?.name).toBe('Stay');
  });
});

describe('a stale smart ref is refused, never silently substituted', () => {
  it('rejects every ref once the page has navigated', async () => {
    clearElementCache();
    const page = makePage(tree([{ backendId: 130, role: 'button', name: 'Save' }]));
    await getSmartSnapshot(page);

    (page as unknown as FakePage).currentUrl = 'https://example.test/elsewhere';

    await expect(resolveSmartRefLocator(page, 1)).rejects.toBeInstanceOf(StaleSmartRefError);
    await expect(resolveSmartRefLocator(page, 1)).rejects.toThrow(/navigated/);
  });

  it('rejects every ref after a reload of the SAME url', async () => {
    clearElementCache();
    // The URL comparison cannot see a reload, a back/forward, or a re-submitted
    // form — and the new document's low backendDOMNodeIds would take the old
    // document's refs.
    const page = makePage(tree([{ backendId: 140, role: 'button', name: 'Submit' }]));
    await getSmartSnapshot(page);

    (page as unknown as FakePage).navigate();

    await expect(resolveSmartRefLocator(page, 1)).rejects.toBeInstanceOf(StaleSmartRefError);
    await expect(resolveSmartRefLocator(page, 1)).rejects.toThrow(/reloaded/);
  });

  it('gives the reloaded page a different baseline token', async () => {
    clearElementCache();
    const page = makePage(tree([{ backendId: 150, role: 'button', name: 'Submit' }]));
    await getSmartSnapshot(page);
    const before = smartPageToken(page);

    (page as unknown as FakePage).navigate();
    expect(smartPageToken(page)).not.toBe(before);
  });

  it('rejects a ref whose element the latest snapshot no longer lists', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 160, role: 'button', name: 'Gone' },
        { backendId: 161, role: 'button', name: 'Stay' },
      ]),
    );
    await getSmartSnapshot(page);
    (page as unknown as FakePage).nodes = tree([
      { backendId: 161, role: 'button', name: 'Stay' },
    ]);
    await getSmartSnapshot(page);

    await expect(resolveSmartRefLocator(page, 1)).rejects.toThrow(/no longer in the page snapshot/);
  });

  it('rejects when the role+name population moved under the ref', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 170, role: 'button', name: 'Row' },
        { backendId: 171, role: 'button', name: 'Row' },
      ]),
    );
    await getSmartSnapshot(page);

    // One of the two rows went away without a fresh snapshot. Clamping onto the
    // survivor is the silent wrong-element case.
    (page as unknown as FakePage).liveCounts.set('button|Row', 1);

    await expect(resolveSmartRefLocator(page, 2)).rejects.toThrow(/no longer identifies one element/);
    expect((page as unknown as FakePage).picked).toEqual([]);
  });

  it('does not block a uniquely named ref when the page count differs', async () => {
    clearElementCache();
    // The snapshot enumerates an a11y tree; the locator sweeps the whole page.
    // For a name the snapshot saw once the index is 0 either way.
    const page = makePage(tree([{ backendId: 180, role: 'button', name: 'Copy' }]));
    await getSmartSnapshot(page);
    (page as unknown as FakePage).liveCounts.set('button|Copy', 3);

    expect(await resolveSmartRefLocator(page, 1)).toBe('button|Copy#0');
  });

  it('refuses a click aimed at a different page than the snapshot', async () => {
    clearElementCache();
    // One connection can drive several tabs and surfaces; ref numbers restart
    // at 1 per page and the cache holds only the last snapshot.
    const tabA = makePage(tree([{ backendId: 190, role: 'button', name: 'Buy' }]));
    const tabB = makePage(tree([{ backendId: 190, role: 'button', name: 'Delete' }]));
    await getSmartSnapshot(tabA, { surfaceId: 'surf-a' });

    await expect(resolveSmartRefLocator(tabB, 1)).rejects.toBeInstanceOf(StaleSmartRefError);
    await expect(resolveSmartRefLocator(tabB, 1)).rejects.toThrow(/different page/);
  });
});

describe('replay axis for a smart ref', () => {
  it('carries the role/name/nth tuple the replay runner can re-resolve', async () => {
    clearElementCache();
    const page = makePage(
      tree([
        { backendId: 200, role: 'button', name: 'Row' },
        { backendId: 201, role: 'button', name: 'Row' },
      ]),
    );
    await getSmartSnapshot(page);

    expect(smartRefAxisEntry(2)).toEqual({
      role: 'button',
      name: 'Row',
      sameNameIndex: 1,
      sameNameTotal: 2,
      frameKey: '',
    });
  });

  it('has no ref axis on the RPC lane, whose selector is a real one', async () => {
    clearElementCache();
    const evaluate = async () => ({
      url: 'https://example.test/a',
      title: 'Page',
      content: '',
      elements: [{ ref: 1, role: 'button', name: 'OK' }],
    });
    await getSmartSnapshotViaEval(evaluate as never);

    expect(smartRefAxisEntry(1)).toBeNull();
    expect(getLocatorByRef(1)).toBe('[data-wmux-ref="1"]');
  });
});

describe('RPC lane keeps positional refs', () => {
  it('resolves a smart ref through the data attribute it tagged', async () => {
    clearElementCache();
    // Identity cannot be held here: browser_snapshot's RPC fallback strips
    // data-wmux-ref document-wide and renumbers from 0 on each of its scans.
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

    // No page was captured on this lane, so any page may resolve the selector.
    const page = makePage(tree([]));
    expect(await resolveSmartRefLocator(page, 2)).toBe('[data-wmux-ref="2"]');
  });
});
