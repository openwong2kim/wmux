import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot, resolveRef, StaleRefError, isFrameRef } from '../snapshot';
import { browserScopeKey, noteFrameRefsForScope } from '../snapshot';
import { sanitizeRef } from '../tools/interaction';

// Frame-aware refs (B2). browser_snapshot used to stop at the iframe element
// and every ref resolved through page.getByRole(), which searches the main
// frame only — so a payment or login widget was an invisible dead end.
//
// The harness below is the same fake-Page shape the other snapshot tests use,
// grown a fake DOM domain (querySelectorAll / describeNode / getFullAXTree by
// frameId) and a fake Playwright frame tree, because the graft cross-checks
// what CDP enumerates against what a locator enumerates.

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
  backendId: number;
  role: string;
  name: string;
}

/** Root plus one node per entry. `Iframe` roles are how a frame is hosted. */
function tree(children: Child[]): CdpNode[] {
  const nodes: CdpNode[] = [
    {
      nodeId: 'root',
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

interface FakeDoc {
  frameId: string;
  url: string;
  ax: CdpNode[];
  /** `<iframe>` elements in document order. */
  iframes: FakeIframe[];
  /** false = out-of-process: no contentDocument on the host session. */
  sameProcess?: boolean;
  /** Simulates a frame whose contentFrame() resolves to nothing. */
  detached?: boolean;
}

interface FakeIframe {
  /** The backendNodeId of the `<iframe>` element, i.e. its AX node's id. */
  backendId: number;
  src: string;
  doc: FakeDoc;
}

function doc(init: Partial<FakeDoc> & { frameId: string }): FakeDoc {
  return {
    url: `https://example.test/${init.frameId}`,
    ax: tree([]),
    iframes: [],
    sameProcess: true,
    ...init,
  };
}

/** Every document reachable from `main`, keyed by frameId. */
function flatten(main: FakeDoc, out = new Map<string, FakeDoc>()): Map<string, FakeDoc> {
  out.set(main.frameId, main);
  for (const f of main.iframes) if (!out.has(f.doc.frameId)) flatten(f.doc, out);
  return out;
}

interface Harness {
  page: Parameters<typeof generateSnapshot>[0];
  /** Live getByRole counts, keyed `frameId|role name`. */
  counts: Map<string, number>;
  /** Handles handed back by resolveRef, in order. */
  handles: string[];
  main: FakeDoc;
}

function makeHarness(main: FakeDoc): Harness {
  const counts = new Map<string, number>();
  const handles: string[] = [];

  // Document nodeIds are synthesised per frame; iframe element nodeIds per slot.
  const docNodeId = (frameId: string) => `doc:${frameId}`;
  const iframeNodeId = (frameId: string, i: number) => `if:${frameId}:${i}`;
  const byDocNodeId = () => {
    const map = new Map<string, FakeDoc>();
    for (const d of flatten(main).values()) map.set(docNodeId(d.frameId), d);
    return map;
  };

  function roleRoot(frameId: string) {
    return {
      getByRole: (r: string, opts?: { name?: string }) => {
        const key = `${frameId}|${r} ${opts?.name ?? ''}`;
        const count = counts.get(key) ?? 1;
        return {
          count: async () => count,
          nth: (i: number) => ({
            elementHandle: async () => {
              const handle = `${key}#${i}`;
              handles.push(handle);
              return handle as never;
            },
          }),
        };
      },
    };
  }

  function frameHandle(d: FakeDoc): unknown {
    return {
      url: () => d.url,
      locator: (sel: string) => frameLocator(d, sel),
      ...roleRoot(d.frameId),
    };
  }

  function frameLocator(host: FakeDoc, _sel: string) {
    return {
      count: async () => host.iframes.length,
      nth: (i: number) => ({
        elementHandle: async () => {
          const slot = host.iframes[i];
          if (!slot) return null;
          return {
            contentFrame: async () => (slot.doc.detached ? null : frameHandle(slot.doc)),
          };
        },
      }),
    };
  }

  const send = vi.fn(async (method: string, params?: any) => {
    if (method === 'Accessibility.getFullAXTree') {
      const target = params?.frameId
        ? flatten(main).get(params.frameId)
        : main;
      if (!target) throw new Error('no such frame');
      // An out-of-process frame does not answer on the host session.
      if (params?.frameId && target.sameProcess === false) throw new Error('oopif');
      return { nodes: target.ax };
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: docNodeId(main.frameId) } };
    if (method === 'DOM.querySelectorAll') {
      const host = byDocNodeId().get(params?.nodeId);
      if (!host) return { nodeIds: [] };
      return { nodeIds: host.iframes.map((_, i) => iframeNodeId(host.frameId, i)) };
    }
    if (method === 'DOM.describeNode') {
      const [, frameId, index] = String(params?.nodeId).split(':');
      const host = flatten(main).get(frameId);
      const slot = host?.iframes[Number(index)];
      if (!slot) return {};
      return {
        node: {
          backendNodeId: slot.backendId,
          frameId: slot.doc.frameId,
          attributes: ['src', slot.src],
          ...(slot.doc.sameProcess === false
            ? {}
            : { contentDocument: { nodeId: docNodeId(slot.doc.frameId) } }),
        },
      };
    }
    return {};
  });

  const page = {
    url: () => main.url,
    context: () => ({
      newCDPSession: async (target?: unknown) => {
        // An OOPIF session answers getFullAXTree for its own document only.
        const owner = [...flatten(main).values()].find(
          (d) => d.sameProcess === false && (target as { url?: () => string })?.url?.() === d.url,
        );
        if (owner) {
          return {
            send: vi.fn(async (method: string) => {
              if (method === 'Accessibility.getFullAXTree') return { nodes: owner.ax };
              if (method === 'DOM.getDocument') return { root: { nodeId: docNodeId(owner.frameId) } };
              if (method === 'DOM.querySelectorAll') {
                return { nodeIds: owner.iframes.map((_, i) => iframeNodeId(owner.frameId, i)) };
              }
              return {};
            }),
            detach: vi.fn(() => Promise.resolve()),
          };
        }
        return { send, detach: vi.fn(() => Promise.resolve()) };
      },
    }),
    evaluate: vi.fn(async () => ''),
    locator: (sel: string) => frameLocator(main, sel),
    ...roleRoot(main.frameId),
  };

  return { page: page as never, counts, handles, main };
}

/** The `<iframe>` AX node plus the document it hosts. */
function hostedFrame(backendId: number, child: FakeDoc, src = child.url): FakeIframe {
  return { backendId, src, doc: child };
}

// ---------------------------------------------------------------------------

describe('a page with no frames is byte-for-byte what it was', () => {
  it('mints the same refs and emits no frame machinery', async () => {
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 10, role: 'button', name: 'OK' },
          { backendId: 11, role: 'link', name: 'Docs' },
        ]),
      }),
    );

    const out = await generateSnapshot(h.page, { format: 'ai' });
    expect(out).toContain('button "OK" ref="0"');
    expect(out).toContain('link "Docs" ref="1"');
    expect(out).not.toContain('separate document');
    expect(isFrameRef(h.page, '0')).toBe(false);
    // Resolution still roots at the page, so the handle names the main frame.
    expect(await resolveRef(h.page, '0')).toBe('main|button OK#0');
  });
});

