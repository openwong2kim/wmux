import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

// isOutstandingFrameRef/frameRefFallbackMessage: the fail-closed guard
// sanitizeRef consults before any data-wmux-ref resolution. Stubbed to "no
// frame refs outstanding", which is what these RPC-lane cases are about.
vi.mock('../snapshot', () => ({
  resolveRef,
  browserScopeKey: () => 'test-scope',
  isOutstandingFrameRef: () => false,
  frameRefFallbackMessage: (ref: string) => `frame ref ${ref}`,
}));

import { registerInteractionTools } from '../tools/interaction';
import { REDACTED_PASSWORD, isPasswordFieldNode } from '../redact';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, browserToolDeps);
  return tools;
}

const type = collectTools().get('browser_type');
if (!type) throw new Error('browser_type failed to register');

/**
 * An element handle whose `evaluate` runs the predicate against a fake node —
 * the same call Playwright makes after serialising the function into the page.
 */
function makeElement(node: unknown) {
  return {
    evaluate: vi.fn(async (fn: (n: unknown) => unknown) => fn(node)),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
  };
}

function makePage() {
  return { keyboard: { press: vi.fn(async () => undefined) } };
}

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  resolveRef.mockReset();
});

describe('browser_type result echo — Playwright transport', () => {
  it('redacts the typed value when the target is a password field', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRef.mockResolvedValue(makeElement({ type: 'password' }));

    const result = await type({ ref: '3', text: 'hunter2SECRET' });

    expect(result.content[0].text).not.toContain('hunter2SECRET');
    expect(result.content[0].text).toBe(
      `Typed "${REDACTED_PASSWORD}" into element ref=3`,
    );
  });

  it('redacts a plaintext field marked autocomplete="new-password"', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRef.mockResolvedValue(makeElement({ type: 'text', autocomplete: 'new-password' }));

    const result = await type({ ref: '4', text: 'newpassSECRET', submit: true });

    expect(result.content[0].text).toBe(
      `Typed "${REDACTED_PASSWORD}" into element ref=4 and submitted`,
    );
  });

  it('still echoes an ordinary field, which is what the echo is for', async () => {
    getPage.mockResolvedValue(makePage());
    resolveRef.mockResolvedValue(makeElement({ type: 'text', autocomplete: 'username' }));

    const result = await type({ ref: '2', text: 'alice@example.com' });

    expect(result.content[0].text).toBe('Typed "alice@example.com" into element ref=2');
  });

  it('echoes rather than failing when the element cannot answer', async () => {
    getPage.mockResolvedValue(makePage());
    const el = makeElement(null);
    el.evaluate.mockRejectedValue(new Error('detached'));
    resolveRef.mockResolvedValue(el);

    const result = await type({ ref: '2', text: 'plain text' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('Typed "plain text" into element ref=2');
  });
});

describe('browser_type result echo — RPC transport', () => {
  it('asks the page through the data-wmux-ref tag and redacts on a hit', async () => {
    getPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation(async (method: string) =>
      method === 'browser.evaluate' ? { value: 'yes' } : {},
    );

    const result = await type({ ref: '3', text: 'hunter2SECRET' });

    const probe = mockSendRpc.mock.calls.find(
      ([method, params]) =>
        method === 'browser.evaluate' &&
        String((params as { expression: string }).expression).includes('data-wmux-ref="3"'),
    );
    expect(probe).toBeDefined();
    expect(result.content[0].text).toBe(`Typed "${REDACTED_PASSWORD}" into element ref=3`);
  });

  it('echoes an ordinary field unchanged', async () => {
    getPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation(async (method: string) =>
      method === 'browser.evaluate' ? { value: 'no' } : {},
    );

    const result = await type({ ref: '2', text: 'alice@example.com' });

    expect(result.content[0].text).toBe('Typed "alice@example.com" into element ref=2');
  });
});

describe('the RPC probe carries the same predicate as the Playwright path', () => {
  it('embeds isPasswordFieldNode verbatim so the two cannot drift', async () => {
    getPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation(async (method: string) =>
      method === 'browser.evaluate' ? { value: 'no' } : {},
    );

    await type({ ref: '5', text: 'x' });

    const expression = String(
      (mockSendRpc.mock.calls.find(([m]) => m === 'browser.evaluate')?.[1] as {
        expression: string;
      }).expression,
    );
    expect(expression).toContain('current-password');
    expect(expression).toContain(String(isPasswordFieldNode));
  });
});
