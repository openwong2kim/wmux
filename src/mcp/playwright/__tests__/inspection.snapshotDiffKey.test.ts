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
    getInstance: () => ({ getPageForScope: getPage, drainLocalLifecycle: () => [] }),
  },
}));

import { registerInspectionTools } from '../tools/inspection';

// browser_snapshot's diff baseline is keyed on the arguments that change what
// the snapshot IS. `selector` and `q` are both free caller text, so joining the
// parts with `|` let them run together: `{selector:"a", q:"b||c"}` and
// `{selector:"a||b", q:"c"}` spelled the same key, and the second call was
// answered with a diff against the first one's rendering.

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

const tools = new Map<string, ToolHandler>();
registerInspectionTools(
  {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as never,
  browserToolDeps as never,
);
const snapshot = tools.get('browser_snapshot');
if (!snapshot) throw new Error('browser_snapshot failed to register');

// The RPC lane: no live page, so a scoped call is served by the DOM listing and
// every call in one test returns the same text. Anything but a full listing on
// the second call therefore means the two shared a baseline.
const LISTING = [
  'Page: Settings',
  'URL: https://x.test/settings',
  '',
  'Interactive elements (use ref number for click/fill/type):',
  '  [ref=0] button name="Save"',
].join('\n');

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ value: LISTING });
  getPage.mockReset();
  getPage.mockResolvedValue(null);
});

describe('the browser_snapshot diff key survives a separator in the caller text', () => {
  it('does not let a q and a selector run together into one key', async () => {
    const first = await snapshot({ selector: 'a', q: 'b||c', surfaceId: 'surf-key-1' });
    expect(first.content[0].text).toContain('button name="Save"');

    // Different arguments, same surface: a different rendering, so the full
    // listing — not "(no changes since previous snapshot)" about the other one.
    const second = await snapshot({ selector: 'a||b', q: 'c', surfaceId: 'surf-key-1' });
    expect(second.content[0].text).not.toContain('no changes since previous snapshot');
    expect(second.content[0].text).toContain('button name="Save"');
  });

  it('still diffs a repeat of the very same question', async () => {
    await snapshot({ selector: 'a', q: 'b||c', surfaceId: 'surf-key-2' });

    const again = await snapshot({ selector: 'a', q: 'b||c', surfaceId: 'surf-key-2' });
    expect(again.content[0].text).toContain('no changes since previous snapshot');
  });
});
