import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-process frames on the RPC lane, tool to tool: browser_snapshot lists a
// frame's contents and remembers its refs per connection; browser_click,
// browser_type and browser_fill act in that frame through main; every other
// ref tool refuses a frame ref; a stale frame is refused with the way out;
// and a frame ref one broker connection minted means nothing on another.

const { mockSendRpc } = vi.hoisted(() => ({ mockSendRpc: vi.fn() }));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) => {
    if (method === 'browser.lease.acquire') return Promise.resolve({ token: 't', policy: { protected: false } });
    if (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get') return Promise.resolve({ token: null });
    return mockSendRpc(method, ...args);
  },
}));
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      // No Playwright page: the RPC lane.
      getPageForScope: async () => null,
      drainLocalLifecycle: () => [],
      resolveWorkspaceBackend: async () => 'builtin',
      isLiveWriteConfined: async () => false,
    }),
  },
}));

import { registerInspectionTools } from '../tools/inspection';
import { registerInteractionTools } from '../tools/interaction';
import { ActionRing } from '../../browser-replay/actionRing';
import { createConnectionScope, runInConnectionScope } from '../../connectionScope';
import { clearRefDescriptors } from '../refDescriptors';
import { resetProtectionMemoryForTests } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const tools = new Map<string, ToolHandler>();
const server = { tool: (name: string, _d: string, _s: unknown, h: ToolHandler) => tools.set(name, h) } as never;
const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test'), actionRing: new ActionRing() } as never;
registerInspectionTools(server, deps);
registerInteractionTools(server, deps);
const tool = (name: string) => tools.get(name) as ToolHandler;
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

const TOP = {
  text: 'Page: Shop\nURL: https://top.test/cart\n\n\nInteractive elements (use ref number for click/fill/type):\n  [ref=0] button "Top"',
  entries: [{ ref: 0, role: 'button', name: 'Top' }],
};

/** Answer the snapshot's RPCs and record every call. */
function answer(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    if (overrides[method]) return overrides[method](params);
    if (method === 'browser.frames.tree') {
      return { frames: [{ frameId: 'F1', loaderId: 'L1', parentId: 'MAIN', depth: 1, origin: 'https://pay.test', name: 'card' }] };
    }
    if (method === 'browser.frames.read') {
      // A frame-mode listing: an element the prior names keeps its number.
      const [f] = params.frames as Array<{ prior: Array<{ ref: number; name: string }> }>;
      const seed = params.seed as number;
      const ref = f.prior.find((p) => p.name === 'cc')?.ref ?? seed;
      return { frames: [{ value: { text: `  [ref=${ref}] input name="cc"`, entries: [{ ref, role: 'input', name: 'cc' }] } }], nextRef: Math.max(seed, ref + 1) };
    }
    if (method === 'browser.evaluate' && String(params.expression).includes('wmux-caret')) return { value: 'wmux-caret:held' };
    if (method === 'browser.evaluate') return { value: TOP };
    return { ok: true };
  });
}

const calls = (method: string) =>
  mockSendRpc.mock.calls.filter(([m]) => m === method).map(([, p]) => p as Record<string, unknown>);

beforeEach(() => {
  mockSendRpc.mockReset();
  clearRefDescriptors();
  resetProtectionMemoryForTests();
  __resetSurfaceRoutingForTesting();
});