describe('same-process frames are grafted', () => {
  function twoIdenticalFrames() {
    const inner = () =>
      doc({
        frameId: 'f',
        url: 'https://widget.test/pay',
        ax: tree([{ backendId: 500, role: 'button', name: 'Submit' }]),
      });
    const a = { ...inner(), frameId: 'fa' };
    const b = { ...inner(), frameId: 'fb' };
    return makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 20, role: 'Iframe', name: 'pay one' },
          { backendId: 21, role: 'Iframe', name: 'pay two' },
        ]),
        iframes: [hostedFrame(20, a), hostedFrame(21, b)],
      }),
    );
  }

  it('gives two identical frames two different refs (review ⑫)', async () => {
    const h = twoIdenticalFrames();
    const out = await generateSnapshot(h.page, { format: 'ai' });

    // Both frames hold a `Submit` with the SAME backendDOMNodeId — the id space
    // is per document, so a flat map would have collapsed them into one ref.
    expect(out).toContain('button "Submit" ref="0"');
    expect(out).toContain('button "Submit" ref="1"');
    // Both really came from inside the frames, not from the host document.
    expect(out.match(/button "Submit"/g)).toHaveLength(2);
    expect(out).toContain('Iframe "pay one"');
    expect(out).not.toContain('separate document');
    expect(isFrameRef(h.page, '0')).toBe(true);
    expect(isFrameRef(h.page, '1')).toBe(true);
  });

  it('resolves each ref inside its own frame, at index 0 in both', async () => {
    const h = twoIdenticalFrames();
    await generateSnapshot(h.page, { format: 'ai' });

    // Counted per frame: each frame has exactly one Submit, so both refs are
    // index 0. A page-wide population would have made the second one index 1
    // and sent the resolver looking for a Submit its frame does not have.
    expect(await resolveRef(h.page, '0')).toBe('fa|button Submit#0');
    expect(await resolveRef(h.page, '1')).toBe('fb|button Submit#0');
  });

  it('keeps backendId-colliding nodes apart across frames', async () => {
    const h = twoIdenticalFrames();
    await generateSnapshot(h.page, { format: 'ai' });
    const again = await generateSnapshot(h.page, { format: 'ai' });
    // Stable across snapshots, and still two numbers rather than one.
    expect(again).toContain('ref="0"');
    expect(again).toContain('ref="1"');
    expect(again).not.toContain('ref="2"');
  });
});

