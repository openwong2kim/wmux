import { describe, expect, it, vi } from 'vitest';
import { generateScopedSnapshot, generateSnapshot } from '../snapshot';

// Snapshot information density: focus, iframe boundaries, and "an overlay is
// covering the page". Each of the three is an EXCEPTION marker — it appears
// only when the value differs from the boring default — so most of what these
// tests assert is what does NOT appear. Same fake-Page harness as
// snapshot.filter.test.ts, extended with the CDP calls the occlusion probe
// makes.

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
}

const FORM_TREE: CdpNode[] = [
  { nodeId: '1', backendDOMNodeId: 1, role: { type: 'role', value: 'RootWebArea' }, name: { type: 'name', value: 'Sign in' }, childIds: ['2', '3', '4'] },
  { nodeId: '2', backendDOMNodeId: 2, role: { type: 'role', value: 'textbox' }, name: { type: 'name', value: 'Email' }, childIds: [] },
  {
    nodeId: '3',
    backendDOMNodeId: 3,
    role: { type: 'role', value: 'textbox' },
    name: { type: 'name', value: 'Password' },
    properties: [{ name: 'focused', value: { type: 'booleanOrUndefined', value: true } }],
    childIds: [],
  },
  { nodeId: '4', backendDOMNodeId: 4, role: { type: 'role', value: 'button' }, name: { type: 'name', value: 'Sign in' }, childIds: [] },
];

const FRAME_TREE: CdpNode[] = [
  { nodeId: '1', backendDOMNodeId: 1, role: { type: 'role', value: 'RootWebArea' }, name: { type: 'name', value: 'Host' }, childIds: ['2', '3', '4'] },
  { nodeId: '2', backendDOMNodeId: 2, role: { type: 'role', value: 'button' }, name: { type: 'name', value: 'Host button' }, childIds: [] },
  // Chrome hands back an <iframe> as a childless node — the frame's own
  // document is a separate getFullAXTree call — which is what makes the
  // boundary marker necessary.
  { nodeId: '3', backendDOMNodeId: 3, role: { type: 'role', value: 'Iframe' }, name: { type: 'name', value: 'Checkout widget' }, childIds: [] },
  { nodeId: '4', backendDOMNodeId: 4, role: { type: 'role', value: 'paragraph' }, name: { type: 'name', value: 'after' }, childIds: [] },
];

/** What the in-page occlusion probe resolved to, in CDP remote-object shape. */
interface OverlayResult {
  label: string | null;
  blockedCount?: number;
  /** backendNodeIds of the controls that still receive clicks. */
  reachable?: number[];
  /** Override reachableCount to exercise the too-many-to-mark branch. */
  reachableCount?: number;
  /**
   * backendNodeId of the layer element itself. Omitted models the ordinary
   * case where the backdrop has no a11y node to describe.
   */
  layerBackendId?: number;
}

