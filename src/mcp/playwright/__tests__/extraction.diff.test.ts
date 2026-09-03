import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: getPage,
      drainLocalLifecycle: () => [],
    }),
  },
}));

import { registerExtractionTools } from '../tools/extraction';
import { clearElementCache } from '../dom-intelligence';
import { invalidateSnapshotBaseline } from '../snapshotCache';
import { withSnapshotListingCapture } from '../snapshotListing';

// browser_smart_snapshot's auto-diff. Refs are keyed on DOM node identity on
// the Playwright/CDP lane (dom-intelligence.refstability.test.ts), which is
// what makes a diff worth returning at all; the RPC lane still numbers by walk
// position, so it never diffs.

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function smartSnapshotTool(): ToolHandler {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerExtractionTools(server as never, browserToolDeps);
  const tool = tools.get('browser_smart_snapshot');
  if (!tool) throw new Error('browser_smart_snapshot failed to register');
  return tool;
}

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

/** Root plus one interactive child per entry, backend ids fixed per child. */
function tree(children: { backendId: number; role: string; name: string }[]): CdpNode[] {
  const nodes: CdpNode[] = [
    {
      nodeId: '1',
      backendDOMNodeId: 1,
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'name', value: 'Page' },
      childIds: children.map((c) => String(c.backendId)),
    },
  ];
  for (const child of children) {
    nodes.push({
      nodeId: String(child.backendId),
      backendDOMNodeId: child.backendId,
      role: { type: 'role', value: child.role },
      name: { type: 'name', value: child.name },
      childIds: [],
    });
  }
  return nodes;
}

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  backendId: 100 + i,
  role: 'link',
  name: `Item ${i}`,
}));

function makePage(nodes: CdpNode[], url = 'https://example.test/a', body = 'body text') {
  const listeners: ((frame: unknown) => void)[] = [];
  const mainFrame = { id: 'main' };
  const page = {
    nodes,
    currentUrl: url,
    body,
    url: () => page.currentUrl,
    title: async () => 'Page',
    innerText: async () => page.body,
    on: (event: string, fn: (frame: unknown) => void) => {
      if (event === 'framenavigated') listeners.push(fn);
    },
    mainFrame: () => mainFrame,
    /** Fire a main-frame navigation the way Playwright would. */
    navigate: () => {
      for (const fn of listeners) fn(mainFrame);
    },
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string) =>
          method === 'Accessibility.getFullAXTree' ? { nodes: page.nodes } : {},
        ),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    locator: vi.fn(),
    getByRole: vi.fn(),
  };
  return page;
}

function rpcPayload(url = 'https://example.test/a') {
  return {
    value: {
      url,
      title: 'Page',
      content: 'body text',
      elements: ROWS.map((row, i) => ({ ref: i + 1, role: row.role, name: row.name })),
    },
  };
}

const tool = smartSnapshotTool();

async function snapshot(args: Record<string, unknown> = {}): Promise<string> {
  const result = await tool({ surfaceId: 'surf-1', ...args });
  expect(result.isError).toBeUndefined();
  return result.content[0].text;
}

beforeEach(() => {
  mockSendRpc.mockReset();
  getPage.mockReset();
  clearElementCache();
  invalidateSnapshotBaseline('ws-test', 'surf-1');
});

describe('browser_smart_snapshot auto-diff (CDP lane)', () => {
  it('returns the full listing first and a diff on the repeat call', async () => {
    const page = makePage(tree(ROWS));
    getPage.mockResolvedValue(page);

    const first = await snapshot();
    expect(first.startsWith('[snapshot: full]')).toBe(true);
    expect(first).toContain('Item 30');

    page.nodes = tree([{ backendId: 999, role: 'button', name: 'Inserted' }, ...ROWS]);
    const second = await snapshot();

    expect(second.startsWith('[snapshot: diff vs previous')).toBe(true);
    expect(second).toContain('+ ');
    expect(second).toContain('Inserted');
    // The untouched rows are omitted, which is the whole point.
    expect(second).not.toContain('Item 30');
  });

  it('says so, rather than going quiet, when nothing changed', async () => {
    const page = makePage(tree(ROWS));
    getPage.mockResolvedValue(page);

    await snapshot();
    expect(await snapshot()).toContain('(no changes since previous snapshot)');
  });

  it('falls back to the full listing when the page navigated', async () => {
    const page = makePage(tree(ROWS));
    getPage.mockResolvedValue(page);
    await snapshot();

    page.currentUrl = 'https://example.test/b';
    const after = await snapshot();

    // The URL guard: a diff against a page that no longer exists is never
    // valid, however small it would have been.
    expect(after.startsWith('[snapshot: full]')).toBe(true);
    expect(after).toContain('Item 30');
  });

  it('honours full:true and still refreshes the baseline', async () => {
    const page = makePage(tree(ROWS));
    getPage.mockResolvedValue(page);
    await snapshot();

    const forced = await snapshot({ full: true });
    expect(forced.startsWith('[snapshot: full]')).toBe(true);
    expect(forced).toContain('Item 30');

    // full:true opts one call out of the diff; it does not switch it off.
    expect(await snapshot()).toContain('(no changes since previous snapshot)');
  });

  it('does not diff across a different maxContentLength', async () => {
    const page = makePage(tree(ROWS));
    getPage.mockResolvedValue(page);
    await snapshot();

    const other = await snapshot({ maxContentLength: 500 });
    expect(other.startsWith('[snapshot: full]')).toBe(true);
  });
});

