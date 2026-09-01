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

function makePage(nodes: CdpNode[], url = 'https://example.test/a') {
  const page = {
    nodes,
    currentUrl: url,
    url: () => page.currentUrl,
    title: async () => 'Page',
    innerText: async () => 'body text',
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
    mockSendRpc.mockResolvedValue({
      value: {
        url: 'https://example.test/a',
        title: 'Page',
        content: 'body text',
        elements: ROWS.map((row, i) => ({ ref: i + 1, role: row.role, name: row.name })),
      },
    });

    expect((await snapshot()).startsWith('[snapshot: full]')).toBe(true);
    // Second identical call: the CDP lane would answer "no changes" here.
    const second = await snapshot();
    expect(second.startsWith('[snapshot: full]')).toBe(true);
    expect(second).toContain('Item 30');
  });
});