function makePage(
  nodes: CdpNode[],
  opts: { overlay?: OverlayResult; occlusionThrows?: boolean } = {},
) {
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes };

    if (method === 'Runtime.evaluate') {
      if (opts.occlusionThrows) throw new Error('Runtime domain unavailable');
      if (!opts.overlay) return { result: {} };
      return { result: { objectId: 'overlay-result' } };
    }

    if (method === 'Runtime.getProperties') {
      const overlay = opts.overlay;
      if (!overlay) return { result: [] };
      const reachable = overlay.reachable ?? [];
      if (params?.objectId === 'overlay-result') {
        return {
          result: [
            { name: 'label', value: { value: overlay.label } },
            { name: 'blockedCount', value: { value: overlay.blockedCount ?? 0 } },
            { name: 'reachableCount', value: { value: overlay.reachableCount ?? reachable.length } },
            { name: 'reachable', value: { objectId: 'overlay-reachable' } },
            ...(overlay.layerBackendId === undefined
              ? []
              : [{ name: 'layerEl', value: { objectId: `el-${overlay.layerBackendId}` } }]),
          ],
        };
      }
      if (params?.objectId === 'overlay-reachable') {
        return {
          result: [
            ...reachable.map((backendId, i) => ({ name: String(i), value: { objectId: `el-${backendId}` } })),
            { name: 'length', value: { value: reachable.length } },
          ],
        };
      }
      return { result: [] };
    }

    if (method === 'DOM.describeNode') {
      const objectId = params?.objectId;
      if (typeof objectId === 'string' && objectId.startsWith('el-')) {
        return { node: { backendNodeId: Number(objectId.slice(3)) } };
      }
      // The selector-scoping path describes a DOM nodeId instead.
      return { node: { backendNodeId: 1 } };
    }

    if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
    if (method === 'DOM.querySelector') return { nodeId: 101 };

    return {};
  });

  const client = { send, detach: vi.fn(() => Promise.resolve()) };
  return {
    page: {
      context: () => ({ newCDPSession: async () => client }),
      evaluate: vi.fn(async () => ''),
      getByRole: vi.fn(),
      locator: vi.fn(),
    },
    send,
  };
}

