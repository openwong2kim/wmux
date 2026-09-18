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

// Same stubs the other interaction suites use: no frame refs outstanding, so
// sanitizeRef's fail-closed guard is not what these cases are about.
vi.mock('../snapshot', () => ({
  resolveRef: resolveRefMock,
  browserScopeKey: () => 'test-scope',
  isOutstandingFrameRef: () => false,
  frameRefFallbackMessage: (ref: string) => `frame ref ${ref}`,
}));

import { registerInteractionTools } from '../tools/interaction';
import { WorkspaceScopeUnresolvedError } from '../browserScope';
import { UNKNOWN_EFFECT_ADVICE } from '../resultTrailer';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, browserToolDeps);
  return tools;
}

const tools = collectTools();

function tool(name: string): ToolHandler {
  const handler = tools.get(name);
  if (!handler) throw new Error(`${name} failed to register`);
  return handler;
}

const click = tool('browser_click');
const fill = tool('browser_fill');
const pressKey = tool('browser_press_key');
const scroll = tool('browser_scroll');

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

/** The trailer lines, read back off a result. */
function trailer(r: ToolResult): string[] {
  return text(r)
    .split('\n')
    .filter((line) => line.startsWith('effect_state: ') || line.startsWith('error_code: '));
}

function makeElement(opts: { clickError?: Error; fillError?: Error } = {}) {
  return {
    click: vi.fn(async () => {
      if (opts.clickError) throw opts.clickError;
    }),
    dblclick: vi.fn(async () => undefined),
    fill: vi.fn(async () => {
      if (opts.fillError) throw opts.fillError;
    }),
    // The password probe runs the predicate against the node; a plain text
    // field is what these cases are about.
    evaluate: vi.fn(async () => false),
    boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 40 })),
  };
}

function makePage() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    locator: vi.fn(),
    mouse: { move: vi.fn(async () => undefined) },
    viewportSize: () => ({ width: 1280, height: 720 }),
    keyboard: { press: vi.fn(async () => undefined) },
  };
}

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  getPage.mockResolvedValue(null);
  resolveWorkspaceBackend.mockReset();
  resolveWorkspaceBackend.mockResolvedValue('builtin');
  resolveRefMock.mockReset();
});

describe('effect trailer — committed', () => {
  it('ends a successful ref click with the state, and nothing else', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRefMock.mockResolvedValue(makeElement());

    const result = await click({ ref: '3' });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe('Clicked element ref=3\n\neffect_state: committed');
    expect(trailer(result)).toEqual(['effect_state: committed']);
  });

  it('ends a successful RPC-lane key press the same way', async () => {
    const result = await pressKey({ key: 'Enter' });

    expect(text(result)).toBe('Pressed key: Enter\n\neffect_state: committed');
    expect(mockSendRpc).toHaveBeenCalledWith(
      'browser.press.cdp',
      expect.objectContaining({ key: 'Enter' }),
    );
  });

  it('calls a partly filled form committed — some fields did land', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRefMock
      .mockResolvedValueOnce(makeElement())
      .mockResolvedValueOnce(makeElement({ fillError: new Error('Element is not enabled') }));

    const result = await fill({
      fields: [
        { ref: '1', value: 'a' },
        { ref: '2', value: 'b' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('Filled 1/2 field(s).');
    expect(trailer(result)).toEqual(['effect_state: committed']);
  });
});

describe('effect trailer — none', () => {
  it('reports a ref that resolved to nothing as never dispatched', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRefMock.mockResolvedValue(null);

    const result = await click({ ref: '99' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Element with ref=99 not found.');
    expect(trailer(result)).toEqual(['effect_state: none', 'error_code: ref_not_found']);
    // `none` is the state that makes a retry free, so it must not also be
    // telling the caller to go and look at the page first.
    expect(text(result)).not.toContain(UNKNOWN_EFFECT_ADVICE);
  });

  it('reports a refused parameter combination as never dispatched', async () => {
    getPage.mockResolvedValue(makePage());

    const result = await click({ ref: '3', x: 10, y: 20 });

    expect(result.isError).toBe(true);
    expect(trailer(result)).toEqual(['effect_state: none', 'error_code: invalid_params']);
  });

  it('reports a scope refusal the page lane raised as never dispatched', async () => {
    getPage.mockRejectedValue(
      new WorkspaceScopeUnresolvedError('browser tool workspace identity resolved to an empty id.'),
    );

    const result = await click({ ref: '3' });

    expect(result.isError).toBe(true);
    expect(trailer(result)).toEqual(['effect_state: none', 'error_code: scope_refused']);
  });

  it('trailers a refusal raised by the LEASE, before the tool body ever runs', async () => {
    // withAutomationLease resolves the workspace scope first, so this rejection
    // never reaches the body's own catch. Every one of these tools promises a
    // trailer in its description, so the escape hatch has to carry one too.
    browserToolDeps.resolveWorkspaceId.mockResolvedValueOnce('');

    const result = await click({ ref: '3' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('WORKSPACE_SCOPE_UNRESOLVED');
    expect(trailer(result)).toEqual(['effect_state: none', 'error_code: scope_refused']);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('reports a scroll whose ref the page no longer has, instead of claiming one', async () => {
    // The RPC lane asked the page and the page said `not_found`; the answer used
    // to be discarded, so the tool reported a scroll that never happened.
    mockSendRpc.mockImplementation(async (method: string) =>
      method === 'browser.evaluate' ? { value: 'not_found' } : {},
    );

    const result = await scroll({ direction: 'down', ref: '7' });

    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain('Scrolled down');
    expect(trailer(result)).toEqual(['effect_state: none', 'error_code: ref_not_found']);
  });

  it('reports a form where every field failed as never dispatched', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRefMock.mockResolvedValue(null);

    const result = await fill({ fields: [{ ref: '1', value: 'a' }] });

    expect(result.isError).toBe(true);
    expect(trailer(result)).toEqual(['effect_state: none', 'error_code: ref_not_found']);
  });
});

describe('effect trailer — unknown', () => {
  it('reports a click that timed out after dispatch, with the inspect-first sentence', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRefMock.mockResolvedValue(
      makeElement({ clickError: new Error('Timeout 30000ms exceeded.') }),
    );

    const result = await click({ ref: '3' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Timeout 30000ms exceeded.');
    expect(text(result)).toContain(UNKNOWN_EFFECT_ADVICE);
    expect(trailer(result)).toEqual(['effect_state: unknown', 'error_code: timeout']);
  });

  it('reports an RPC lane that lost the connection mid-click', async () => {
    mockSendRpc.mockRejectedValue(new Error('Connection closed before response was received.'));

    const result = await click({ ref: '3' });

    expect(result.isError).toBe(true);
    expect(trailer(result)).toEqual(['effect_state: unknown', 'error_code: transport_lost']);
    expect(text(result)).toContain(UNKNOWN_EFFECT_ADVICE);
  });
});

describe('effect trailer placement', () => {
  it('is the last thing in the result, after a multi-line body', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRefMock.mockResolvedValue(makeElement());

    const lines = text(await click({ ref: '3' })).split('\n');

    expect(lines[lines.length - 1]).toBe('effect_state: committed');
    expect(lines[lines.length - 2]).toBe('');
  });
});