describe('a frame ref fails closed when the route stops matching', () => {
  function oneFrame(extra?: Partial<FakeDoc>) {
    const child = doc({
      frameId: 'f1',
      url: 'https://widget.test/login',
      ax: tree([{ backendId: 77, role: 'button', name: 'Sign in' }]),
      ...extra,
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([{ backendId: 30, role: 'Iframe', name: 'login' }]),
        iframes: [hostedFrame(30, child)],
      }),
    );
    return { h, child };
  }

  it('rejects when the host document gained an iframe', async () => {
    const { h } = oneFrame();
    await generateSnapshot(h.page, { format: 'ai' });

    // A second frame appeared without a fresh snapshot: index 0 of 1 is not
    // index 0 of 2, so the positional route no longer names one frame.
    h.main.iframes.push(hostedFrame(31, doc({ frameId: 'f2' })));

    await expect(resolveRef(h.page, '0')).rejects.toBeInstanceOf(StaleRefError);
    await expect(resolveRef(h.page, '0')).rejects.toThrow(/iframe/);
    expect(h.handles).toEqual([]);
  });

  it('rejects when the frame no longer has a reachable document', async () => {
    const { h, child } = oneFrame();
    await generateSnapshot(h.page, { format: 'ai' });
    child.detached = true;

    await expect(resolveRef(h.page, '0')).rejects.toThrow(/reachable document/);
    expect(h.handles).toEqual([]);
  });

  it('rejects a ref in a frame that navigated on its own (review ⑬)', async () => {
    const childA = doc({
      frameId: 'fa',
      url: 'https://widget.test/one',
      ax: tree([{ backendId: 77, role: 'button', name: 'Go' }]),
    });
    const childB = doc({
      frameId: 'fb',
      url: 'https://widget.test/two',
      ax: tree([{ backendId: 78, role: 'button', name: 'Stay' }]),
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 40, role: 'Iframe', name: 'one' },
          { backendId: 41, role: 'Iframe', name: 'two' },
        ]),
        iframes: [hostedFrame(40, childA), hostedFrame(41, childB)],
      }),
    );
    await generateSnapshot(h.page, { format: 'ai' });

    // The page URL is untouched — only frame one moved. Nothing at page level
    // can see this, which is why the hop re-reads frame.url() live.
    childA.url = 'https://widget.test/somewhere-else';

    await expect(resolveRef(h.page, '0')).rejects.toThrow(/navigated on its own/);
    // The untouched frame's ref still works: staleness is per frame.
    expect(await resolveRef(h.page, '1')).toBe('fb|button Stay#0');
  });
});

