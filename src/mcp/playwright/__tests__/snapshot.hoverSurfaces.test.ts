import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HoverCandidate, HoverProbeOutcome, HoverSurfaceMark } from '../hoverSurfaces';
import type { OcclusionInfo } from '../occlusion';

// The a11y lane's rendering of hoverSurfaces: the marker, the `expanded`
// precedence, the occlusion exclusion and the footer line. The scan itself runs
// in the page (hoverSurfaces.scan.test.ts) and the probe drives CDP
// (hoverSurfaces.probe.test.ts); what is under test here is only what the tree
// says about their results.

let scanned: HoverCandidate[] = [];
let probeOutcome: HoverProbeOutcome | null = null;
let probedWith: HoverCandidate[] | null = null;
let released = 0;

vi.mock('../hoverSurfaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hoverSurfaces')>();
  return {
    ...actual,
    collectHoverTriggers: async () => ({
      candidates: scanned,
      note: 'found' as const,
      release: async () => {
        released += 1;
      },
    }),
    probeHoverSurfaces: async (_client: unknown, candidates: readonly HoverCandidate[]) => {
      probedWith = candidates.slice();
      return probeOutcome ?? { revealed: new Map(), cancelled: false, probed: 0, unanswered: 0 };
    },
  };
});

let occlusion: OcclusionInfo | null = null;
vi.mock('../occlusion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../occlusion')>();
  return { ...actual, collectOcclusion: async () => occlusion };
});

// Page facts come from an in-page evaluation a mock page cannot serve; the
// footer line under test is appended beside them, not by them.
vi.mock('../pageFacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pageFacts')>()),
  collectPageFacts: async () => null,
}));

import { generateScopedSnapshot, generateSnapshot } from '../snapshot';

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: { name: string; value: { type: string; value: unknown } }[];
  childIds?: string[];
}

/** RootWebArea + a plain link, an open menu button, and a nav link. */
function navTree(): CdpNode[] {
  return [
    {
      nodeId: '1',
      backendDOMNodeId: 1,
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'name', value: 'Home' },
      childIds: ['2', '3', '4'],
    },
    {
      nodeId: '2',
      backendDOMNodeId: 2,
      role: { type: 'role', value: 'link' },
      name: { type: 'name', value: 'Products' },
      childIds: [],
    },
    {
      nodeId: '3',
      backendDOMNodeId: 3,
      role: { type: 'role', value: 'button' },
      name: { type: 'name', value: 'Account' },
      properties: [{ name: 'expanded', value: { type: 'booleanOrUndefined', value: true } }],
      childIds: [],
    },
    {
      nodeId: '4',
      backendDOMNodeId: 4,
      role: { type: 'role', value: 'link' },
      name: { type: 'name', value: 'Contact' },
      childIds: [],
    },
  ];
}

/** `scopeBackendId` is what a selector resolves to on the scoped path. */
function makePage(nodes: CdpNode[], scopeBackendId = 1) {
  const send = vi.fn(async (method: string) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes };
    if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
    if (method === 'DOM.querySelector') return { nodeId: 101 };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: scopeBackendId } };
    if (method === 'Accessibility.getPartialAXTree') return { nodes };
    return {};
  });
  return {
    context: () => ({ newCDPSession: async () => ({ send, detach: vi.fn(async () => undefined) }) }),
    evaluate: vi.fn(async () => null),
    url: () => 'https://x.test/',
    viewportSize: () => ({ width: 1280, height: 800 }),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
}

function trigger(backendNodeId: number, score = 5): HoverCandidate {
  return {
    objectId: `o-${backendNodeId}`,
    anchorObjectId: `a-${backendNodeId}`,
    backendNodeId,
    score,
    targets: [],
  };
}

function mark(items: string[], over: Partial<HoverSurfaceMark> = {}): HoverSurfaceMark {
  return { items, truncated: false, staysOpen: false, ...over };
}

beforeEach(() => {
  scanned = [];
  probeOutcome = null;
  probedWith = null;
  released = 0;
  occlusion = null;
});

