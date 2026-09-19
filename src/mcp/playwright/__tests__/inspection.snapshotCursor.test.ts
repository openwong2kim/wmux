import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage, lifecycleEntries } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  lifecycleEntries: { value: [] as Array<{ type: string; url?: string; ts: number }> },
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) => {
    if (method.startsWith('browser.lease.')) return Promise.resolve({ token: null });
    if (method === 'browser.lifecycle.get') {
      // Drained destructively, exactly as main's ring behaves.
      const entries = lifecycleEntries.value;
      lifecycleEntries.value = [];
      return Promise.resolve({ entries });
    }
    return mockSendRpc(method, ...args);
  },
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, drainLocalLifecycle: () => [] }),
  },
}));

import { registerInspectionTools } from '../tools/inspection';
import { inputSchemaDeclaresMaxBytes, wrapHandlerWithResultCap } from '../../resultCap';
import { CURSOR_EXPIRED_PREFIX, END_OF_CAPTURE_NOTE } from '../snapshotCursor';

/**
 * browser_snapshot's continuation cursor, end to end through the tool.
 *
 * Driven on the RPC lane (no live Page), so every snapshot is the DOM
 * interactive listing and the text is fully under the test's control — the same
 * harness inspection.snapshotDiffKey.test.ts uses. The listing below is large
 * enough to overflow the 50 000-character window, which is what puts a cursor
 * on the result in the first place.
 */

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

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

/**
 * The same tool as the real lane composes it: src/mcp/index.ts wraps every
 * handler with the dispatch-layer result cap at registration, so a window that
 * overran the byte cap would come back with its middle elided.
 */
const cappedTools = new Map<string, ToolHandler>();
registerInspectionTools(
  {
    tool: (name: string, _desc: string, schema: unknown, handler: ToolHandler) => {
      cappedTools.set(
        name,
        wrapHandlerWithResultCap(handler, {
          declaresMaxBytes: inputSchemaDeclaresMaxBytes(schema),
        }) as ToolHandler,
      );
    },
  } as never,
  browserToolDeps as never,
);
const cappedSnapshot = cappedTools.get('browser_snapshot');
if (!cappedSnapshot) throw new Error('browser_snapshot failed to register under the result cap');

/** A drained-events block rides in its own content block at index 0. */
function textOf(result: ToolResult): string {
  return result.content[result.content.length - 1].text;
}

function cursorOf(text: string): string | undefined {
  return /cursor:"([^"]+)"/.exec(text)?.[1];
}

/** ~2 800 listing lines: comfortably past one 50 000-character window. */
function listing(url: string, count = 2800): string {
  const lines = [
    'Page: Big Settings',
    `URL: ${url}`,
    '',
    'Interactive elements (use ref number for click/fill/type):',
  ];
  for (let i = 0; i < count; i++) {
    lines.push(`  [ref=${i}] button name="Row ${i} action with a reasonably long label"`);
  }
  return lines.join('\n');
}

const BIG = listing('https://x.test/settings');

beforeEach(() => {
  lifecycleEntries.value = [];
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({ value: BIG });
  getPage.mockReset();
  getPage.mockResolvedValue(null);
});

describe('a truncated snapshot offers a cursor over the same capture', () => {
  it('walks first window → continuation → exhaustion without re-reading the page', async () => {
    const first = textOf(await snapshot({ surfaceId: 'surf-walk' }));
    expect(first).toContain('truncated at line ');
    expect(first).toContain('to continue this same capture (no re-read).');
    const token = cursorOf(first);
    expect(token).toBeTruthy();

    // Every page-reading call so far, and none may happen from here on.
    const readsBefore = mockSendRpc.mock.calls.length;
    const pageCallsBefore = getPage.mock.calls.length;

    const windows = [first];
    let next = token;
    while (next) {
      const text = textOf(await snapshot({ cursor: next, surfaceId: 'surf-walk' }));
      windows.push(text);
      next = cursorOf(text);
    }

    expect(windows.length).toBeGreaterThan(1);
    expect(windows[windows.length - 1]).toContain(END_OF_CAPTURE_NOTE);
    expect(mockSendRpc.mock.calls.length).toBe(readsBefore);
    expect(getPage.mock.calls.length).toBe(pageCallsBefore);

    // Line granularity: the windows reassemble byte-exactly once each closing
    // line is stripped, so no listing line was ever cut in half and no ref was
    // delivered twice.
    const body = windows.map((w) => w.split('\n').slice(0, -1).join('\n')).join('\n');
    expect(body).toBe(`[snapshot: full]\n${BIG}`);

    // Refs the FIRST window never showed arrive verbatim later, which is what
    // keeps them resolvable: they are the numbers the one capture minted.
    const lateRef = '[ref=2799] button name="Row 2799 action with a reasonably long label"';
    expect(first).not.toContain(lateRef);
    expect(windows[windows.length - 1]).toContain(lateRef);
  });

  it('answers a cursor past the end with the end-of-capture line, not an error', async () => {
    const first = textOf(await snapshot({ surfaceId: 'surf-end' }));
    let token = cursorOf(first);
    let text = first;
    while (token) {
      text = textOf(await snapshot({ cursor: token, surfaceId: 'surf-end' }));
      token = cursorOf(text);
    }
    expect(text).toContain(END_OF_CAPTURE_NOTE);
    expect(text).not.toContain('truncated at line ');
  });
});