describe('the frame walk is bounded', () => {
  /** A chain of `depth` nested frames, each holding one button. */
  function nested(depth: number): FakeDoc {
    let current = doc({
      frameId: `n${depth}`,
      url: `https://n.test/${depth}`,
      ax: tree([{ backendId: 900 + depth, role: 'button', name: `Deep ${depth}` }]),
    });
    for (let level = depth - 1; level >= 1; level--) {
      const host = doc({
        frameId: `n${level}`,
        url: `https://n.test/${level}`,
        ax: tree([{ backendId: 800 + level, role: 'Iframe', name: `nest ${level}` }]),
        iframes: [hostedFrame(800 + level, current)],
      });
      current = host;
    }
    return current;
  }

  it('stops at the depth cap and says so', async () => {
    const chain = nested(8);
    const h = makeHarness({ ...chain, frameId: 'main', url: 'https://example.test/a' });
    const out = await generateSnapshot(h.page, { format: 'ai' });

    // Five hops of content, then a named stop rather than a silent one.
    expect(out).toContain('Iframe "nest 5"');
    expect(out).toContain('nested deeper than 5 frames');
    expect(out).not.toContain('button "Deep 8"');
  });

  it('does not follow a frame twice', async () => {
    // Two <iframe> slots pointing at ONE document: a page can do this, and a
    // naive walk would graft the same nodes under both hosts.
    const shared = doc({
      frameId: 'shared',
      url: 'https://widget.test/shared',
      ax: tree([{ backendId: 600, role: 'button', name: 'Once' }]),
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 50, role: 'Iframe', name: 'a' },
          { backendId: 51, role: 'Iframe', name: 'b' },
        ]),
        iframes: [hostedFrame(50, shared), hostedFrame(51, shared)],
      }),
    );
    const out = await generateSnapshot(h.page, { format: 'ai' });

    expect(out.match(/button "Once"/g)?.length).toBe(1);
    expect(out).toContain('could not be attached');
  });
});

describe('serialisation keeps a frame visible either way', () => {
  it('keeps a read-but-empty frame under the interactive filter', async () => {
    const empty = doc({
      frameId: 'fe',
      url: 'https://widget.test/empty',
      ax: tree([]),
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 60, role: 'Iframe', name: 'banner' },
          { backendId: 61, role: 'button', name: 'OK' },
        ]),
        iframes: [hostedFrame(60, empty)],
      }),
    );

    const out = await generateSnapshot(h.page, { format: 'ai', filter: 'interactive' });
    expect(out).toContain('Iframe "banner"');
    // Read and empty is a different fact from "contents withheld".
    expect(out).toContain('read, no content in it');
    expect(out).toContain('button "OK"');
  });

  it('keeps frame refs resolvable after the overflow re-serialisation', async () => {
    const child = doc({
      frameId: 'fc',
      url: 'https://widget.test/form',
      ax: tree([{ backendId: 700, role: 'button', name: 'Pay' }]),
    });
    // Enough main-frame text to blow a tiny budget and force the strip+retry,
    // which re-serialises the ORIGINAL tree — the graft has to be in it.
    const filler = Array.from({ length: 60 }, (_, i) => ({
      backendId: 300 + i,
      role: 'StaticText',
      name: `Lorem ipsum dolor sit amet ${i}`,
    }));
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([...filler, { backendId: 70, role: 'Iframe', name: 'checkout' }]),
        iframes: [hostedFrame(70, child)],
      }),
    );

    const out = await generateSnapshot(h.page, { format: 'ai', maxLength: 400 });
    expect(out).toContain('button "Pay"');
    const ref = out.match(/button "Pay" ref="(\d+)"/)?.[1];
    expect(ref).toBeDefined();
    expect(isFrameRef(h.page, ref!)).toBe(true);
    expect(await resolveRef(h.page, ref!)).toBe('fc|button Pay#0');
  });
});

