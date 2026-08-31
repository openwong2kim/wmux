import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage, resolveWorkspaceBackend, resolveRefMock } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
  resolveRefMock: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend }),
  },
}));

vi.mock('../snapshot', () => ({ resolveRef: resolveRefMock, generateSnapshot: vi.fn(), generateScopedSnapshot: vi.fn(), markDomRefsActive: vi.fn() }));

import { registerInteractionTools } from '../tools/interaction';
import { registerInspectionTools } from '../tools/inspection';

type ToolResult = {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collect(register: (s: never, d: never) => void): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  register(server as never, deps as never);
  return tools;
}

const click = collect(registerInteractionTools).get('browser_click');
const screenshot = collect(registerInspectionTools).get('browser_screenshot');
if (!click || !screenshot) throw new Error('tools failed to register');

type Handler = (arg: unknown) => void;

function makePage(opts: { viewport?: { width: number; height: number } | null; popupUrl?: string } = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const order: string[] = [];
  const mouseClick = vi.fn(async () => {
    if (opts.popupUrl !== undefined) {
      for (const fn of handlers.get('popup') ?? []) fn({ url: () => opts.popupUrl });
    }
  });
  return {
    mouseClick,
    order,
    listenerCount: () => handlers.get('popup')?.size ?? 0,
    page: {
      on: (event: string, fn: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>();
        set.add(fn);
        handlers.set(event, set);
      },
      off: (event: string, fn: Handler) => handlers.get(event)?.delete(fn),
      locator: vi.fn(),
      mouse: { click: mouseClick },
      viewportSize: () => (opts.viewport === undefined ? { width: 1280, height: 800 } : opts.viewport),
      evaluate: vi.fn(async (expr: string) => {
        order.push('evaluate');
        return expr === 'window.devicePixelRatio' ? 2 : undefined;
      }),
      screenshot: vi.fn(async () => {
        order.push('screenshot');
        return Buffer.from('png');
      }),
    },
  };
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ data: 'BASE64' });
  getPage.mockReset();
  resolveWorkspaceBackend.mockReset();
  resolveWorkspaceBackend.mockResolvedValue('chrome');
  resolveRefMock.mockReset();
});

describe('browser_click coordinates', () => {
  it('clicks at viewport CSS pixels through the mouse API', async () => {
    const { page, mouseClick } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ x: 120, y: 340 });

    expect(result.isError).toBeUndefined();
    expect(mouseClick).toHaveBeenCalledWith(120, 340, {});
    expect(result.content[0].text).toContain('viewport CSS px (120, 340)');
  });

  it('double-clicks at a coordinate when asked', async () => {
    const { page, mouseClick } = makePage();
    getPage.mockResolvedValue(page);

    await click({ x: 5, y: 6, double: true });
    expect(mouseClick).toHaveBeenCalledWith(5, 6, { clickCount: 2 });
  });

  it('refuses a call that carries both a ref and coordinates', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ ref: '3', x: 1, y: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
  });

  it('refuses half a coordinate pair', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ x: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('both x and y');
  });

  it('says the RPC lane cannot do coordinate clicks', async () => {
    getPage.mockResolvedValue(null);

    const result = await click({ x: 1, y: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('chrome backend');
    expect(mockSendRpc).not.toHaveBeenCalledWith('browser.click.cdp', expect.anything());
  });

  it('[fix] carries the underlying page failure into that message', async () => {
    getPage.mockRejectedValue(new Error('Target page, context or browser has been closed'));

    const result = await click({ x: 1, y: 2 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('browser has been closed');
  });

  it('[fix] refuses a negative coordinate', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await click({ x: -5, y: 10 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('inside the viewport');
  });

  it('[fix] refuses a coordinate outside the viewport instead of faking success', async () => {
    const { page, mouseClick } = makePage({ viewport: { width: 800, height: 600 } });
    getPage.mockResolvedValue(page);

    const result = await click({ x: 900, y: 100 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('800x600 viewport');
    expect(mouseClick).not.toHaveBeenCalled();
  });

  it('[fix] still clicks when the page reports no viewport size', async () => {
    const { page, mouseClick } = makePage({ viewport: null });
    getPage.mockResolvedValue(page);

    const result = await click({ x: 900, y: 100 });
    expect(result.isError).toBeUndefined();
    expect(mouseClick).toHaveBeenCalled();
  });

  it('[fix] reports a popup opened by a coordinate click, and detaches the listener', async () => {
    const watched = makePage({ popupUrl: 'https://popup.example/from-coords' });
    getPage.mockResolvedValue(watched.page);

    const result = await click({ x: 10, y: 20 });
    expect(result.content[0].text).toContain('opened a popup (page: https://popup.example/from-coords)');
    expect(watched.listenerCount()).toBe(0);
  });
});

describe('browser_screenshot coordinate basis', () => {
  it('states the devicePixelRatio divisor for a viewport capture', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await screenshot({});
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(result.content[0].type).toBe('image');
    expect(note).toContain('devicePixelRatio 2');
    expect(note).toContain('image pixels / 2');
  });

  it('[fix] reads the devicePixelRatio before taking the shot', async () => {
    const watched = makePage();
    getPage.mockResolvedValue(watched.page);

    await screenshot({});
    expect(watched.order).toEqual(['evaluate', 'screenshot']);
  });

  it('[fix] tells the RPC lane that coordinate clicks are unsupported', async () => {
    getPage.mockResolvedValue(null);

    const result = await screenshot({});
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';
    expect(note).toContain('does not support coordinate clicks');
    expect(note).not.toContain('devicePixelRatio');
  });

  it('marks a fullPage capture as unusable for coordinate clicks', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const result = await screenshot({ fullPage: true });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(note).toContain('DOCUMENT coordinates');
    expect(note).toContain('NOT usable for browser_click x/y');
  });

  it('marks an element capture as element-relative', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);
    resolveRefMock.mockResolvedValue({ screenshot: async () => Buffer.from('png') });

    const result = await screenshot({ ref: '3' });
    const note = result.content.find((c) => c.type === 'text')?.text ?? '';

    expect(note).toContain('ELEMENT-relative');
    expect(note).toContain('NOT usable');
  });
});
