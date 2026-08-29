import { describe, expect, it, vi } from 'vitest';
import { generateScopedSnapshot, resolveRef } from '../snapshot';

// browser_snapshot's `selector` used to run DOM-side unconditionally, even with
// a live Page and a healthy a11y tree. That listing is layout-blind — it mints
// refs for elements that are not rendered, and every click on one of those timed
// out (dogfood P0) — and it cannot produce `format:"aria"` at all. Scoping now
// goes through the accessibility tree, resolving the selector to the
// backendNodeId the two CDP domains share, and falls back to the DOM listing
// only when that cannot be done.

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
  ignored?: boolean;
}

const role = (value: string) => ({ type: 'role', value });
const name = (value: string) => ({ type: 'computedString', value });

// RootWebArea → ignored wrapper → nav / banner / main, with a "Docs" link both
// inside nav and inside main so scope-sensitive ref resolution is observable.
const PAGE: CdpNode[] = [
  { nodeId: '1', backendDOMNodeId: 1, role: role('RootWebArea'), name: name('Page'), childIds: ['2'] },
  { nodeId: '2', backendDOMNodeId: 2, role: role('none'), ignored: true, childIds: ['20', '30', '10'] },
  { nodeId: '20', backendDOMNodeId: 20, role: role('navigation'), name: name('Site'), childIds: ['21'] },
  { nodeId: '21', backendDOMNodeId: 21, role: role('link'), name: name('Docs'), childIds: [] },
  { nodeId: '30', backendDOMNodeId: 30, role: role('banner'), name: name('Masthead'), childIds: ['31'] },
  { nodeId: '31', backendDOMNodeId: 31, role: role('paragraph'), name: name('Tagline'), childIds: [] },
  { nodeId: '10', backendDOMNodeId: 10, role: role('main'), name: name('Content'), childIds: ['11', '12', '13'] },
  { nodeId: '11', backendDOMNodeId: 11, role: role('heading'), name: name('Title'), childIds: [] },
  { nodeId: '12', backendDOMNodeId: 12, role: role('link'), name: name('Docs'), childIds: [] },
  { nodeId: '13', backendDOMNodeId: 13, role: role('button'), name: name('Save'), childIds: [] },
];

// selector → backendNodeId. Anything absent is a CDP "no match" (nodeId 0).
const SELECTORS: Record<string, number> = {
  main: 10,
  nav: 20,
  header: 30,
  '#wrap': 2,
  'span.detached': 99, // matches in the DOM but has no node in the a11y tree
};

function makePage(opts: { nodes?: CdpNode[]; noSession?: boolean } = {}) {
  const sends: string[] = [];
  const client = {
    send: vi.fn(async (method: string, params?: { selector?: string; nodeId?: number }) => {
      sends.push(method);
      switch (method) {
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } };
        case 'DOM.querySelector': {
          const backendId = SELECTORS[params?.selector ?? ''];
          // The fake reuses the backendNodeId as the nodeId; 0 means no match.
          return { nodeId: backendId ?? 0 };
        }
        case 'DOM.describeNode':
          return { node: { backendNodeId: params?.nodeId } };
        case 'Accessibility.getFullAXTree':
          return { nodes: opts.nodes ?? PAGE };
        default:
          return {};
      }
    }),
    detach: vi.fn(() => Promise.resolve()),
  };
  const page = {
    context: () => ({
      newCDPSession: async () => {
        if (opts.noSession) throw new Error('Target closed');
        return client;
      },
    }),
    evaluate: vi.fn(async () => 'DOM-FALLBACK'),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
  return { page, client, sends };
}