describe('snapshot: the has-submenu marker', () => {
  it('marks the trigger the scan found, and only it', async () => {
    scanned = [trigger(2)];
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });

    expect(out).toMatch(/- link "Products" ref="\d+" has-submenu/);
    expect(out).toMatch(/- link "Contact" ref="\d+"$/m);
  });

  it('[precedence] leaves an already-expanded node saying expanded, not has-submenu', async () => {
    // The menu is OPEN: its items are already in the tree, so telling the agent
    // to hover for them would send it after what it can see.
    scanned = [trigger(3)];
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });

    // The line itself, not the whole output: the footer's offer of the flag
    // names the marker too.
    const line = out.split('\n').find((l) => l.includes('"Account"')) ?? '';
    expect(line).toContain('expanded="true"');
    expect(line).not.toContain('has-submenu');
  });

  it('marks a collapsed disclosure — expanded="false" is exactly the case', async () => {
    const nodes = navTree();
    nodes[2].properties = [{ name: 'expanded', value: { type: 'booleanOrUndefined', value: false } }];
    scanned = [trigger(3)];
    const out = await generateSnapshot(makePage(nodes) as never, { format: 'ai' });

    expect(out).toMatch(/- button "Account".*expanded="false".*has-submenu/);
  });

  it('says nothing at all when the scan found nothing', async () => {
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });
    expect(out).not.toContain('has-submenu');
    expect(out).not.toContain('hover menus:');
  });

  it('releases the scan handles whether or not it probed', async () => {
    scanned = [trigger(2)];
    await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });
    expect(released).toBe(1);
  });

  it('marks in a scoped snapshot too — a selector on a nav is the whole point', async () => {
    scanned = [trigger(2)];
    const out = await generateScopedSnapshot(makePage(navTree(), 2) as never, 'nav', {
      format: 'ai',
    });
    expect(out).toContain('has-submenu');
  });
});

describe('snapshot: hover triggers under an overlay', () => {
  const overlay = (reachable: number[]): OcclusionInfo => ({
    layer: 'div#backdrop',
    blockedCount: 12,
    reachable: new Set(reachable),
    truncated: false,
  });

  it('[exclusion] does not mark a trigger the overlay is covering', async () => {
    occlusion = overlay([4]);
    scanned = [trigger(2)];
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });

    expect(out).toContain('is covering the page');
    expect(out).not.toContain('has-submenu');
  });

  it('still marks a trigger that IS reachable in front of the overlay', async () => {
    occlusion = overlay([2]);
    scanned = [trigger(2)];
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });
    expect(out).toContain('has-submenu');
  });

  it('never runs the probe while an overlay is up', async () => {
    occlusion = overlay([2]);
    scanned = [trigger(2)];
    await generateSnapshot(makePage(navTree()) as never, { format: 'ai', probeHover: true });
    expect(probedWith).toBeNull();
  });
});

