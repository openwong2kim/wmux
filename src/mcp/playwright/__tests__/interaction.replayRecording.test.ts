import { beforeEach, describe, expect, it, vi } from 'vitest';

// What the recorder writes when an interaction tool succeeds. browser_fill is
// the case this file exists for: it fills a whole form in one call, so a login
// form goes through it, and it has to give the SAME password guarantee
// browser_type does — the value never reaching the ring at all.

const { mockSendRpc, getPage, resolveRef, getRefEntry } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
  getRefEntry: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend: async () => 'chrome' }),
  },
}));

vi.mock('../snapshot', () => ({
  resolveRef,
  getRefEntry,
  listRefEntries: () => [],
  browserScopeKey: () => 'test-scope',
  isOutstandingFrameRef: () => false,
  frameRefFallbackMessage: (ref: string) => `frame ref ${ref}`,
}));

import { registerInteractionTools } from '../tools/interaction';
import { ActionRing } from '../../browser-replay/actionRing';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const ring = new ActionRing();
const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test'), actionRing: ring };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, deps);
  return tools;
}

const tools = collectTools();
const fill = tools.get('browser_fill')!;
const type = tools.get('browser_type')!;
const click = tools.get('browser_click')!;
const drag = tools.get('browser_drag')!;
const scroll = tools.get('browser_scroll')!;

const SECRET = 'hunter2SECRET';

/** An element whose `evaluate` runs the password predicate on a fake node. */
function element(node: unknown) {
  return {
    evaluate: vi.fn(async (fn: (n: unknown) => unknown) => fn(node)),
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
  };
}

function page() {
  return { url: () => 'https://example.com/login', keyboard: { press: vi.fn(async () => undefined) } };
}

beforeEach(() => {
  ring.clear();
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  resolveRef.mockReset();
  getRefEntry.mockReset();
  getRefEntry.mockImplementation((_page: unknown, ref: string) => ({
    role: 'textbox',
    name: `field-${ref}`,
    sameNameIndex: 0,
    sameNameTotal: 1,
    frameKey: '',
    ref: Number(ref),
  }));
});

describe('browser_fill recording — the password guarantee', () => {
  it('never puts a password field value in the ring, even beside ordinary fields', async () => {
    getPage.mockResolvedValue(page());
    resolveRef.mockImplementation(async (_p: unknown, ref: string) =>
      element(ref === '2' ? { type: 'password' } : { type: 'text' }),
    );

    const result = await fill({
      fields: [
        { ref: '1', value: 'alice@example.com' },
        { ref: '2', value: SECRET },
      ],
    });

    expect(result.content[0].text).toContain('Filled 2/2');
    const recorded = ring.all();
    expect(recorded).toHaveLength(2);
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
    // The ordinary field is still fully recorded — the guard is not blanket.
    expect(recorded[0].step.args).toEqual({ value: 'alice@example.com' });
    expect(recorded[0].step.unrecordable).toBeUndefined();
    // The credential is a hole, not an omission: the flow still reads honestly.
    expect(recorded[1].step.args).toEqual({});
    expect(recorded[1].step.unrecordable).toBe('password');
  });

  it('gives the same guarantee over the RPC lane, where the probe is injected JS', async () => {
    getPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === 'browser.evaluate') {
        const expression = String(params.expression ?? '');
        // The password probe is the only evaluate that asks this question.
        if (expression.includes('isPasswordField')) {
          return Promise.resolve({ value: expression.includes('"2"') ? 'yes' : 'no' });
        }
      }
      return Promise.resolve({ value: '' });
    });

    await fill({
      fields: [
        { ref: '1', value: 'alice@example.com' },
        { ref: '2', value: SECRET },
      ],
    });

    const recorded = ring.all();
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
    expect(recorded[1].step.unrecordable).toBe('password');
  });

  it('records nothing at all when a field failed, so a half form cannot replay whole', async () => {
    getPage.mockResolvedValue(page());
    resolveRef.mockImplementation(async (_p: unknown, ref: string) =>
      ref === '2' ? null : element({ type: 'text' }),
    );

    await fill({ fields: [{ ref: '1', value: 'a' }, { ref: '2', value: 'b' }] });
    expect(ring.all()).toEqual([]);
  });

  it('browser_type still holds the same line, so the two tools agree', async () => {
    getPage.mockResolvedValue(page());
    resolveRef.mockResolvedValue(element({ type: 'password' }));

    await type({ ref: '3', text: SECRET });

    const recorded = ring.all();
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
    expect(recorded[0].step.unrecordable).toBe('password');
  });
});

describe('pointer gestures and the action ring', () => {
  /** A page that accepts every mouse and keyboard call. */
  function pointerPage() {
    const noop = vi.fn(async () => undefined);
    return {
      url: () => 'https://example.com/board',
      on: vi.fn(),
      off: vi.fn(),
      viewportSize: () => ({ width: 1280, height: 800 }),
      evaluate: vi.fn(async () => undefined),
      mouse: { move: noop, down: noop, up: noop, click: noop, wheel: noop },
      keyboard: { down: noop, up: noop, press: noop },
    };
  }

  function boxedElement() {
    return {
      boundingBox: vi.fn(async () => ({ x: 100, y: 100, width: 40, height: 40 })),
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
      click: vi.fn(async () => undefined),
      dblclick: vi.fn(async () => undefined),
    };
  }

  beforeEach(() => {
    getPage.mockResolvedValue(pointerPage());
    resolveRef.mockImplementation(async () => boxedElement());
  });

  it('a plain ref drag still records, with both refs', async () => {
    const result = await drag({ sourceRef: '1', targetRef: '2' });
    expect(result.isError).toBeUndefined();

    const recorded = ring.all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].step.tool).toBe('browser_drag');
    expect(recorded[0].step.target2).toBeDefined();
  });

  it('records none of the new gestures', async () => {
    const results = [
      await drag({ path: [{ x: 10, y: 10 }, { x: 200, y: 200 }] }),
      await drag({ sourceRef: '1', targetRef: '2', modifiers: ['Shift'] }),
      await scroll({ direction: 'down', x: 300, y: 300 }),
      await click({ ref: '1', modifiers: ['Control'] }),
      await click({ x: 20, y: 20, modifiers: ['Meta'] }),
    ];
    for (const result of results) expect(result.isError).toBeUndefined();
    expect(ring.all()).toEqual([]);
  });

  it('while the unmodified click and scroll still record', async () => {
    await click({ ref: '1' });
    await scroll({ direction: 'down' });
    expect(ring.all().map((r) => r.step.tool)).toEqual(['browser_click', 'browser_scroll']);
  });
});