describe('browser_smart_snapshot auto-diff (RPC lane)', () => {
  it('always returns the full listing while refs are positional', async () => {
    getPage.mockResolvedValue(null);
    mockSendRpc.mockResolvedValue(rpcPayload());

    expect((await snapshot()).startsWith('[snapshot: full]')).toBe(true);
    // Second identical call: the CDP lane would answer "no changes" here.
    const second = await snapshot();
    expect(second.startsWith('[snapshot: full]')).toBe(true);
    expect(second).toContain('Item 30');
  });

  it('does not leave a baseline the CDP lane will diff against', async () => {
    // The two lanes number their refs differently, so a positional listing is
    // not a baseline an identity listing may be compared with. The lane marker
    // in the attrs key is what keeps them apart.
    getPage.mockResolvedValue(null);
    mockSendRpc.mockResolvedValue(rpcPayload());
    await snapshot();

    getPage.mockResolvedValue(makePage(tree(ROWS)));
    const onCdp = await snapshot();

    expect(onCdp.startsWith('[snapshot: full]')).toBe(true);
    expect(onCdp).toContain('Item 30');
  });
});

describe('a diff never crosses a document or a page', () => {
  it('returns the full listing after a reload of the same URL', async () => {
    const page = makePage(tree(ROWS));
    getPage.mockResolvedValue(page);
    await snapshot();

    // Same URL, new document: the URL guard sees nothing, and the new
    // document's low backendDOMNodeIds take the old document's refs.
    page.navigate();
    const after = await snapshot();

    expect(after.startsWith('[snapshot: full]')).toBe(true);
    expect(after).not.toContain('no changes');
  });

  it('returns the full listing for a second tab on the same URL', async () => {
    getPage.mockResolvedValue(makePage(tree(ROWS)));
    await snapshot();

    // A different page, same surface key and same URL — identical text, and
    // "(no changes since previous snapshot)" would be about a page this call
    // never compared against.
    getPage.mockResolvedValue(makePage(tree(ROWS)));
    const other = await snapshot();

    expect(other.startsWith('[snapshot: full]')).toBe(true);
    expect(other).toContain('Item 30');
  });
});

describe('the complete listing on the side channel', () => {
  it('publishes every element even on the call that returns a diff', async () => {
    const page = makePage(tree(ROWS));
    getPage.mockResolvedValue(page);
    await snapshot();

    page.nodes = tree([{ backendId: 999, role: 'button', name: 'Inserted' }, ...ROWS]);
    const captured = await withSnapshotListingCapture(() => snapshot());

    // The text is the diff; the listing is what full:true would have returned,
    // which is what browser_repl parses its refs from (snapshotListing.ts).
    expect(captured.result.startsWith('[snapshot: diff vs previous')).toBe(true);
    expect(captured.result).not.toContain('Item 30');
    expect(captured.listing).toBeDefined();
    expect(captured.listing).toContain('Item 30');
    expect(captured.listing).toContain('Inserted');
    // The header belongs to the rendering, not the listing.
    expect(captured.listing?.startsWith('[snapshot:')).toBe(false);
  });

  it('costs nothing when no capture is active', async () => {
    getPage.mockResolvedValue(makePage(tree(ROWS)));
    expect((await snapshot()).startsWith('[snapshot: full]')).toBe(true);
  });
});

describe('a truncated page text says the diff is partial', () => {
  it('notes the cap when it answers with a diff', async () => {
    const page = makePage(tree(ROWS), 'https://example.test/a', 'x'.repeat(5000));
    getPage.mockResolvedValue(page);
    await snapshot({ maxContentLength: 20 });

    const second = await snapshot({ maxContentLength: 20 });
    expect(second).toContain('(no changes since previous snapshot)');
    expect(second).toContain('page text is capped at 20 characters');
  });

  it('stays quiet when nothing was cut', async () => {
    getPage.mockResolvedValue(makePage(tree(ROWS)));
    await snapshot();
    expect(await snapshot()).not.toContain('page text is capped');
  });
});
