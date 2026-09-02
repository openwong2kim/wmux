import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot, resolveRef, StaleRefError } from '../snapshot';
import { formatSnapshotResult } from '../snapshotDiff';

// Ref stability (dogfood, 2026-08-30). Refs used to be a running count over the
// walk, so one inserted node shifted every ref after it: replaying a ref from
// the previous snapshot clicked the neighbour, with no error to notice. It also
// kept browser_snapshot's auto-diff from ever being adopted, because a renumber
// rewrites nearly every line.
//
// Same fake Page harness as snapshot.filter.test.ts, plus url() (the navigation
// guard reads it) and getByRole (resolveRef locates through it).

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
  url: () => string;
  currentUrl: string;
  /** Live count getByRole should report, keyed `role name`. */
  liveCounts: Map<string, number>;
  handles: string[];
}

function makePage(nodes: CdpNode[], url = 'https://example.test/a') {
  const page = {
    nodes,
    currentUrl: url,
    liveCounts: new Map<string, number>(),
    handles: [] as string[],
    url() {
      return page.currentUrl;
    },
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string) =>
          method === 'Accessibility.getFullAXTree' ? { nodes: page.nodes } : {},
        ),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    evaluate: vi.fn(async () => ''),
    locator: vi.fn(),
    getByRole: (r: string, opts?: { name?: string }) => {
      const key = `${r} ${opts?.name ?? ''}`;
      const count = page.liveCounts.get(key) ?? 1;
      return {
        count: async () => count,
        nth: (i: number) => ({
          elementHandle: async () => {
            const handle = `${key}#${i}`;
            page.handles.push(handle);
            return handle as never;
          },
        }),
      };
    },
  };
  return page as unknown as FakePage & Parameters<typeof generateSnapshot>[0];
}

describe('snapshot refs are keyed on DOM node identity', () => {
  it('keeps every surviving ref when a node is inserted ahead of them', async () => {
    const page = makePage(
      tree([
        { backendId: 10, role: 'button', name: 'OK' },
        { backendId: 11, role: 'link', name: 'Docs' },
      ]),
    );

    const before = await generateSnapshot(page, { format: 'ai' });
    expect(before).toContain('button "OK" ref="0"');
    expect(before).toContain('link "Docs" ref="1"');

    // A click inserted a node at the top — the exact shape that used to shift
    // every ref by one.
    (page as unknown as FakePage).nodes = tree([
      { backendId: 12, role: 'button', name: 'Dismiss' },
      { backendId: 10, role: 'button', name: 'OK' },
      { backendId: 11, role: 'link', name: 'Docs' },
    ]);
    const after = await generateSnapshot(page, { format: 'ai' });

    expect(after).toContain('button "OK" ref="0"');
    expect(after).toContain('link "Docs" ref="1"');
    expect(after).toContain('button "Dismiss" ref="2"');
  });

  it('never reissues the number of a removed node', async () => {
    const page = makePage(
      tree([
        { backendId: 20, role: 'button', name: 'Gone' },
        { backendId: 21, role: 'button', name: 'Stay' },
      ]),
    );
    await generateSnapshot(page, { format: 'ai' });

    (page as unknown as FakePage).nodes = tree([
      { backendId: 21, role: 'button', name: 'Stay' },
      { backendId: 22, role: 'button', name: 'Fresh' },
    ]);
    const after = await generateSnapshot(page, { format: 'ai' });

    expect(after).toContain('button "Stay" ref="1"');
    expect(after).toContain('button "Fresh" ref="2"');
    expect(after).not.toContain('ref="0"');
  });

  it('does not reissue old numbers on a different document', async () => {
    const page = makePage(tree([{ backendId: 30, role: 'button', name: 'A' }]));
    const before = await generateSnapshot(page, { format: 'ai' });
    expect(before).toContain('button "A" ref="0"');

    (page as unknown as FakePage).currentUrl = 'https://example.test/b';
    (page as unknown as FakePage).nodes = tree([{ backendId: 40, role: 'button', name: 'B' }]);
    const after = await generateSnapshot(page, { format: 'ai' });

    // Rewinding to 0 here would hand a ref held from the old document whatever
    // now sits at that number the moment the URL comes back round.
    expect(after).toContain('button "B" ref="1"');
    expect(after).not.toContain('ref="0"');
  });

  it('treats a fragment change as the same document', async () => {
    // Docs sites rewrite location.hash while you scroll. Retiring every ref on
    // that would renumber the next snapshot and kill the diff outright.
    const page = makePage(
      tree([
        { backendId: 90, role: 'button', name: 'Copy' },
        { backendId: 91, role: 'link', name: 'API' },
      ]),
    );
    await generateSnapshot(page, { format: 'ai' });

    (page as unknown as FakePage).currentUrl = 'https://example.test/a#section-4';
    const after = await generateSnapshot(page, { format: 'ai' });

    expect(after).toContain('button "Copy" ref="0"');
    expect(after).toContain('link "API" ref="1"');
    expect(await resolveRef(page, '0')).toBe('button Copy#0');
  });
});

