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

  it('still returns the snapshot when the occlusion probe fails', async () => {
    const { page } = makePage(FORM_TREE, { occlusionThrows: true });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(out).toContain('textbox "Password" ref="1" focused');
    expect(out).toContain('button "Sign in" ref="2"');
    expect(out).not.toContain('overlay');
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
