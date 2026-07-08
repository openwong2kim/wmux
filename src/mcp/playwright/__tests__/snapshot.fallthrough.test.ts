import { describe, expect, it, vi } from 'vitest';
import { generateSnapshot, resolveRef, isRootOnly } from '../snapshot';

// #353: on a background browser surface the guest is display:none, so the CDP
// accessibility tree collapses to a root-only node (RootWebArea, no children).
// generateSnapshot must detect that and fall through to the DOM-selector
// snapshot, and resolveRef must resolve DOM-minted data-wmux-ref refs even when
// the a11y refMap is empty. These tests drive that with a minimal fake Page.

interface CdpNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  childIds?: string[];
}

const ROOT_ONLY: CdpNode[] = [
  { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'name', value: 'Google Gemini' }, childIds: [] },
];

const TREE_WITH_BUTTON: CdpNode[] = [
  { nodeId: '1', role: { type: 'role', value: 'RootWebArea' }, name: { type: 'name', value: 'Page' }, childIds: ['2'] },
  { nodeId: '2', role: { type: 'role', value: 'button' }, name: { type: 'name', value: 'OK' }, childIds: [] },
];

/** Fake Playwright Page whose CDP session returns the given AX nodes. */
function makePage(opts: { nodes?: CdpNode[]; evalResult?: string; throwOnAx?: boolean }) {
  let axCalls = 0;
  const sends: string[] = [];
  const client = {
    send: vi.fn(async (method: string) => {
      sends.push(method);
      if (method === 'Accessibility.getFullAXTree') {
        axCalls++;
        if (opts.throwOnAx) throw new Error('Target crashed');
        return { nodes: opts.nodes ?? [] };
      }
      return {};
    }),
    detach: vi.fn(() => Promise.resolve()),
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: vi.fn(async () => opts.evalResult ?? ''),
    getByRole: vi.fn(),
    locator: vi.fn(),
  };
  return { page, client, sends, getAxCalls: () => axCalls };
}

describe('isRootOnly', () => {
  it('is true for a node with no children / empty children', () => {
    expect(isRootOnly({ role: 'RootWebArea', name: 'x' })).toBe(true);
    expect(isRootOnly({ role: 'RootWebArea', name: 'x', children: [] })).toBe(true);
  });
  it('is false when children are present', () => {
    expect(isRootOnly({ role: 'RootWebArea', name: 'x', children: [{ role: 'button', name: 'ok' }] })).toBe(false);
  });
});

describe('generateSnapshot — root-only fallthrough (#353)', () => {
  it('enables the a11y domain and retries once before falling back', async () => {
    const { page, sends, getAxCalls } = makePage({ nodes: ROOT_ONLY, evalResult: 'DOM-FALLBACK' });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(sends).toContain('Accessibility.enable');
    expect(sends).toContain('Accessibility.disable');
    expect(getAxCalls()).toBe(2); // initial + one retry, both root-only
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    // The fallback runs the shared DOM-snapshot expression.
    expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining('data-wmux-ref'));
    expect(out).toBe('DOM-FALLBACK');
  });

  it('falls through for aria format too, not just ai', async () => {
    const { page } = makePage({ nodes: ROOT_ONLY, evalResult: 'DOM-FALLBACK' });
    const out = await generateSnapshot(page as never, { format: 'aria' });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(out).toBe('DOM-FALLBACK');
  });

  it('serializes the a11y tree (no DOM fallback) when the tree has children', async () => {
    const { page, getAxCalls } = makePage({ nodes: TREE_WITH_BUTTON, evalResult: 'DOM-FALLBACK' });
    const out = await generateSnapshot(page as never, { format: 'ai' });

    expect(getAxCalls()).toBe(1); // not root-only → no retry
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(out).toContain('button');
    expect(out).toContain('ref="0"');
  });

  it('falls through to DOM fallback when the a11y tree is null (zero nodes)', async () => {
    const { page } = makePage({ nodes: [], evalResult: 'DOM-FALLBACK' });
    const out = await generateSnapshot(page as never, { format: 'ai' });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(out).toBe('DOM-FALLBACK');
  });

  it('falls through to DOM fallback when getFullAXTree throws (crashed target)', async () => {
    const { page } = makePage({ throwOnAx: true, evalResult: 'DOM-FALLBACK' });
    const out = await generateSnapshot(page as never, { format: 'ai' });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(out).toBe('DOM-FALLBACK');
  });
});

describe('resolveRef — data-wmux-ref fallback (#353)', () => {
  function pageWithDataAttr(count: number) {
    const handle = { __handle: true };
    const locator = {
      count: vi.fn(async () => count),
      first: () => ({ elementHandle: async () => handle }),
    };
    const page = { getByRole: vi.fn(), locator: vi.fn(() => locator) };
    return { page, handle, locator };
  }

  it('resolves via the data-wmux-ref attribute when the a11y refMap is empty', async () => {
    const { page, handle } = pageWithDataAttr(1);
    // No generateSnapshot ran on this page → refMap is unset → primary returns null.
    const res = await resolveRef(page as never, '5');
    expect(res).toBe(handle);
    expect(page.locator).toHaveBeenCalledWith('[data-wmux-ref="5"]');
    expect(page.getByRole).not.toHaveBeenCalled();
  });

  it('returns null when no element carries the attribute', async () => {
    const { page } = pageWithDataAttr(0);
    expect(await resolveRef(page as never, '5')).toBeNull();
  });

  it('rejects a non-numeric / injection-shaped ref without querying the DOM', async () => {
    const { page } = pageWithDataAttr(1);
    expect(await resolveRef(page as never, '5"]; drop')).toBeNull();
    // Pattern is digits-only now, so even a benign non-numeric ref is rejected.
    expect(await resolveRef(page as never, 'abc')).toBeNull();
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('does NOT fall back to data-wmux-ref after an a11y snapshot (stale-tag guard)', async () => {
    // A non-root tree makes generateSnapshot populate the a11y refMap for this page.
    const { page } = makePage({ nodes: TREE_WITH_BUTTON });
    // resolveRef phase: primary (getByRole) can't resolve, and a data-attr locator
    // WOULD match — but it must be skipped because the current snapshot is a11y-mode
    // (a populated refMap means any data-wmux-ref tags are stale). Codex #353 finding.
    const locator = { count: vi.fn(async () => 1), first: () => ({ elementHandle: async () => ({}) }) };
    (page as unknown as { getByRole: unknown }).getByRole = vi.fn(() => ({ count: async () => 0 }));
    (page as unknown as { locator: unknown }).locator = vi.fn(() => locator);

    await generateSnapshot(page as never, { format: 'ai' }); // refMap = [button]
    const res = await resolveRef(page as never, '0');

    expect(res).toBeNull();
    expect((page as unknown as { locator: ReturnType<typeof vi.fn> }).locator).not.toHaveBeenCalled();
  });
});