describe('a window survives the dispatch-layer byte cap intact', () => {
  it('never lets the cap elide the middle of a CJK window it promised to continue', async () => {
    // ~2 000 Korean lines: ~3x the bytes of their character count, so a
    // characters-only window would have been ~150 KB against the 64 KiB cap and
    // come back with a hole in the middle — while its trailer still said
    // "continue from line N".
    const lines = [
      'Page: 설정',
      'URL: https://x.test/ko',
      '',
      'Interactive elements (use ref number for click/fill/type):',
    ];
    for (let i = 0; i < 2000; i++) {
      lines.push(`  [ref=${i}] button name="${i}번째 행에 대한 아주 긴 설명이 붙은 작업 항목"`);
    }
    const ko = lines.join('\n');
    mockSendRpc.mockResolvedValue({ value: ko });

    const windows: string[] = [];
    let next: string | undefined;
    do {
      const args = next ? { cursor: next, surfaceId: 'surf-ko' } : { surfaceId: 'surf-ko' };
      const text = textOf(await cappedSnapshot(args));
      // The cap's own marker: its presence would mean lines were dropped that no
      // cursor can reach.
      expect(text).not.toContain('bytes shown]');
      windows.push(text);
      next = cursorOf(text);
    } while (next);

    expect(windows.length).toBeGreaterThan(2);
    const body = windows.map((w) => w.split('\n').slice(0, -1).join('\n')).join('\n');
    expect(body).toBe(`[snapshot: full]\n${ko}`);
  });
});

describe('a cursor is never combined with the other parameters', () => {
  it('ignores format/selector/q/full and says which', async () => {
    const token = cursorOf(textOf(await snapshot({ surfaceId: 'surf-ignore' })));
    const text = textOf(
      await snapshot({
        cursor: token,
        format: 'aria',
        selector: '[role=dialog]',
        q: 'Row 9',
        full: true,
        surfaceId: 'surf-ignore',
      }),
    );
    expect(text).toContain('cursor continues the stored capture');
    for (const name of ['format', 'selector', 'q', 'full']) expect(text).toContain(name);
    // Not a diff, and not a re-read: a window of the capture already in hand.
    expect(text).not.toContain('no changes since previous snapshot');
    expect(text).not.toContain('[snapshot:');
  });

  it('leaves the diff baseline alone, so the next real snapshot still diffs', async () => {
    const token = cursorOf(textOf(await snapshot({ surfaceId: 'surf-baseline' })));
    await snapshot({ cursor: token, surfaceId: 'surf-baseline' });

    const again = textOf(await snapshot({ surfaceId: 'surf-baseline' }));
    expect(again).toContain('no changes since previous snapshot');
  });
});

describe('an invalid cursor fails loudly', () => {
  it('reports cursor_expired for a token that was never minted', async () => {
    const result = await snapshot({ cursor: 'bm90LWEtdG9rZW4', surfaceId: 'surf-bogus' });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
    expect(textOf(result)).toContain('Take a fresh snapshot');
  });

  it('retires the capture when the surface is snapshotted again', async () => {
    const token = cursorOf(textOf(await snapshot({ surfaceId: 'surf-resnap' })));
    // A repeat of the same page diffs down to one short line, so the new result
    // fits a window and the capture behind the old cursor is retired with it.
    const repeat = textOf(await snapshot({ surfaceId: 'surf-resnap' }));
    expect(repeat).toContain('no changes since previous snapshot');

    const result = await snapshot({ cursor: token, surfaceId: 'surf-resnap' });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
  });

  it('retires the capture when the surface navigates', async () => {
    const token = cursorOf(textOf(await snapshot({ surfaceId: 'surf-nav' })));

    // The lifecycle ring this call's pre-drain will read.
    lifecycleEntries.value = [{ type: 'navigated', url: 'https://x.test/other', ts: Date.now() }];
    const result = await snapshot({ cursor: token, surfaceId: 'surf-nav' });

    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(CURSOR_EXPIRED_PREFIX)).toBe(true);
  });
});
