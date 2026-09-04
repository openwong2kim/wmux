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

// browser_type / browser_fill used to accept only browser_snapshot refs, so a
// number read off browser_smart_snapshot ("[61] textbox") came back as
// "Element with ref=61 not found" — a valid ref reported as a missing one, with
// nothing in the message to say the two spaces are different (dogfood
// 2026-09-04, YouTube Studio).

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const ring = new ActionRing();
const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test'), actionRing: ring };

const tools = new Map<string, ToolHandler>();
registerInteractionTools(
  {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as never,
  browserToolDeps as never,
);

function tool(name: string): ToolHandler {
  const handler = tools.get(name);
  if (!handler) throw new Error(`${name} failed to register`);
  return handler;
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
  const filled: string[] = [];
  const page = {
    nodes,
    filled,
    currentUrl: url,
    url: () => page.currentUrl,
    title: async () => 'Page',
    innerText: async () => 'body text',
    on: () => undefined,
    mainFrame: () => ({ id: 'main' }),
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async (method: string) =>
          method === 'Accessibility.getFullAXTree' ? { nodes: page.nodes } : {},
        ),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    // No data-wmux-ref tags on this page: a browser_snapshot ref resolves to
    // nothing, which is exactly the state a smartRef-only session is in. A
    // caller's own CSS selector is answered from `cssMatches` instead.
    cssMatches: new Set<string>(),
    locator: (sel?: string) => ({
      count: async () => (sel !== undefined && page.cssMatches.has(sel) ? 1 : 0),
      first: () => ({
        elementHandle: async () => null,
        click: async () => undefined,
        fill: async (value: string) => { filled.push(`${sel}=${value}`); },
        evaluate: async () => false,
      }),
    }),
    keyboard: { press: async () => undefined, insertText: async () => undefined },
    mouse: { move: async () => undefined },
    viewportSize: () => ({ width: 1280, height: 720 }),
    getByRole: (r: string, opts?: { name?: string }) => ({
      count: async () => page.nodes.filter((n) => n.role?.value === r
        && (opts?.name === undefined || (n.name?.value ?? '') === opts.name)).length,
      nth: (i: number) => ({
        boundingBox: async () => ({ x: 100, y: 100, width: 120, height: 40 }),
        click: async () => undefined,
        fill: async (value: string) => { filled.push(`${r} ${opts?.name ?? ''}#${i}=${value}`); },
        evaluate: async () => false,
      }),
    }),
  };
  return page;
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  ring.clear();
  clearElementCache();
});

describe('browser_type / browser_fill accept smartRefs', () => {
  it('types into the element a smartRef names', async () => {
    const page = makePage(tree([
      { backendId: 10, role: 'textbox', name: 'Title' },
      { backendId: 11, role: 'textbox', name: 'Title' },
    ]));
    getPage.mockResolvedValue(page);
    await getSmartSnapshot(page as never);

    const result = await tool('browser_type')({ smartRef: 2, text: 'hello', surfaceId: 'surf-1' });

    expect(result.isError).toBeUndefined();
    expect(page.filled).toEqual(['textbox Title#1=hello']);
    expect(result.content[0].text).toContain('smartRef=2');
  });

  it('fills a field addressed by smartRef and records a replayable ref axis', async () => {
    const page = makePage(tree([{ backendId: 20, role: 'textbox', name: 'Caption' }]));
    getPage.mockResolvedValue(page);
    await getSmartSnapshot(page as never);

    const result = await tool('browser_fill')({
      fields: [{ smartRef: 1, value: 'a caption' }],
      surfaceId: 'surf-1',
    });

    expect(result.isError).toBeUndefined();
    expect(page.filled).toEqual(['textbox Caption#0=a caption']);
    const [recorded] = ring.all();
    expect(recorded.step.axis.kind).toBe('ref');
    expect(recorded.step.axis).toMatchObject({ role: 'textbox', name: 'Caption', via: 'smart' });
  });

  it('names the other ref space when a smartRef is passed as ref', async () => {
    const page = makePage(tree([{ backendId: 30, role: 'textbox', name: '제목' }]));
    getPage.mockResolvedValue(page);
    await getSmartSnapshot(page as never);

    const result = await tool('browser_fill')({
      fields: [{ ref: '1', value: 'x' }],
      surfaceId: 'surf-1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('browser_smart_snapshot');
    expect(result.content[0].text).toContain('smartRef');
    expect(result.content[0].text).toContain('textbox "제목"');
    expect(page.filled).toEqual([]);
  });

  // A `contenteditable` field that no snapshot handed a number for still has to
  // be typeable — that is the whole reason browser_type takes a selector.
  it('types into a CSS selector when neither snapshot gave the element a ref', async () => {
    const page = makePage(tree([{ backendId: 50, role: 'button', name: 'Next' }]));
    page.cssMatches.add('#title-textbox');
    getPage.mockResolvedValue(page);

    const result = await tool('browser_type')({
      selector: '#title-textbox',
      text: 'My video',
      surfaceId: 'surf-1',
    });

    expect(result.isError).toBeUndefined();
    expect(page.filled).toEqual(['#title-textbox=My video']);
    expect(result.content[0].text).toContain('selector=#title-textbox');
    // Recorded on the css axis, which replay can run as-is.
    expect(ring.all()[0].step.axis).toMatchObject({ kind: 'css' });
  });

  it('says a selector matched nothing instead of spending the auto-wait on it', async () => {
    const page = makePage(tree([{ backendId: 51, role: 'button', name: 'Next' }]));
    getPage.mockResolvedValue(page);

    const result = await tool('browser_type')({
      selector: '#missing',
      text: 'x',
      surfaceId: 'surf-1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No element matches selector: #missing');
    expect(page.filled).toEqual([]);
  });

  it('refuses an address that names no element, and one that names two', async () => {
    const page = makePage(tree([{ backendId: 40, role: 'textbox', name: 'Title' }]));
    getPage.mockResolvedValue(page);
    await getSmartSnapshot(page as never);

    const none = await tool('browser_type')({ text: 'x', surfaceId: 'surf-1' });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain('smartRef');

    const both = await tool('browser_type')({ ref: '1', smartRef: 1, text: 'x', surfaceId: 'surf-1' });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain('not both');
    expect(page.filled).toEqual([]);
  });
});