describe('a cross-origin frame is read over its own session', () => {
  it('grafts an out-of-process frame the host session cannot serve', async () => {
    const oopif = doc({
      frameId: 'oop',
      url: 'https://other-origin.test/consent',
      ax: tree([{ backendId: 800, role: 'button', name: 'Accept' }]),
      sameProcess: false,
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([{ backendId: 80, role: 'Iframe', name: 'consent' }]),
        iframes: [hostedFrame(80, oopif)],
      }),
    );

    const out = await generateSnapshot(h.page, { format: 'ai' });
    expect(out).toContain('button "Accept" ref="0"');
    expect(await resolveRef(h.page, '0')).toBe('oop|button Accept#0');
  });
});

describe('a frame cannot spend the whole snapshot, or reach the DOM fallback', () => {
  it('cuts a chatty frame at its own share and drops the refs it lost', async () => {
    const loud = doc({
      frameId: 'fl',
      url: 'https://ads.test/unit',
      ax: tree(
        Array.from({ length: 40 }, (_, i) => ({
          backendId: 1000 + i,
          role: 'button',
          name: `Advert action number ${i}`,
        })),
      ),
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 90, role: 'Iframe', name: 'ad' },
          { backendId: 91, role: 'button', name: 'Checkout' },
        ]),
        iframes: [hostedFrame(90, loud)],
      }),
    );

    const out = await generateSnapshot(h.page, { format: 'ai', maxLength: 1000 });

    expect(out).toContain('(frame content truncated)');
    // The host document's own control is what the caller asked about, and it
    // survives — the failure this cap exists to prevent is the frame pushing
    // it past the truncation point.
    expect(out).toContain('button "Checkout"');
    // Fewer than the 40 the frame holds, and every ref the output DID print is
    // still a live ref — a ref for a line the agent cannot see is a ref it
    // cannot have meant to use, so those are dropped with their lines.
    const printed = [...out.matchAll(/button "Advert action number \d+" ref="(\d+)"/g)].map(
      (m) => m[1],
    );
    expect(printed.length).toBeGreaterThan(0);
    expect(printed.length).toBeLessThan(40);
    for (const ref of printed) expect(isFrameRef(h.page, ref)).toBe(true);
  });

  it('shares one pool across sibling frames, so the host survives all three', async () => {
    // The bug a per-frame allowance hides: three siblings at 40% EACH is 120%
    // of the budget, and the host document is squeezed out by exactly the case
    // the cap exists to prevent.
    const loud = (id: string) =>
      doc({
        frameId: id,
        url: `https://ads.test/${id}`,
        ax: tree(
          Array.from({ length: 30 }, (_, i) => ({
            backendId: Number(`${id.charCodeAt(1)}${i}`),
            role: 'button',
            name: `${id} advert action number ${i}`,
          })),
        ),
      });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 91, role: 'Iframe', name: 'ad one' },
          { backendId: 92, role: 'Iframe', name: 'ad two' },
          { backendId: 93, role: 'Iframe', name: 'ad three' },
          { backendId: 94, role: 'button', name: 'Checkout' },
        ]),
        iframes: [
          hostedFrame(91, loud('a1')),
          hostedFrame(92, loud('a2')),
          hostedFrame(93, loud('a3')),
        ],
      }),
    );

    const maxLength = 2000;
    const out = await generateSnapshot(h.page, { format: 'ai', maxLength });

    // The host document's own control is what the caller asked about.
    expect(out).toContain('button "Checkout"');
    expect(out).not.toContain('... (truncated)');

    // Frame content, summed over all three, stays inside the single 40% pool.
    const frameBytes = out
      .split('\n')
      .filter((l) => /advert action number/.test(l))
      .reduce((n, l) => n + l.length, 0);
    expect(frameBytes).toBeLessThanOrEqual(Math.floor(maxLength * 0.4));

    // And the pool really was shared: the later siblings were cut, not each
    // handed a fresh allowance.
    expect(out).toContain('(frame content truncated)');
  });

  it('lets a nested frame spend only what its parent has not', async () => {
    const inner = doc({
      frameId: 'in',
      url: 'https://ads.test/inner',
      ax: tree(
        Array.from({ length: 25 }, (_, i) => ({
          backendId: 2000 + i,
          role: 'button',
          name: `Inner advert action number ${i}`,
        })),
      ),
    });
    const outer = doc({
      frameId: 'out',
      url: 'https://ads.test/outer',
      ax: tree([
        ...Array.from({ length: 25 }, (_, i) => ({
          backendId: 3000 + i,
          role: 'button',
          name: `Outer advert action number ${i}`,
        })),
        { backendId: 3900, role: 'Iframe', name: 'nested ad' },
      ]),
      iframes: [hostedFrame(3900, inner)],
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([
          { backendId: 96, role: 'Iframe', name: 'ad' },
          { backendId: 97, role: 'button', name: 'Checkout' },
        ]),
        iframes: [hostedFrame(96, outer)],
      }),
    );

    const maxLength = 2000;
    const out = await generateSnapshot(h.page, { format: 'ai', maxLength });

    expect(out).toContain('button "Checkout"');
    // Both levels draw on one counter, so the total is still inside the pool —
    // the nested frame's bytes are not billed twice, and not billed free.
    const frameBytes = out
      .split('\n')
      .filter((l) => /advert action number/.test(l))
      .reduce((n, l) => n + l.length, 0);
    expect(frameBytes).toBeLessThanOrEqual(Math.floor(maxLength * 0.4));
    expect(frameBytes).toBeGreaterThan(0);
  });

  it('refuses a frame ref on the RPC data-attr lane', async () => {
    const child = doc({
      frameId: 'fr',
      url: 'https://widget.test/rpc',
      ax: tree([{ backendId: 950, role: 'button', name: 'Pay now' }]),
    });
    const h = makeHarness(
      doc({
        frameId: 'main',
        ax: tree([{ backendId: 95, role: 'Iframe', name: 'pay' }]),
        iframes: [hostedFrame(95, child)],
      }),
    );
    const out = await generateSnapshot(h.page, { format: 'ai' });
    const ref = out.match(/button "Pay now" ref="(\d+)"/)?.[1];
    expect(ref).toBeDefined();

    // sanitizeRef is the one gate every [data-wmux-ref] resolution in the tool
    // layer passes through, and data-wmux-ref only ever tags the main
    // document — so a frame ref there matches nothing, or worse, matches an
    // unrelated element a previous DOM snapshot tagged with that number.
    const scope = { workspaceId: 'w1', surfaceId: 's1' };
    noteFrameRefsForScope(browserScopeKey(scope), h.page);
    expect(() => sanitizeRef(ref!, scope)).toThrow(/minted inside an iframe/);
    expect(() => sanitizeRef('4242', scope)).not.toThrow();

    // A different surface is untouched: its own DOM refs stay resolvable no
    // matter what numbers this one happens to hold.
    const other = { workspaceId: 'w1', surfaceId: 's2' };
    expect(() => sanitizeRef(ref!, other)).not.toThrow();

    // And the surface is cleared once a route that mints no frame refs runs
    // for it — a DOM listing's tags are then the current truth.
    noteFrameRefsForScope(browserScopeKey(scope), null);
    expect(() => sanitizeRef(ref!, scope)).not.toThrow();
  });
});