describe('snapshot: focus', () => {
  it('marks the focused node and leaves every other node unmarked', async () => {
    const { page } = makePage(FORM_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('textbox "Password" ref="1" focused');
    expect(out).toContain('textbox "Email" ref="0"');
    expect(out.match(/focused/g)).toHaveLength(1);
  });

  it('says nothing when no node has focus', async () => {
    const unfocused = FORM_TREE.map((n) => ({ ...n, properties: undefined }));
    const { page } = makePage(unfocused);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).not.toContain('focused');
  });

  it('carries focus through the interactive filter', async () => {
    const { page } = makePage(FORM_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai', filter: 'interactive' });

    expect(out).toContain('focused');
    expect(out).not.toContain('RootWebArea');
  });
});

describe('snapshot: iframe boundaries', () => {
  it('names the boundary at the iframe node', async () => {
    const { page } = makePage(FRAME_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('Iframe "Checkout widget" (separate document — contents not in this snapshot)');
  });

  it('keeps the boundary under filter:"interactive"', async () => {
    const { page } = makePage(FRAME_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai', filter: 'interactive' });

    // The frame's own controls are not in this tree, so dropping the iframe
    // line would read as "no such button on this page".
    expect(out).toContain('Iframe "Checkout widget"');
    expect(out).toContain('separate document');
    expect(out).not.toContain('paragraph');
  });

  it('adds nothing to a page without iframes', async () => {
    const { page } = makePage(FORM_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).not.toContain('separate document');
  });

  it('stays quiet about an iframe whose contents ARE in the tree', async () => {
    // Chrome 141 always stops at the iframe element, but the note claims the
    // contents are absent — so it has to be tied to the node really being a
    // dead end, not to the role alone.
    const inlined: CdpNode[] = [
      { nodeId: '1', backendDOMNodeId: 1, role: { type: 'role', value: 'RootWebArea' }, name: { type: 'name', value: 'Host' }, childIds: ['3'] },
      { nodeId: '3', backendDOMNodeId: 3, role: { type: 'role', value: 'Iframe' }, name: { type: 'name', value: 'Checkout widget' }, childIds: ['5'] },
      { nodeId: '5', backendDOMNodeId: 5, role: { type: 'role', value: 'button' }, name: { type: 'name', value: 'Pay' }, childIds: [] },
    ];
    const { page } = makePage(inlined);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('button "Pay"');
    expect(out).not.toContain('separate document');
  });
});

describe('snapshot: overlay occlusion', () => {
  it('notes the overlay and marks only the controls that still receive clicks', async () => {
    const { page } = makePage(FORM_TREE, {
      overlay: { label: 'div#backdrop', blockedCount: 2, reachable: [4] },
    });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('(note: an overlay (div#backdrop) is covering the page — 2 on-screen controls behind it will not receive clicks');
    expect(out).toContain('button "Sign in" ref="2" clickable');
    // The covered controls carry no marker: the note already explains them,
    // and marking the covered side would flip most of the tree on every modal.
    expect(out).toContain('textbox "Email" ref="0"');
    expect(out.match(/clickable/g)).toHaveLength(2); // the note's word plus one mark
  });

  it('marks nothing and says nothing when no overlay is up', async () => {
    const { page } = makePage(FORM_TREE, { overlay: { label: null } });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).not.toContain('overlay');
    expect(out).not.toContain('clickable');
  });

  it('drops the per-control promise when too many controls are reachable', async () => {
    const { page } = makePage(FORM_TREE, {
      overlay: { label: 'div#veil', blockedCount: 3, reachable: [4], reachableCount: 500 },
    });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('(note: an overlay (div#veil) is covering the page — 3 on-screen controls behind it will not receive clicks)');
    expect(out).not.toContain('clickable');
  });

  it('marks a reachable node whose role is outside INTERACTIVE_ROLES', async () => {
    // The probe's selector is wider than INTERACTIVE_ROLES (`[role]`,
    // `[onclick]`, `[tabindex]`, `summary`), so gating the mark on the ref-able
    // roles would leave a genuinely clickable node unmarked while the note
    // asserts that unmarked means unreachable.
    const withGeneric: CdpNode[] = [
      ...FORM_TREE,
      { nodeId: '5', backendDOMNodeId: 5, role: { type: 'role', value: 'generic' }, name: { type: 'name', value: 'Dismiss' }, childIds: [] },
    ];
    withGeneric[0] = { ...withGeneric[0], childIds: ['2', '3', '4', '5'] };
    const { page } = makePage(withGeneric, {
      overlay: { label: 'div#backdrop', blockedCount: 3, reachable: [5] },
    });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('generic "Dismiss" clickable');
  });

  it('charges the overlay note against maxLength', async () => {
    // The note carries a page-controlled layer label, so leaving it outside the
    // budget would let the page decide how far past the caller's cap the result
    // runs.
    const { page } = makePage(FORM_TREE, {
      overlay: { label: 'div#' + 'a'.repeat(200), blockedCount: 2, reachable: [4] },
    });
    const maxLength = 300;
    const out = await generateSnapshot(page as never, { format: 'ai', maxLength });

    // The truncation marker is the one thing allowed past the cap (unchanged
    // pre-existing behaviour).
    expect(out.length).toBeLessThanOrEqual(maxLength + '\n... (truncated)'.length);
    expect(out).toContain('(note: an overlay (');
    // ...and the label itself was capped before it ever reached the note.
    expect(out.match(/a{100,}/)?.[0].length).toBeLessThanOrEqual(120);
  });

  it('marks the layer the note names, so the two can be connected', async () => {
    // The note knew `div#backdrop`; the tree said nothing about which node
    // that was, and there is no selector to look it up with.
    const withLayer: CdpNode[] = [
      ...FORM_TREE,
      { nodeId: '9', backendDOMNodeId: 9, role: { type: 'role', value: 'generic' }, childIds: [] },
    ];
    withLayer[0] = { ...withLayer[0], childIds: ['2', '3', '4', '9'] };
    const { page } = makePage(withLayer, {
      overlay: { label: 'div#backdrop', blockedCount: 2, reachable: [4], layerBackendId: 9 },
    });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('(note: an overlay (div#backdrop) is covering the page');
    expect(out).toContain('- generic overlay');
    // Exactly one node is the layer.
    expect(out.match(/^\s*- .* overlay$/gm)).toHaveLength(1);
  });

  it('marks the layer even when there are too many reachable controls to mark', async () => {
    const withLayer: CdpNode[] = [
      ...FORM_TREE,
      { nodeId: '9', backendDOMNodeId: 9, role: { type: 'role', value: 'generic' }, childIds: [] },
    ];
    withLayer[0] = { ...withLayer[0], childIds: ['2', '3', '4', '9'] };
    const { page } = makePage(withLayer, {
      overlay: { label: 'div#veil', blockedCount: 3, reachable: [4], reachableCount: 500, layerBackendId: 9 },
    });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('- generic overlay');
    expect(out).not.toContain('clickable');
  });

  it('stays silent about the layer when it has no a11y node of its own', async () => {
    // The ordinary case: a bare backdrop <div> Chrome ignores. Fail-open —
    // the note still stands, nothing in the tree is marked.
    const { page } = makePage(FORM_TREE, {
      overlay: { label: 'div#backdrop', blockedCount: 2, reachable: [4] },
    });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('an overlay (div#backdrop) is covering the page');
    expect(out.match(/^\s*- .* overlay$/gm)).toBeNull();
  });

  it('still returns the snapshot when the occlusion probe fails', async () => {
    const { page } = makePage(FORM_TREE, { occlusionThrows: true });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('textbox "Password" ref="1" focused');
    expect(out).toContain('button "Sign in" ref="2"');
    expect(out).not.toContain('overlay');
  });
});

// Chrome stacks a StaticText and an InlineTextBox under every piece of visible
// text, so `<h1>Dogfood page</h1>` costs three lines to say one thing. The 'ai'
// format drops the repetition; 'aria' keeps the whole tree.
const TEXT_TREE: CdpNode[] = [
  { nodeId: '1', backendDOMNodeId: 1, role: { type: 'role', value: 'RootWebArea' }, name: { type: 'name', value: 'Dogfood page' }, childIds: ['2', '5', '8', '12'] },
  // heading → StaticText → InlineTextBox, all saying the same thing.
  { nodeId: '2', backendDOMNodeId: 2, role: { type: 'role', value: 'heading' }, name: { type: 'name', value: 'Dogfood page' }, childIds: ['3'] },
  { nodeId: '3', backendDOMNodeId: 3, role: { type: 'role', value: 'StaticText' }, name: { type: 'name', value: 'Dogfood page' }, childIds: ['4'] },
  { nodeId: '4', backendDOMNodeId: 4, role: { type: 'role', value: 'InlineTextBox' }, name: { type: 'name', value: 'Dogfood page' }, childIds: [] },
  // A link whose accumulated name is the two pieces joined: neither piece is
  // the name, and which piece sits where is information.
  { nodeId: '5', backendDOMNodeId: 5, role: { type: 'role', value: 'link' }, name: { type: 'name', value: 'A B' }, childIds: ['6', '7'] },
  { nodeId: '6', backendDOMNodeId: 6, role: { type: 'role', value: 'StaticText' }, name: { type: 'name', value: 'A' }, childIds: [] },
  { nodeId: '7', backendDOMNodeId: 7, role: { type: 'role', value: 'StaticText' }, name: { type: 'name', value: 'B' }, childIds: [] },
  // Wrapped body text: the InlineTextBoxes are line fragments of the parent.
  { nodeId: '8', backendDOMNodeId: 8, role: { type: 'role', value: 'paragraph' }, childIds: ['9'] },
  { nodeId: '9', backendDOMNodeId: 9, role: { type: 'role', value: 'StaticText' }, name: { type: 'name', value: 'long wrapped text' }, childIds: ['10', '11'] },
  { nodeId: '10', backendDOMNodeId: 10, role: { type: 'role', value: 'InlineTextBox' }, name: { type: 'name', value: 'long wrapped ' }, childIds: [] },
  { nodeId: '11', backendDOMNodeId: 11, role: { type: 'role', value: 'InlineTextBox' }, name: { type: 'name', value: 'text' }, childIds: [] },
  { nodeId: '12', backendDOMNodeId: 12, role: { type: 'role', value: 'button' }, name: { type: 'name', value: 'Save' }, childIds: ['13'] },
  { nodeId: '13', backendDOMNodeId: 13, role: { type: 'role', value: 'StaticText' }, name: { type: 'name', value: 'Save' }, childIds: [] },
];

describe('snapshot: duplicated text lines', () => {
  it('drops InlineTextBox and the StaticText that only echoes its parent', async () => {
    const { page } = makePage(TEXT_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).not.toContain('InlineTextBox');
    // `heading "Dogfood page"` and `button "Save"` each said it once already.
    expect(out).toContain('- heading "Dogfood page"');
    expect(out).toContain('- button "Save" ref="1"');
    expect(out.match(/Dogfood page/g)).toHaveLength(1);
    expect(out.match(/Save/g)).toHaveLength(1);
  });

  it('keeps StaticText that is not just the parent name repeated', async () => {
    const { page } = makePage(TEXT_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    // Pieces of an accumulated name: substrings, but the split is signal.
    expect(out).toContain('- link "A B" ref="0"');
    expect(out).toContain('- StaticText "A"');
    expect(out).toContain('- StaticText "B"');
    // The paragraph has no name of its own, so its text is the only copy.
    expect(out).toContain('- StaticText "long wrapped text"');
  });

  it('keeps a StaticText that carries an annotation of its own', async () => {
    // The drop is decided against the line the child produced, so anything
    // that makes the line more than the parent's name keeps it.
    const focusedEcho = TEXT_TREE.map((n) =>
      n.nodeId === '13'
        ? { ...n, properties: [{ name: 'focused', value: { type: 'booleanOrUndefined', value: true } }] }
        : n,
    );
    const { page } = makePage(focusedEcho);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('- StaticText "Save" focused');
  });

  it('leaves ref numbering untouched — only non-interactive lines go', async () => {
    const { page } = makePage(TEXT_TREE);
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('link "A B" ref="0"');
    expect(out).toContain('button "Save" ref="1"');
    expect(out.match(/ref="\d+"/g)).toHaveLength(2);
  });

  it('keeps the full tree for aria — that format\'s contract is everything', async () => {
    const { page } = makePage(TEXT_TREE);
    const out = await generateSnapshot(page as never, { format: 'aria' });

    expect(out).toContain('- InlineTextBox "long wrapped "');
    expect(out).toContain('- InlineTextBox "text"');
    expect(out.match(/Dogfood page/g)).toHaveLength(3);
  });

  it('condenses inside a selector scope too', async () => {
    const { page } = makePage(TEXT_TREE);
    // DOM.querySelector → nodeId 101 → describeNode → backendNodeId 1.
    const out = await generateScopedSnapshot(page as never, 'body', { format: 'ai' });

    expect(out).not.toContain('InlineTextBox');
    expect(out?.match(/Dogfood page/g)).toHaveLength(2); // the RootWebArea name + the heading
  });
});

describe('generateScopedSnapshot: density annotations', () => {
  it('annotates focus and occlusion inside a selector scope', async () => {
    const { page } = makePage(FORM_TREE, {
      overlay: { label: 'div#backdrop', blockedCount: 2, reachable: [4] },
    });
    // DOM.querySelector → nodeId 101 → describeNode → backendNodeId 1, the
    // RootWebArea, whose subtree is the whole form.
    const out = await generateScopedSnapshot(page as never, 'form', { format: 'ai' });

    expect(out).toContain('an overlay (div#backdrop) is covering the page');
    expect(out).toContain('focused');
    expect(out).toContain('clickable');
  });

  it('marks the iframe boundary inside a selector scope', async () => {
    const { page } = makePage(FRAME_TREE);
    const out = await generateScopedSnapshot(page as never, 'main', { format: 'ai' });

    expect(out).toContain('Iframe "Checkout widget" (separate document — contents not in this snapshot)');
  });
});
