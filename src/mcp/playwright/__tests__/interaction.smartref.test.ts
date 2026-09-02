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
      resolveWorkspaceBackend: async () => 'playwright',
    }),
  },
}));

import { registerInteractionTools } from '../tools/interaction';
import { ActionRing } from '../../browser-replay/actionRing';
import { clearElementCache, getSmartSnapshot } from '../dom-intelligence';

// browser_click({ smartRef }) on the Playwright lane. Two things it got wrong
// before, both silent: the stored "locator" is the SOURCE TEXT of a getByRole
// call, so `page.locator()` could not parse it (the click failed) and the
// recorded css axis could never replay (the trace filled with dead steps).

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const ring = new ActionRing();
const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test'), actionRing: ring };

function clickTool(): ToolHandler {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, browserToolDeps as never);
  const tool = tools.get('browser_click');
  if (!tool) throw new Error('browser_click failed to register');
  return tool;
}

interface CdpNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

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

function makePage(nodes: CdpNode[], url = 'https://example.test/a') {
  const clicked: string[] = [];
  const page = {
    nodes,
    clicked,
    currentUrl: url,
    url: () => page.currentUrl,
    title: async () => 'Page',
    innerText: async () => 'body text',
    on: () => {},
    mainFrame: () => ({ id: 'main' }),
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string) =>
          method === 'Accessibility.getFullAXTree' ? { nodes: page.nodes } : {},
        ),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    locator: vi.fn(),
    // A real click walks the pointer to the element first, so the fakes carry
    // the shape that approach reads: a viewport, a mouse, and a box per element.
    mouse: { move: async () => {} },
    viewportSize: () => ({ width: 1280, height: 720 }),
    getByRole: (r: string, opts?: { name?: string }) => ({
      count: async () => page.nodes.filter((n) => n.role?.value === r
        && (opts?.name === undefined || (n.name?.value ?? '') === opts.name)).length,
      nth: (i: number) => ({
        boundingBox: async () => ({ x: 100, y: 100, width: 120, height: 40 }),
        click: async () => { clicked.push(`${r} ${opts?.name ?? ''}#${i}`); },
        dblclick: async () => { clicked.push(`dbl ${r} ${opts?.name ?? ''}#${i}`); },
      }),
    }),
  };
  return page;
}

const click = clickTool();

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  ring.clear();
  clearElementCache();
});

describe('browser_click({ smartRef }) on the Playwright lane', () => {
  it('clicks the element the ref names', async () => {
    const page = makePage(tree([
      { backendId: 10, role: 'button', name: 'Row' },
      { backendId: 11, role: 'button', name: 'Row' },
    ]));
    getPage.mockResolvedValue(page);
    await getSmartSnapshot(page as never);

    const result = await click({ smartRef: 2, surfaceId: 'surf-1' });

    expect(result.isError).toBeUndefined();
    expect(page.clicked).toEqual(['button Row#1']);
  });

  it('records a REPLAYABLE ref axis, not the getByRole source text', async () => {
    const page = makePage(tree([
      { backendId: 20, role: 'button', name: 'Row' },
      { backendId: 21, role: 'button', name: 'Row' },
    ]));
    getPage.mockResolvedValue(page);
    await getSmartSnapshot(page as never);
    await click({ smartRef: 2, surfaceId: 'surf-1' });

    const [recorded] = ring.all();
    expect(recorded.step.axis).toEqual({
      kind: 'ref',
      role: 'button',
      name: 'Row',
      sameNameIndex: 1,
      sameNameTotal: 2,
      frameKey: '',
    });
    // The old shape: a css axis holding a string page.locator() cannot parse.
    expect(recorded.step.axis.kind).not.toBe('css');
    expect(recorded.step.unrecordable).toBeUndefined();
  });

  it('reports a stale ref instead of clicking a substitute', async () => {
    const page = makePage(tree([{ backendId: 30, role: 'button', name: 'Save' }]));
    getPage.mockResolvedValue(page);
    await getSmartSnapshot(page as never);

    page.currentUrl = 'https://example.test/elsewhere';
    const result = await click({ smartRef: 1, surfaceId: 'surf-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/stale/);
    expect(page.clicked).toEqual([]);
    expect(ring.all()).toEqual([]);
  });
});
