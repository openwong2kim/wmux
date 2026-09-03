import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot, listRefEntries } from '../snapshot';
import { clearElementCache, getSmartSnapshot, smartRefAxisEntry } from '../dom-intelligence';
import { MAX_OWN_CHARS } from '../../../shared/browserReplay/actionTrace';

// RefEntry.own — the element's own identifying attribute, the second
// verify-only signal on the replay axis.
//
// The point the two `describe` blocks below make together is the one that
// matters: BOTH minting lanes read the attributes from the same CDP pass
// through the same helper, so the string a flow recorded on one lane is
// compared against at replay on the other is identical. A value read one way
// here and another there would stop every cross-lane replay it was built to
// pass, which is the same trap ancestorContext was written to avoid.

interface CdpAX {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

interface CdpDom {
  backendNodeId?: number;
  attributes?: string[];
  children?: CdpDom[];
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'name', value });

function ax(id: number, r: string, n: string, children: number[] = []): CdpAX {
  return {
    nodeId: String(id),
    backendDOMNodeId: id,
    role: role(r),
    name: name(n),
    childIds: children.map(String),
  };
}

function dom(backendNodeId: number, attributes: string[]): CdpDom {
  return { backendNodeId, attributes };
}

/**
 * One page both lanes can be pointed at: the same a11y nodes and the same
 * `DOM.getDocument` answer, so any difference in the minted label is the code's
 * and not the fixture's.
 */
function makePage(nodes: CdpAX[], domNodes: CdpDom[]) {
  const page = {
    nodes,
    url: () => 'https://example.test/checkout',
    title: async () => 'Checkout',
    innerText: async () => 'body text',
    on: () => undefined,
    mainFrame: () => ({ id: 'main' }),
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string) => {
          if (method === 'Accessibility.getFullAXTree') return { nodes: page.nodes };
          if (method === 'DOM.getDocument') {
            return { root: { backendNodeId: 0, children: domNodes } };
          }
          return {};
        }),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    evaluate: vi.fn(async () => ''),
    locator: vi.fn(),
    getByRole: vi.fn(),
  };
  return page as never;
}

/** Two `button "Submit order"` in one section, told apart only by a testid. */
const IDENTICAL_SIBLINGS: CdpAX[] = [
  ax(1, 'RootWebArea', 'Checkout', [2]),
  ax(2, 'region', 'Checkout', [3, 4]),
  ax(3, 'button', 'Submit order'),
  ax(4, 'button', 'Submit order'),
];

const SIBLING_ATTRS: CdpDom[] = [
  dom(3, ['data-testid', 'submit-primary', 'class', 'btn btn-lg']),
  dom(4, ['data-testid', 'submit-secondary', 'class', 'btn']),
];

describe('RefEntry.own — the accessibility lane', () => {
  it('separates two identical siblings the context cannot', async () => {
    const page = makePage(IDENTICAL_SIBLINGS, SIBLING_ATTRS);
    await generateSnapshot(page, { format: 'ai' });
    const entries = listRefEntries(page);
    // The context is the same string for both — this is the residual #1185
    // left behind, and `own` is what closes it.
    expect(entries.map((e) => e.context)).toEqual([
      'region "Checkout"',
      'region "Checkout"',
    ]);
    expect(entries.map((e) => e.own)).toEqual([
      'data-testid=submit-primary',
      'data-testid=submit-secondary',
    ]);
  });

  it('prefers data-testid over id, name and aria-label', async () => {
    const page = makePage(
      [ax(1, 'RootWebArea', 'Page', [2]), ax(2, 'button', 'Go')],
      [dom(2, ['aria-label', 'Go now', 'name', 'go', 'id', 'go-btn', 'data-testid', 'go-cta'])],
    );
    await generateSnapshot(page, { format: 'ai' });
    expect(listRefEntries(page)[0].own).toBe('data-testid=go-cta');
  });

  it('leaves an element with none of the four attributes without a label', async () => {
    const page = makePage(
      [ax(1, 'RootWebArea', 'Page', [2]), ax(2, 'button', 'Go')],
      [dom(2, ['class', 'btn'])],
    );
    await generateSnapshot(page, { format: 'ai' });
    // '' and not a guess: an absent label abstains at replay, it never stops.
    expect(listRefEntries(page)[0].own).toBe('');
  });

  it('abstains rather than failing when the DOM pass cannot run', async () => {
    // A page whose CDP session answers nothing but the a11y tree — the
    // best-effort contract getPasswordFieldBackendIds already has.
    const page = makePage(IDENTICAL_SIBLINGS, []);
    await generateSnapshot(page, { format: 'ai' });
    expect(listRefEntries(page).map((e) => e.own)).toEqual(['', '']);
  });

  it('caps a long value at the mint site', async () => {
    const page = makePage(
      [ax(1, 'RootWebArea', 'Page', [2]), ax(2, 'button', 'Go')],
      [dom(2, ['data-testid', 'z'.repeat(MAX_OWN_CHARS * 2)])],
    );
    await generateSnapshot(page, { format: 'ai' });
    expect(listRefEntries(page)[0].own).toHaveLength(MAX_OWN_CHARS);
  });
});

describe('IndexedElement.own — the smart lane mints the identical string', () => {
  it('gives both lanes the same label for the same element', async () => {
    clearElementCache();
    const a11yPage = makePage(IDENTICAL_SIBLINGS, SIBLING_ATTRS);
    await generateSnapshot(a11yPage, { format: 'ai' });
    const fromA11y = listRefEntries(a11yPage).map((e) => e.own);

    const smartPage = makePage(IDENTICAL_SIBLINGS, SIBLING_ATTRS);
    const smart = await getSmartSnapshot(smartPage);
    const fromSmart = smart.elements.map((e) => e.own);

    expect(fromSmart).toEqual(fromA11y);
    expect(fromSmart).toEqual([
      'data-testid=submit-primary',
      'data-testid=submit-secondary',
    ]);
  });

  it('puts the label on the axis a smartRef click records', async () => {
    clearElementCache();
    const page = makePage(IDENTICAL_SIBLINGS, SIBLING_ATTRS);
    const smart = await getSmartSnapshot(page);
    const axis = smartRefAxisEntry(smart.elements[1].ref);
    expect(axis).toMatchObject({
      role: 'button',
      name: 'Submit order',
      context: 'region "Checkout"',
      own: 'data-testid=submit-secondary',
    });
  });

  it('omits the field entirely when the element carries no attribute', async () => {
    clearElementCache();
    const page = makePage(
      [ax(1, 'RootWebArea', 'Page', [2]), ax(2, 'button', 'Go')],
      [dom(2, ['class', 'btn'])],
    );
    const smart = await getSmartSnapshot(page);
    expect(smartRefAxisEntry(smart.elements[0].ref)).not.toHaveProperty('own');
  });
});
