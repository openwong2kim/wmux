import { beforeEach, describe, expect, it, vi } from 'vitest';

// Which world browser_evaluate runs the caller's expression in. The default is
// the isolated one — the page must not be able to watch or doctor an agent
// script — and `mainWorld:true` is the deliberate opt-out for expressions that
// need the page's own globals (window.__NEXT_DATA__ and friends).

const { getPage, resolveWorkspaceBackend, isolated, gesture } = vi.hoisted(() => ({
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
  isolated: vi.fn(async () => 'from-isolated'),
  gesture: vi.fn(async () => 'from-main'),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : Promise.resolve({}),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend }),
  },
}));

vi.mock('../snapshot', () => ({
  resolveRef: vi.fn(),
  generateSnapshot: vi.fn(),
  generateScopedSnapshot: vi.fn(),
  markDomRefsActive: vi.fn(),
}));

vi.mock('../isolated-eval', () => ({ evaluateIsolated: isolated }));
vi.mock('../user-gesture', () => ({ evaluateWithGesture: gesture }));

import { registerInspectionTools } from '../tools/inspection';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };
const tools = new Map<string, ToolHandler>();
registerInspectionTools(
  { tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => tools.set(name, handler) } as never,
  deps as never,
);
const evaluate = tools.get('browser_evaluate');
if (!evaluate) throw new Error('browser_evaluate failed to register');

const page = { evaluate: vi.fn() };

describe('browser_evaluate world selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPage.mockResolvedValue(page);
  });

  it('runs in the isolated world by default', async () => {
    const out = await evaluate({ expression: 'document.title' });

    expect(isolated).toHaveBeenCalledWith(page, 'document.title');
    expect(gesture).not.toHaveBeenCalled();
    expect(out.content[0]?.text).toBe('from-isolated');
  });

  it('runs in the page\'s own world when mainWorld is true', async () => {
    const out = await evaluate({ expression: 'window.__NEXT_DATA__', mainWorld: true });

    expect(gesture).toHaveBeenCalledWith(page, 'window.__NEXT_DATA__');
    expect(isolated).not.toHaveBeenCalled();
    expect(out.content[0]?.text).toBe('from-main');
  });
});
