// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// browser_click({ smartRef }) on the RPC lane, against a real DOM: the page
// scripts browser_smart_snapshot and browser_snapshot send run in jsdom, and
// the click lands on whatever the selector it sends matches. A smartRef must
// press the element the smart snapshot numbered, or fail, even after
// browser_snapshot re-tags the page.

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
      getPageForScope: async () => null,
      drainLocalLifecycle: () => [],
      resolveWorkspaceBackend: async () => 'builtin',
      isLiveWriteConfined: async () => false,
    }),
  },
}));

import { registerInspectionTools } from '../tools/inspection';
import { registerInteractionTools } from '../tools/interaction';
import { registerExtractionTools } from '../tools/extraction';
import { ActionRing } from '../../browser-replay/actionRing';
import { clearRefDescriptors } from '../refDescriptors';
import { clearElementCache } from '../dom-intelligence';
import { resetProtectionMemoryForTests } from '../automationLease';
import { __resetSurfaceRoutingForTesting } from '../surfaceRouting';
import { __resetFrameRefsForTesting } from '../snapshot';

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const tools = new Map<string, ToolHandler>();
const server = { tool: (name: string, _d: string, _s: unknown, h: ToolHandler) => tools.set(name, h) } as never;
const deps = { resolveWorkspaceId: vi.fn(async () => 'ws-test'), actionRing: new ActionRing() } as never;
registerInspectionTools(server, deps);
registerInteractionTools(server, deps);
registerExtractionTools(server, deps);
const tool = (name: string) => tools.get(name) as ToolHandler;
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

let clicked: string[] = [];

beforeEach(() => {
  clicked = [];
  mockSendRpc.mockReset();
  mockSendRpc.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
    // Indirect eval runs in global scope, where jsdom's document lives.
    if (method === 'browser.evaluate') return { value: (0, eval)(String(params.expression)) };
    if (method === 'browser.frames.tree') return { frames: [] };
    if (method === 'browser.click.cdp') {
      const el = document.querySelector(String(params.selector));
      if (!el) throw new Error(`No element matches selector: ${String(params.selector)}`);
      clicked.push(el.id);
      return { ok: true };
    }
    return { ok: true };
  });
  clearRefDescriptors();
  clearElementCache();
  resetProtectionMemoryForTests();
  __resetSurfaceRoutingForTesting();
  __resetFrameRefsForTesting();
});

/** The number browser_smart_snapshot listed for the element named `name`. */
function smartRefOf(listing: string, name: string): number {
  const line = listing.split('\n').find((l) => l.includes(`"${name}"`));
  const n = line ? /\[(\d+)\]/.exec(line)?.[1] : undefined;
  if (!n) throw new Error(`no smart ref for ${name} in:\n${listing}`);
  return Number(n);
}

const PAGE = '<button id="save">Save</button><button id="delete">Delete</button><button id="cancel">Cancel</button>';

describe('browser_click({ smartRef }) on the RPC lane', () => {
  it('presses the element the smart snapshot numbered, after browser_snapshot re-tags the page', async () => {
    document.body.innerHTML = PAGE;
    const listing = textOf(await tool('browser_smart_snapshot')({}));
    const del = smartRefOf(listing, 'Delete');
    // browser_snapshot renumbers every element of the page in its own count.
    await tool('browser_snapshot')({});
    const res = await tool('browser_click')({ smartRef: del });
    expect(res.isError).toBeFalsy();
    expect(clicked).toEqual(['delete']);
  });

  it('presses the right element on a page that already carries smart-ref tags', async () => {
    // Stale tags: an earlier smart snapshot's, and one the page itself set.
    document.body.innerHTML = PAGE.replace('id="cancel"', 'id="cancel" data-wmux-smart-ref="2"');
    document.getElementById('save')?.setAttribute('data-wmux-smart-ref', '9');
    const listing = textOf(await tool('browser_smart_snapshot')({}));
    const del = smartRefOf(listing, 'Delete');
    await tool('browser_click')({ smartRef: del });
    expect(clicked).toEqual(['delete']);
  });

  it('fails instead of pressing another element when the page changed underneath', async () => {
    document.body.innerHTML = PAGE;
    const listing = textOf(await tool('browser_smart_snapshot')({}));
    const del = smartRefOf(listing, 'Delete');
    // A navigation: a new document with new elements, then browser_snapshot tags it.
    document.body.innerHTML = '<button id="other1">Other</button><button id="other2">Pay</button><button id="other3">Quit</button>';
    await tool('browser_snapshot')({});
    const res = await tool('browser_click')({ smartRef: del });
    expect(res.isError).toBe(true);
    expect(clicked).toEqual([]);
  });

  it('lets smartRef win over ref, and takes a smartRef next to an empty ref', async () => {
    document.body.innerHTML = PAGE;
    await tool('browser_snapshot')({});
    const listing = textOf(await tool('browser_smart_snapshot')({}));
    const del = smartRefOf(listing, 'Delete');
    await tool('browser_click')({ smartRef: del, ref: '0' });
    const empty = await tool('browser_click')({ smartRef: del, ref: '' });
    expect(empty.isError).toBeFalsy();
    expect(clicked).toEqual(['delete', 'delete']);
  });
});
