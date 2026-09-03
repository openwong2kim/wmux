import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot, listRefEntries, getRefEntry } from '../snapshot';
import { MAX_CONTEXT_CHARS } from '../../../shared/browserReplay/actionTrace';

// The ancestor context a RefEntry carries (#1182). The replay runner compares
// it against the recorded one so a same-count swap of same-name elements stops
// instead of clicking a look-alike; what it needs from here is that the value
// names the nearest MEANINGFUL container and nothing else. Same fake-Page
// harness as snapshot.refstability.test.ts.

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'name', value });

function node(id: number, r: string, n: string, children: number[] = []): CdpNode {
  return {
    nodeId: String(id),
    backendDOMNodeId: id,
    role: role(r),
    name: name(n),
    childIds: children.map(String),
  };
}

function makePage(nodes: CdpNode[]) {
  const page = {
    nodes,
    url: () => 'https://example.test/checkout',
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
  };
  return page as unknown as Parameters<typeof generateSnapshot>[0];
}

describe('RefEntry.context', () => {
  it('names the section each same-name button sits in', async () => {
    // Two `button "Submit order"` — the #1182 shape. Nothing in the 4-tuple
    // tells them apart; the section name does.
    const page = makePage([
      node(1, 'RootWebArea', 'Checkout', [2, 4]),
      node(2, 'region', 'Express checkout', [3]),
      node(3, 'button', 'Submit order'),
      node(4, 'region', 'Saved carts', [5]),
      node(5, 'button', 'Submit order'),
    ]);

    await generateSnapshot(page, { format: 'ai' });
    const entries = listRefEntries(page as never);
    expect(entries.map((e) => e.context)).toEqual([
      'region "Express checkout"',
      'region "Saved carts"',
    ]);
  });

  it('takes the NEAREST named container, so a row beats its table', async () => {
    const page = makePage([
      node(1, 'RootWebArea', 'People', [2]),
      node(2, 'table', 'Members', [3]),
      node(3, 'row', 'Alice Chen', [4]),
      node(4, 'button', 'Delete'),
    ]);

    await generateSnapshot(page, { format: 'ai' });
    expect(listRefEntries(page as never)[0].context).toBe('row "Alice Chen"');
  });

  it('ignores unnamed and non-structural wrappers', async () => {
    // `generic` is markup, not meaning: taking its name (or its place in the
    // tree) would be the DOM-path brittleness the axis refuses.
    const page = makePage([
      node(1, 'RootWebArea', 'Page', [2]),
      node(2, 'generic', 'wrapper', [3]),
      node(3, 'region', '', [4]),
      node(4, 'button', 'Delete'),
    ]);

    await generateSnapshot(page, { format: 'ai' });
    expect(listRefEntries(page as never)[0].context).toBe('');
  });

  it('cannot separate two identical siblings — the residual #1182 leaves open', async () => {
    // Both buttons sit under the same named row, so both carry the same
    // context and the verifier abstains. Nothing short of a positional axis
    // tells these apart, and a positional axis is what this whole design
    // refuses; the replay falls back to the population rules.
    const page = makePage([
      node(1, 'RootWebArea', 'People', [2]),
      node(2, 'row', 'Alice Chen', [3, 4]),
      node(3, 'button', 'Delete'),
      node(4, 'button', 'Delete'),
    ]);

    await generateSnapshot(page, { format: 'ai' });
    const entries = listRefEntries(page as never);
    expect(entries).toHaveLength(2);
    expect(entries[0].context).toBe(entries[1].context);
  });

  it('caps a long container name so the stored and live strings cut alike', async () => {
    const page = makePage([
      node(1, 'RootWebArea', 'Page', [2]),
      node(2, 'region', 'x'.repeat(200), [3]),
      node(3, 'button', 'Delete'),
    ]);

    await generateSnapshot(page, { format: 'ai' });
    const context = listRefEntries(page as never)[0].context;
    expect(context.length).toBe(MAX_CONTEXT_CHARS);
    expect(context.endsWith('…')).toBe(true);
  });

  it('survives filter:interactive and reaches getRefEntry — the recording path', async () => {
    // The recorder reads context off getRefEntry(page, ref) after a snapshot.
    // filter:'interactive' keeps a named container that holds a control, so
    // the context is still stamped on the ref the click records against
    // (the #1182 dogfood path: browser.snapshot({filter:'interactive'})).
    const page = makePage([
      node(1, 'RootWebArea', 'Checkout', [2]),
      node(2, 'region', 'Primary checkout', [3]),
      node(3, 'button', 'Submit order'),
    ]);

    await generateSnapshot(page, { format: 'ai', filter: 'interactive' });
    const entry = listRefEntries(page as never)[0];
    expect(entry.context).toBe('region "Primary checkout"');
    expect(getRefEntry(page as never, String(entry.ref))?.context).toBe('region "Primary checkout"');
  });

  it('inherits the container through a generic wrapper and a text child', async () => {
    // A realistic Chrome shape: region > generic > button, with the button's
    // label carried by a StaticText child. Context must still be the region.
    const page = makePage([
      node(1, 'RootWebArea', 'Checkout', [2]),
      node(2, 'region', 'Express checkout', [3]),
      node(3, 'generic', '', [4]),
      { ...node(4, 'button', 'Submit order', [5]) },
      node(5, 'StaticText', 'Submit order'),
    ]);

    await generateSnapshot(page, { format: 'ai', filter: 'interactive' });
    const button = listRefEntries(page as never).find((e) => e.role === 'button');
    expect(button?.context).toBe('region "Express checkout"');
  });

  it('stays out of the snapshot the agent reads', async () => {
    const page = makePage([
      node(1, 'RootWebArea', 'Page', [2]),
      node(2, 'region', 'Express checkout', [3]),
      node(3, 'button', 'Submit order'),
    ]);

    const text = await generateSnapshot(page, { format: 'ai' });
    expect(text).toContain('button "Submit order"');
    expect(text).not.toContain('context=');
  });
});
