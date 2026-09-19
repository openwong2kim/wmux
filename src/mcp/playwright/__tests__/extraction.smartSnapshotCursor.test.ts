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

import { registerExtractionTools } from '../tools/extraction';
import { CURSOR_EXPIRED_PREFIX, END_OF_CAPTURE_NOTE } from '../snapshotCursor';

/**
 * browser_smart_snapshot's half of the continuation cursor. Same contract as
 * browser_snapshot's (inspection.snapshotCursor.test.ts): a result too big for
 * one window is stored once and paged, and the page is never read again.
 *
 * Driven on the RPC lane (no live Page), where the tool's whole output is the
 * object this test hands back from browser.evaluate.
 */

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

const tools = new Map<string, ToolHandler>();
registerExtractionTools(
  {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as never,
  browserToolDeps as never,
);
const smart = tools.get('browser_smart_snapshot');
if (!smart) throw new Error('browser_smart_snapshot failed to register');

function textOf(result: ToolResult): string {
  return result.content[result.content.length - 1].text;
}

function cursorOf(text: string): string | undefined {
  return /cursor:"([^"]+)"/.exec(text)?.[1];
}

/** ~90 000 characters of page text — well past one 50 000-character window. */
const CONTENT = Array.from({ length: 1500 }, (_, i) => `Paragraph ${i}: ${'text '.repeat(10)}`).join('\n');
const PAYLOAD = {
  value: {
    url: 'https://x.test/long',
    title: 'Long Page',
    content: CONTENT,
    elements: [{ ref: 1, role: 'button', name: 'Save' }],
  },
};

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue(PAYLOAD);
  getPage.mockReset();
  getPage.mockResolvedValue(null);
});

describe('browser_smart_snapshot continuation cursor', () => {
  it('pages a long listing to exhaustion without re-reading the page', async () => {
    const first = textOf(await smart({ maxContentLength: 100000, surfaceId: 'smart-walk' }));
    expect(first).toContain('truncated at line ');
    let token = cursorOf(first);
    expect(token).toBeTruthy();

    const readsBefore = mockSendRpc.mock.calls.length;
    const windows = [first];
    while (token) {
      const text = textOf(await smart({ cursor: token, surfaceId: 'smart-walk' }));
      windows.push(text);
      token = cursorOf(text);
    }

    expect(windows[windows.length - 1]).toContain(END_OF_CAPTURE_NOTE);
    expect(mockSendRpc.mock.calls.length).toBe(readsBefore);
    // The element listing is in the first window; the tail of the page text is
    // only reachable through the cursor.
    expect(first).toContain('[1] button "Save"');
    expect(first).not.toContain('Paragraph 1499');
    expect(windows.slice(1).join('\n')).toContain('Paragraph 1499');
  });

  it('reports maxContentLength and full as ignored with a cursor', async () => {
    const token = cursorOf(textOf(await smart({ maxContentLength: 100000, surfaceId: 'smart-ignore' })));
    const text = textOf(
      await smart({ cursor: token, maxContentLength: 500, full: true, surfaceId: 'smart-ignore' }),
    );
    expect(text).toContain('cursor continues the stored capture');
    expect(text).toContain('maxContentLength');
    expect(text).toContain('full');
  });

  it('puts its caveats in the FIRST window, under the header line', async () => {
    const first = textOf(await smart({ maxContentLength: 100000, surfaceId: 'smart-notes' }));
    const head = first.split('\n').slice(0, 3);
    expect(head[0]).toContain('[snapshot:');
    // The RPC lane's "no diff on this backend" caveat is what the agent needs
    // while reading window 1 — appended, it only reached the last one.
    expect(head.join('\n')).toContain('no diff on this backend');
  });

  it('honours a raised maxBytes with bigger windows instead of ignoring it', async () => {
    const small = textOf(await smart({ maxContentLength: 100000, surfaceId: 'smart-cap-small' }));
    const large = textOf(
      await smart({ maxContentLength: 100000, maxBytes: 524288, surfaceId: 'smart-cap-large' }),
    );
    expect(large.length).toBeGreaterThan(small.length);
    // maxBytes is honoured, so it is NOT in the ignored-parameters list.
    const token = cursorOf(small);
    if (token) {
      const cont = textOf(await smart({ cursor: token, maxBytes: 524288, surfaceId: 'smart-cap-small' }));
      expect(cont).not.toContain('maxBytes');
    }
  });

  it('retires the capture when the surface is smart-snapshotted again', async () => {
    const token = cursorOf(textOf(await smart({ maxContentLength: 100000, surfaceId: 'smart-resnap' })));
    // A short page next: the result fits one window, so the old capture goes.
    mockSendRpc.mockResolvedValue({
      value: { url: 'https://x.test/long', title: 'Long Page', content: 'tiny', elements: [] },
    });
    await smart({ surfaceId: 'smart-resnap' });

    const result = await smart({ cursor: token, surfaceId: 'smart-resnap' });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
  });
});