describe('generateScopedSnapshot — a11y-scoped selector snapshots', () => {
  it('returns the matched element and its subtree, with subtree-relative refs', async () => {
    const { page } = makePage();
    const out = await generateScopedSnapshot(page as never, 'main', { format: 'ai' });

    // The matched element is content, not a container — it stays in the output.
    expect(out).toBe(
      [
        '- main "Content"',
        '  - heading "Title"',
        '  - link "Docs" ref="0"',
        '  - button "Save" ref="1"',
      ].join('\n'),
    );
    // Nothing outside the scope leaked in.
    expect(out).not.toContain('navigation');
    expect(out).not.toContain('banner');
    // No DOM listing was needed.
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('renders format:"aria" for a scoped selector (previously always refused)', async () => {
    const { page } = makePage();
    const out = await generateScopedSnapshot(page as never, 'nav', { format: 'aria' });

    expect(out).toBe(['- navigation "Site"', '  - link "Docs"'].join('\n'));
    expect(out).not.toContain('ref=');
  });

  it('applies filter:"interactive" within the scope', async () => {
    const { page } = makePage();
    const out = await generateScopedSnapshot(page as never, 'main', {
      format: 'ai',
      filter: 'interactive',
    });

    expect(out).toBe(
      ['- main "Content"', '  - link "Docs" ref="0"', '  - button "Save" ref="1"'].join('\n'),
    );
    expect(out).not.toContain('heading');
  });

  it('says so when the scope holds no interactive elements, instead of dumping it', async () => {
    const { page } = makePage();
    const out = await generateScopedSnapshot(page as never, 'header', {
      format: 'ai',
      filter: 'interactive',
    });

    expect(out).toBe('(no interactive elements in this subtree)');
  });

  it('scopes to an ignored wrapper by returning the children spliced into its place', async () => {
    const { page } = makePage();
    const out = await generateScopedSnapshot(page as never, '#wrap', { format: 'aria' });

    // The wrapper itself is not a node any more, but it is still addressable.
    expect(out).not.toContain('none');
    expect(out?.split('\n')[0]).toBe('- navigation "Site"');
    expect(out).toContain('- main "Content"');
  });
});

describe('generateScopedSnapshot — fail-open to the DOM listing', () => {
  it('returns null when the selector matches nothing (the DOM path owns that error)', async () => {
    const { page } = makePage();
    expect(await generateScopedSnapshot(page as never, '.nope', { format: 'ai' })).toBeNull();
  });

  it('returns null when the element has no node in the a11y tree', async () => {
    const { page } = makePage();
    expect(
      await generateScopedSnapshot(page as never, 'span.detached', { format: 'ai' }),
    ).toBeNull();
  });

  it('returns null when the page yields no CDP session', async () => {
    const { page } = makePage({ noSession: true });
    expect(await generateScopedSnapshot(page as never, 'main', { format: 'ai' })).toBeNull();
  });

  it('returns null when the a11y tree has collapsed to the root', async () => {
    const { page } = makePage({
      nodes: [
        { nodeId: '1', backendDOMNodeId: 1, role: role('RootWebArea'), name: name('Page'), childIds: [] },
      ],
    });
    expect(await generateScopedSnapshot(page as never, 'main', { format: 'ai' })).toBeNull();
  });

  it('resolves the selector before fetching the tree, and always tears the session down', async () => {
    const { page, sends, client } = makePage();
    await generateScopedSnapshot(page as never, '.nope', { format: 'ai' });

    // A miss costs one DOM round-trip, not a full-tree fetch.
    expect(sends).not.toContain('Accessibility.getFullAXTree');
    expect(client.detach).toHaveBeenCalled();
  });
});

describe('resolveRef after a scoped snapshot', () => {
  it('counts same-role matches inside the scope, not page-wide', async () => {
    const { page } = makePage();
    const handle = { __handle: true };
    const nth = vi.fn(() => ({ elementHandle: async () => handle }));
    const scopedRoot = {
      getByRole: vi.fn(() => ({ count: async () => 1, nth })),
    };
    const locator = vi.fn(() => ({ first: () => scopedRoot }));
    (page as unknown as { locator: unknown }).locator = locator;

    await generateScopedSnapshot(page as never, 'main', { format: 'ai' });
    const res = await resolveRef(page as never, '0');

    expect(res).toBe(handle);
    // The scope element is the search root — page.getByRole would have counted
    // the identical nav "Docs" link that the selector deliberately excluded.
    expect(locator).toHaveBeenCalledWith('main');
    expect(scopedRoot.getByRole).toHaveBeenCalledWith('link', { name: 'Docs', exact: true });
    expect(page.getByRole).not.toHaveBeenCalled();
  });
});
