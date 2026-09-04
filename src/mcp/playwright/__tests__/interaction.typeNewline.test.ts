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
    getInstance: () => ({
      getPageForScope: getPage,
      drainLocalLifecycle: () => [],
      resolveWorkspaceBackend: async () => 'playwright',
    }),
  },
}));

import { registerInteractionTools } from '../tools/interaction';
import { ActionRing } from '../../browser-replay/actionRing';

// `Input.insertText` — the only way to type that survives a CJK IME and a
// React controlled input — puts a `\n` into the field verbatim, where a
// single-line input drops it and a rich-text editor never sees the keydown it
// listens for. Instagram's caption came out as one paragraph and the user
// pressed Enter eight times by hand (dogfood 2026-09-04).

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const ring = new ActionRing();
const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test'), actionRing: ring };

const tools = new Map<string, ToolHandler>();
registerInteractionTools(
  {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as never,
  browserToolDeps as never,
);

const type = tools.get('browser_type') as ToolHandler;

/** A page that writes every fill / press / insert into one ordered transcript. */
function makePage() {
  const log: string[] = [];
  const page = {
    log,
    url: () => 'https://example.test/compose',
    title: async () => 'Compose',
    innerText: async () => 'body text',
    on: () => undefined,
    mainFrame: () => ({ id: 'main' }),
    context: () => ({
      newCDPSession: async () => ({
        send: vi.fn(async () => ({})),
        detach: vi.fn(() => Promise.resolve()),
      }),
    }),
    locator: (sel?: string) => ({
      count: async () => 1,
      first: () => ({
        elementHandle: async () => null,
        click: async () => { log.push('click'); },
        fill: async (value: string) => { log.push(`fill(${sel}):${value}`); },
        evaluate: async () => false,
      }),
    }),
    keyboard: {
      press: async (key: string) => { log.push(`press:${key}`); },
      insertText: async (text: string) => { log.push(`insert:${text}`); },
    },
    mouse: { move: async () => undefined },
    viewportSize: () => ({ width: 1280, height: 720 }),
    getByRole: vi.fn(),
  };
  return page;
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  ring.clear();
});

describe('browser_type newline mode', () => {
  it('leaves \\n in the text by default, exactly as before', async () => {
    const page = makePage();
    getPage.mockResolvedValue(page);

    const result = await type({ selector: '#caption', text: 'one\ntwo', surfaceId: 'surf-1' });

    expect(result.isError).toBeUndefined();
    expect(page.log).toEqual(['fill(#caption):one\ntwo']);
  });

  it('presses Enter between the lines and inserts each one after it', async () => {
    const page = makePage();
    getPage.mockResolvedValue(page);

    const result = await type({
      selector: '#caption',
      text: 'one\ntwo\nthree',
      newline: 'enter',
      surfaceId: 'surf-1',
    });

    expect(page.log).toEqual([
      'fill(#caption):one',
      'press:Enter',
      'insert:two',
      'press:Enter',
      'insert:three',
    ]);
    // The receipt says how many keypresses were spent, so a caller can tell a
    // field that swallowed them from one that never got them.
    expect(result.content[0].text).toContain('as 3 lines (Enter between them)');
  });

  it('sends Shift+Enter for an editor that submits on a bare Enter', async () => {
    const page = makePage();
    getPage.mockResolvedValue(page);

    await type({
      selector: '#caption',
      text: 'one\ntwo',
      newline: 'shift-enter',
      surfaceId: 'surf-1',
    });

    expect(page.log).toEqual(['fill(#caption):one', 'press:Shift+Enter', 'insert:two']);
  });

  it('makes a blank line with the keypress alone, inserting nothing for it', async () => {
    const page = makePage();
    getPage.mockResolvedValue(page);

    await type({ selector: '#caption', text: 'a\n\nb', newline: 'enter', surfaceId: 'surf-1' });

    expect(page.log).toEqual([
      'fill(#caption):a',
      'press:Enter',
      'press:Enter',
      'insert:b',
    ]);
  });

  it('records the mode, so a replay of the step splits the text the same way', async () => {
    const page = makePage();
    getPage.mockResolvedValue(page);

    await type({ selector: '#caption', text: 'one\ntwo', newline: 'enter', surfaceId: 'surf-1' });

    expect(ring.all()[0].step.args).toMatchObject({ text: 'one\ntwo', newline: 'enter' });
  });

  it('splits the same way over the RPC transport', async () => {
    getPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation(async (method: string) =>
      method === 'browser.evaluate' ? { value: 'no' } : {},
    );

    await type({ ref: '4', text: 'one\ntwo', newline: 'enter', surfaceId: 'surf-1' });

    const sent = mockSendRpc.mock.calls
      .filter(([method]) => method === 'browser.type.cdp' || method === 'browser.press.cdp')
      .map(([method, params]) => {
        const p = params as { text?: string; key?: string };
        return `${method}:${p.text ?? p.key}`;
      });
    expect(sent).toEqual([
      'browser.type.cdp:one',
      'browser.press.cdp:Enter',
      'browser.type.cdp:two',
    ]);
  });
});