describe('in-process frames on the RPC lane', () => {
  it('lists a frame after the top document and acts on its refs inside that frame', async () => {
    answer();
    const snap = textOf(await tool('browser_snapshot')({}));
    expect(snap).toContain('[ref=0] button "Top"');
    expect(snap).toContain('Frame 1 "card" -> https://pay.test (page content, another origin)');
    expect(snap).toContain('[ref=1] input name="cc"');
    // Every frame in one browser.frames.read that carries no code; nothing evaluates in a frame.
    expect(calls('browser.frames.read')).toEqual([{ frames: [{ frameId: 'F1', loaderId: 'L1', prior: [] }], seed: 1, workspaceId: 'ws-test' }]);
    expect(calls('browser.evaluate').filter((p) => 'frameId' in p)).toEqual([]);

    await tool('browser_click')({ ref: '1' });
    expect(calls('browser.click.cdp').at(-1)).toMatchObject({ selector: '[data-wmux-ref="1"]', frameId: 'F1', loaderId: 'L1' });

    await tool('browser_click')({ ref: '0' });
    expect(calls('browser.click.cdp').at(-1)).not.toHaveProperty('frameId');

    mockSendRpc.mockClear();
    const typed = await tool('browser_type')({ ref: '1', text: '4111' });
    expect(typed.isError).toBeFalsy();
    // Focus, caret check and select-all all happen in the frame; the text goes to its focus.
    expect(calls('browser.click.cdp')[0]).toMatchObject({ frameId: 'F1', loaderId: 'L1' });
    // Focus, caret, select-all and the password probe all ask the frame's document.
    for (const ev of calls('browser.evaluate')) expect(ev).toMatchObject({ frameId: 'F1', loaderId: 'L1' });
    expect(calls('browser.type.cdp')[0]).toMatchObject({ text: '4111' });
  });

  it('redacts what is typed into a password field inside a frame', async () => {
    answer({
      'browser.frames.read': (p) => {
        const seed = p.seed as number;
        return { frames: [{ value: { text: `  [ref=${seed}] input[type=password] name="pw"`, entries: [{ ref: seed, role: 'input', name: 'pw' }] } }], nextRef: seed + 1 };
      },
      'browser.evaluate': (p) => {
        const expr = String(p.expression);
        if (p.frameId === 'F1' && expr.includes('isPasswordField')) return { value: 'yes' };
        if (expr.includes('wmux-caret')) return { value: 'wmux-caret:held' };
        return { value: expr.includes('isPasswordField') ? 'no' : TOP };
      },
    });
    await tool('browser_snapshot')({});
    const typed = textOf(await tool('browser_type')({ ref: '1', text: 'hunter2' }));
    expect(typed).not.toContain('hunter2');
  });

  it('refuses a frame ref in every tool that cannot reach into frames, naming the frame', async () => {
    answer();
    await tool('browser_snapshot')({});
    for (const [name, args] of [
      ['browser_hover', { ref: '1' }],
      ['browser_select', { ref: '1', values: ['a'] }],
      ['browser_scroll_into_view', { ref: '1' }],
      ['browser_screenshot', { ref: '1' }],
    ] as const) {
      const res = await tool(name)(args);
      expect(res.isError, name).toBe(true);
      expect(textOf(res), name).toContain('ref=1 is inside a frame (https://pay.test)');
    }
  });

  it('refuses a ref whose frame navigated, and says how to recover', async () => {
    answer();
    await tool('browser_snapshot')({});
    answer({ 'browser.click.cdp': () => { throw new Error('FRAME_NAVIGATED: the frame has loaded another document since the snapshot'); } });
    const res = await tool('browser_click')({ ref: '1' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/ref=1 belonged to a frame that has navigated or gone.*browser_snapshot/s);
  });

  it('stops a multi-line type when the frame navigates after an Enter', async () => {
    answer();
    await tool('browser_snapshot')({});
    let pressed = false;
    answer({
      'browser.press.cdp': () => { pressed = true; return { ok: true }; },
      'browser.evaluate': (p) => {
        if (pressed) throw new Error('FRAME_NAVIGATED: the frame has loaded another document since the snapshot');
        if (String(p.expression).includes('wmux-caret')) return { value: 'wmux-caret:held' };
        return { value: 'no' };
      },
    });
    const res = await tool('browser_type')({ ref: '1', text: 'a\nb\nc', newline: 'enter' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Typed 1 of 3 lines/);
    expect(calls('browser.type.cdp').map((p) => p.text)).toEqual(['a']);
  });

  it('never sends a smartRef or a caller\'s own selector into a frame', async () => {
    answer();
    await tool('browser_snapshot')({});
    await tool('browser_click')({ smartRef: 1 });
    await tool('browser_type')({ selector: '[data-wmux-ref="1"]', text: 'x' });
    for (const p of [...calls('browser.click.cdp'), ...calls('browser.evaluate').slice(-3)]) {
      expect(p).not.toHaveProperty('frameId');
    }
  });

  it('never resolves one broker connection\'s frame ref on another', async () => {
    answer();
    const a = createConnectionScope();
    const b = createConnectionScope();
    await runInConnectionScope(a, () => tool('browser_snapshot')({}));
    await runInConnectionScope(b, () => tool('browser_click')({ ref: '1' }));
    expect(calls('browser.click.cdp').at(-1)).not.toHaveProperty('frameId');
    await runInConnectionScope(a, () => tool('browser_click')({ ref: '1' }));
    expect(calls('browser.click.cdp').at(-1)).toMatchObject({ frameId: 'F1' });
  });

  it('keeps a frame element\'s number across snapshots, so a kept ref still works', async () => {
    answer();
    await tool('browser_snapshot')({});
    const second = textOf(await tool('browser_snapshot')({}));
    // Unchanged page: the diff has nothing to report, and ref=1 is still the field.
    expect(second).not.toMatch(/\[ref=2\]/);
    await tool('browser_click')({ ref: '1' });
    expect(calls('browser.click.cdp').at(-1)).toMatchObject({ frameId: 'F1', loaderId: 'L1' });
  });

  it('keeps a frame\'s refs and numbers through a snapshot that could not read it', async () => {
    answer();
    await tool('browser_snapshot')({});
    answer({ 'browser.frames.read': () => ({ frames: [{ failed: true }], nextRef: 2 }) });
    expect(textOf(await tool('browser_snapshot')({}))).toContain('could not be read this time');
    await tool('browser_click')({ ref: '1' });
    expect(calls('browser.click.cdp').at(-1)).toMatchObject({ frameId: 'F1', loaderId: 'L1' });
    answer();
    const third = textOf(await tool('browser_snapshot')({}));
    expect(third).toContain('[ref=1] input name="cc"');
    expect(third).not.toMatch(/\[ref=2\] input/);
  });

  it('never hands a frame ref\'s number to the top document on the next snapshot', async () => {
    answer();
    await tool('browser_snapshot')({});
    answer();
    await tool('browser_snapshot')({});
    const seeds = calls('browser.evaluate')
      .filter((p) => !p.frameId)
      .map((p) => Number(/const seedNext = (\d+);/.exec(String(p.expression))?.[1]));
    // The second top listing starts past the frame's ref 1.
    expect(seeds.at(-1)).toBeGreaterThanOrEqual(2);
  });
});