describe('snapshot: the probe on the line', () => {
  it('lists the items the probe saw', async () => {
    scanned = [trigger(2)];
    probeOutcome = {
      revealed: new Map([[2, mark(['Docs', 'API', 'Pricing'])]]),
      cancelled: false,
      probed: 1,
      unanswered: 0,
    };
    const out = await generateSnapshot(makePage(navTree()) as never, {
      format: 'ai',
      probeHover: true,
    });

    expect(out).toContain('[hover first: Docs | API | Pricing]');
    expect(out).toContain('has-submenu');
    expect(probedWith?.map((c) => c.backendNodeId)).toEqual([2]);
  });

  it('[precedence] does not list items for a surface that is already open', async () => {
    // Node 3 reports expanded="true": whatever the probe saw is already in the
    // tree as this node's children, so pointing at it would send the agent
    // hovering for what it can read.
    scanned = [trigger(3)];
    probeOutcome = { revealed: new Map([[3, mark(['Docs'])]]), cancelled: false, probed: 1, unanswered: 0 };
    const out = await generateSnapshot(makePage(navTree()) as never, {
      format: 'ai',
      probeHover: true,
    });

    const line = out.split('\n').find((l) => l.includes('"Account"')) ?? '';
    expect(line).toContain('expanded="true"');
    expect(line).not.toContain('hover first');
    expect(line).not.toContain('has-submenu');
  });

  it('keeps the marker and adds nothing when the probe revealed nothing', async () => {
    scanned = [trigger(2)];
    probeOutcome = { revealed: new Map(), cancelled: false, probed: 1, unanswered: 0 };
    const out = await generateSnapshot(makePage(navTree()) as never, {
      format: 'ai',
      probeHover: true,
    });

    expect(out).toContain('has-submenu');
    expect(out).not.toContain('hover first');
  });

  it('[CRITICAL] says which triggers it has no items for, rather than leaving them bare', async () => {
    // A marked line with nothing after it reads as an empty menu. The probe is
    // bounded by a wall clock it does not control, so running out is normal —
    // and has to be said.
    scanned = [trigger(2), trigger(4)];
    probeOutcome = {
      revealed: new Map([[2, mark(['Docs'])]]),
      cancelled: false,
      probed: 1,
      unanswered: 1,
    };
    const out = await generateSnapshot(makePage(navTree()) as never, {
      format: 'ai',
      probeHover: true,
    });

    expect(out.split('\n')[0]).toContain('no items for 1 marked trigger within the time budget');
    expect(out).toContain('[hover first: Docs]');
  });

  it('stays quiet when the probe answered for every trigger', async () => {
    scanned = [trigger(2)];
    probeOutcome = {
      revealed: new Map([[2, mark(['Docs'])]]),
      cancelled: false,
      probed: 1,
      unanswered: 0,
    };
    const out = await generateSnapshot(makePage(navTree()) as never, {
      format: 'ai',
      probeHover: true,
    });
    expect(out).not.toContain('hover probe:');
  });

  it('does not probe unless asked', async () => {
    scanned = [trigger(2)];
    await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });
    expect(probedWith).toBeNull();
  });
});

describe('snapshot: the hover footer line', () => {
  it('offers the flag when phase 1 found triggers and the probe was not asked for', async () => {
    scanned = [trigger(2), trigger(4)];
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });
    expect(out).toContain(
      'hover menus: 2 triggers marked has-submenu; pass probeHover:true to list their items',
    );
  });

  it('[CRITICAL] counts what the TREE shows, not what the scan found', async () => {
    // Node 3 is a trigger the scan picked up, but the tree suppresses its marker
    // because it already reports expanded="true". A footer taken from the mark
    // map would promise two triggers over a tree showing one.
    scanned = [trigger(2), trigger(3)];
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });

    expect(out.split('\n').filter((l) => l.includes('has-submenu')).length).toBe(2);
    expect(out).toContain('hover menus: 1 triggers marked has-submenu');
  });

  it('stays quiet once the probe has run — the items are on the lines above', async () => {
    scanned = [trigger(2)];
    probeOutcome = { revealed: new Map([[2, mark(['Docs'])]]), cancelled: false, probed: 1, unanswered: 0 };
    const out = await generateSnapshot(makePage(navTree()) as never, {
      format: 'ai',
      probeHover: true,
    });
    expect(out).not.toContain('hover menus:');
  });

  it('never appears on a scoped snapshot, which carries no footer at all', async () => {
    scanned = [trigger(2)];
    const out = await generateScopedSnapshot(makePage(navTree()) as never, 'nav', { format: 'ai' });
    expect(out).not.toContain('hover menus:');
  });

  it('[fix] leads the result, so windowing a long page cannot lose it', async () => {
    // It was a trailer first, and on a 3030-line page it landed in the last
    // cursor window — an agent reading the top of the tree never saw it (live
    // dogfood, 2026-09-18). It now sits with the other leading notes.
    scanned = [trigger(2), trigger(4)];
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai' });
    expect(out.split('\n')[0]).toBe(
      'hover menus: 2 triggers marked has-submenu; pass probeHover:true to list their items',
    );
  });

  it('[CRITICAL] survives a truncating maxLength, and does not blow the tree budget', async () => {
    scanned = [trigger(2), trigger(4)];
    const maxLength = 120;
    const out = await generateSnapshot(makePage(navTree()) as never, { format: 'ai', maxLength });
    const note = out.split('\n')[0];
    expect(note).toContain('hover menus:');
    // Leading notes sit outside the caller's budget — the same contract `q` and
    // `filter` already have — and the tree below still honours it.
    const body = out.slice(note.length + 1);
    expect(body.length).toBeLessThanOrEqual(maxLength + '\n... (truncated)'.length);
  });
});