describe('resolveRef refuses a stale ref instead of substituting an element', () => {
  it('rejects every ref once the page has navigated', async () => {
    const page = makePage(tree([{ backendId: 50, role: 'button', name: 'Save' }]));
    await generateSnapshot(page, { format: 'ai' });

    (page as unknown as FakePage).currentUrl = 'https://example.test/elsewhere';

    await expect(resolveRef(page, '0')).rejects.toBeInstanceOf(StaleRefError);
    await expect(resolveRef(page, '0')).rejects.toThrow(/navigated/);
  });

  it('rejects a ref whose element the latest snapshot no longer lists', async () => {
    const page = makePage(
      tree([
        { backendId: 60, role: 'button', name: 'Gone' },
        { backendId: 61, role: 'button', name: 'Stay' },
      ]),
    );
    await generateSnapshot(page, { format: 'ai' });

    (page as unknown as FakePage).nodes = tree([{ backendId: 61, role: 'button', name: 'Stay' }]);
    await generateSnapshot(page, { format: 'ai' });

    await expect(resolveRef(page, '0')).rejects.toBeInstanceOf(StaleRefError);
    await expect(resolveRef(page, '0')).rejects.toThrow(/browser_snapshot/);
  });

  it('rejects when the role+name population moved under the ref', async () => {
    const page = makePage(
      tree([
        { backendId: 70, role: 'button', name: 'Row' },
        { backendId: 71, role: 'button', name: 'Row' },
      ]),
    );
    await generateSnapshot(page, { format: 'ai' });

    // One of the two rows went away without a fresh snapshot. The old resolver
    // clamped with Math.min() and clicked the survivor.
    (page as unknown as FakePage).liveCounts.set('button Row', 1);

    await expect(resolveRef(page, '1')).rejects.toBeInstanceOf(StaleRefError);
    expect((page as unknown as FakePage).handles).toEqual([]);
  });

  it('does not block a uniquely named ref when the page count differs', async () => {
    // The snapshot enumerates a depth-capped a11y tree; the locator sweeps the
    // whole page. For a name the snapshot saw once the index is 0 either way,
    // so a mismatched count must not cost the agent the click.
    const page = makePage(tree([{ backendId: 85, role: 'button', name: 'Copy' }]));
    await generateSnapshot(page, { format: 'ai' });
    (page as unknown as FakePage).liveCounts.set('button Copy', 3);

    expect(await resolveRef(page, '0')).toBe('button Copy#0');
  });

  it('DOES block that singleton when the caller asks for strictCount', async () => {
    // The replay lane opts in: there, index 0 is not reassuring, because a
    // look-alike inserted above the recorded element between the internal
    // snapshot and the click takes over position 0 and would be clicked as if
    // it were the recorded one.
    const page = makePage(tree([{ backendId: 86, role: 'button', name: 'Submit order' }]));
    await generateSnapshot(page, { format: 'ai' });
    (page as unknown as FakePage).liveCounts.set('button Submit order', 2);

    await expect(
      resolveRef(page, '0', { strictCount: true }),
    ).rejects.toBeInstanceOf(StaleRefError);
    expect((page as unknown as FakePage).handles).toEqual([]);
  });

  it('leaves an unnamed ref alone even under strictCount', async () => {
    // No name filter means the locator counts named siblings too, so the two
    // numbers are not comparable at all — strictness there is just a wrong
    // answer, not a stricter one.
    const page = makePage(tree([{ backendId: 87, role: 'button', name: '' }]));
    await generateSnapshot(page, { format: 'ai' });
    (page as unknown as FakePage).liveCounts.set('button ', 4);

    expect(await resolveRef(page, '0', { strictCount: true })).toBe('button #0');
  });

  it('still resolves the right instance while the page is unchanged', async () => {
    const page = makePage(
      tree([
        { backendId: 80, role: 'button', name: 'Row' },
        { backendId: 81, role: 'button', name: 'Row' },
      ]),
    );
    await generateSnapshot(page, { format: 'ai' });
    (page as unknown as FakePage).liveCounts.set('button Row', 2);

    expect(await resolveRef(page, '1')).toBe('button Row#1');
  });
});

describe('auto-diff survives a DOM change now that refs hold still', () => {
  it('adopts the diff when one node is inserted into a large page', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      backendId: 100 + i,
      role: 'link',
      name: `Item ${i}`,
    }));
    const page = makePage(tree(rows));

    const before = await generateSnapshot(page, { format: 'ai' });

    (page as unknown as FakePage).nodes = tree([
      { backendId: 999, role: 'button', name: 'Inserted' },
      ...rows,
    ]);
    const after = await generateSnapshot(page, { format: 'ai' });

    const rendered = formatSnapshotResult(before, after);
    expect(rendered.usedDiff).toBe(true);
    expect(rendered.text).toContain('+ ');
    expect(rendered.text).toContain('Inserted');
    // Untouched rows are omitted, which is the whole point of the diff.
    expect(rendered.text).not.toContain('Item 30');
  });
});
