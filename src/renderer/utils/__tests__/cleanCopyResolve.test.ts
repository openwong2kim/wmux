import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AssistantTextEvent, CodeBlockRef, TranscriptPage, TurnEvent } from '../../../shared/transcript/turnEvents';

const cleanCopyText = vi.fn();
vi.mock('../agentReplyCopy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agentReplyCopy')>()),
  cleanCopyText: (...args: unknown[]) => cleanCopyText(...args),
}));

import { CLEAN_COPY_TIMEOUT_MS, createCopySequence, forgetNoTranscript, resolveCopyText, type CleanCopyDeps } from '../cleanCopyResolve';

const NUL = '\u0000';
/** Two screen rows: a one-row selection never asks the transcript. */
const SEL = 'sel\nrow two';

function reply(id: string, text: string, codeBlocks?: CodeBlockRef[], extra: Partial<AssistantTextEvent> = {}): AssistantTextEvent {
  return { id, kind: 'assistant_text', text, ...(codeBlocks ? { codeBlocks } : {}), ...extra };
}

function page(events: TurnEvent[]): TranscriptPage {
  return {
    events,
    cursor: { headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 },
    hasMore: false,
    truncatedHead: false,
  };
}

function deps(events: TurnEvent[], bodies: Record<string, string> = {}): CleanCopyDeps & {
  snapshot: ReturnType<typeof vi.fn>; codeBlock: ReturnType<typeof vi.fn>;
} {
  return {
    snapshot: vi.fn(async () => page(events)),
    codeBlock: vi.fn(async ({ eventId, n }: { eventId?: string; n: number }) => {
      const body = bodies[`${eventId}:${n}`];
      return body === undefined ? null : { body };
    }),
  };
}

/** The replies cleanCopyText was last handed. */
function repliesSeen(): unknown[] {
  return cleanCopyText.mock.calls.at(-1)?.[1] as unknown[];
}

beforeEach(() => {
  forgetNoTranscript();
  cleanCopyText.mockReset();
  cleanCopyText.mockReturnValue('CLEAN');
});

describe('resolveCopyText — raw fallbacks', () => {
  it('returns the selection without a snapshot when ptyId is missing', async () => {
    const d = deps([reply('a', 'hi')]);
    expect(await resolveCopyText(undefined, SEL, d)).toBe(SEL);
    expect(await resolveCopyText('', SEL, d)).toBe(SEL);
    expect(d.snapshot).not.toHaveBeenCalled();
  });

  it('returns a one-row selection with nothing added at its ends without a snapshot', async () => {
    const d = deps([reply('a', 'hi')]);
    expect(await resolveCopyText('p1', 'hi there', d)).toBe('hi there');
    expect(d.snapshot).not.toHaveBeenCalled();
  });

  it('reads the transcript for a one-row selection with a margin, padding or reply marker', async () => {
    for (const row of ['  Done.', 'Done.  ', '⏺ hi there', '● hi there']) {
      const d = deps([reply('a', 'hi')]);
      expect(await resolveCopyText('p1', row, d)).toBe('CLEAN');
      expect(d.snapshot).toHaveBeenCalledTimes(1);
    }
  });

  it('returns an empty or over-64KB selection without a snapshot', async () => {
    const d = deps([reply('a', 'hi')]);
    expect(await resolveCopyText('p1', '', d)).toBe('');
    const big = 'x'.repeat(64 * 1024 + 1);
    expect(await resolveCopyText('p1', big, d)).toBe(big);
    expect(d.snapshot).not.toHaveBeenCalled();
  });

  it('returns the selection when the snapshot is null', async () => {
    const d = deps([]);
    d.snapshot.mockResolvedValue(null);
    expect(await resolveCopyText('p1', SEL, d)).toBe(SEL);
    expect(cleanCopyText).not.toHaveBeenCalled();
  });

  it('returns the selection when the snapshot throws or rejects', async () => {
    const d = deps([]);
    d.snapshot.mockRejectedValue(new Error('daemon gone'));
    expect(await resolveCopyText('p1', SEL, d)).toBe(SEL);
    d.snapshot.mockImplementation(() => { throw new Error('sync'); });
    expect(await resolveCopyText('p1', SEL, d)).toBe(SEL);
  });

  it('returns the selection when cleanCopyText declines', async () => {
    cleanCopyText.mockReturnValue(null);
    expect(await resolveCopyText('p1', SEL, deps([reply('a', 'hi')]))).toBe(SEL);
  });

  it('returns the selection when there is no chat bridge', async () => {
    expect(await resolveCopyText('p1', SEL, null)).toBe(SEL);
  });

  describe('timeout', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('returns the selection once the snapshot takes longer than the cap', async () => {
      const d = deps([]);
      d.snapshot.mockReturnValue(new Promise(() => undefined));
      const result = resolveCopyText('p1', SEL, d);
      await vi.advanceTimersByTimeAsync(CLEAN_COPY_TIMEOUT_MS);
      expect(await result).toBe(SEL);
    });

    it('starts no code-body fetch once the cap has passed', async () => {
      let answer!: (p: TranscriptPage) => void;
      const d = deps([]);
      d.snapshot.mockReturnValue(new Promise((r) => { answer = r; }));
      const result = resolveCopyText('p1', SEL, d);
      await vi.advanceTimersByTimeAsync(CLEAN_COPY_TIMEOUT_MS);
      expect(await result).toBe(SEL);
      answer(page([reply('a', `x${NUL}code:0${NUL}`, [{ n: 0, lines: 1, srcOffset: 5 }])]));
      await vi.advanceTimersByTimeAsync(0);
      expect(d.codeBlock).not.toHaveBeenCalled();
    });

    it('does not ask a pane without a transcript again for a while', async () => {
      const d = deps([]);
      d.snapshot.mockResolvedValue(null);
      expect(await resolveCopyText('p1', SEL, d)).toBe(SEL);
      expect(await resolveCopyText('p1', SEL, d)).toBe(SEL);
      expect(d.snapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await resolveCopyText('p1', SEL, d);
      expect(d.snapshot).toHaveBeenCalledTimes(2);
    });

    it('counts the code bodies inside the same cap', async () => {
      const d = deps([reply('a', `x${NUL}code:0${NUL}`, [{ n: 0, lines: 1, srcOffset: 5 }])]);
      d.codeBlock.mockReturnValue(new Promise(() => undefined));
      const result = resolveCopyText('p1', SEL, d);
      await vi.advanceTimersByTimeAsync(CLEAN_COPY_TIMEOUT_MS);
      expect(await result).toBe(SEL);
      expect(cleanCopyText).not.toHaveBeenCalled();
    });
  });
});

describe('resolveCopyText — replies', () => {
  it('splits prose from code and places each fetched body', async () => {
    const d = deps(
      [reply('a', `Run:${NUL}code:0${NUL}then${NUL}code:1${NUL}`, [
        { n: 0, lines: 1, lang: 'sh', srcOffset: 10 },
        { n: 1, lines: 2, srcOffset: 10 },
      ])],
      { 'a:0': 'npm test', 'a:1': 'one\ntwo' },
    );
    expect(await resolveCopyText('p1', SEL, d)).toBe('CLEAN');
    expect(cleanCopyText).toHaveBeenCalledWith(SEL, [[
      { kind: 'prose', text: 'Run:' },
      { kind: 'code', body: 'npm test', lang: 'sh' },
      { kind: 'prose', text: 'then' },
      { kind: 'code', body: 'one\ntwo' },
    ]]);
    expect(d.codeBlock).toHaveBeenCalledWith({ ptyId: 'p1', srcOffset: 10, n: 0, eventId: 'a' });
    expect(d.codeBlock).toHaveBeenCalledWith({ ptyId: 'p1', srcOffset: 10, n: 1, eventId: 'a' });
  });

  it('reads a body once however often its reply is copied from', async () => {
    const d = deps([reply('a', `Run:${NUL}code:1${NUL}`, [{ n: 1, lines: 1, srcOffset: 10 }])], { 'a:1': 'npm test' });
    await resolveCopyText('p1', SEL, d);
    await resolveCopyText('p1', SEL, d);
    expect(d.codeBlock).toHaveBeenCalledTimes(1);
    expect(repliesSeen()).toEqual([[{ kind: 'prose', text: 'Run:' }, { kind: 'code', body: 'npm test' }]]);
  });

  it('leaves out the space between two blocks as a part', async () => {
    const d = deps([reply('a', `${NUL}code:1${NUL}\n\n${NUL}code:2${NUL}`, [{ n: 1, lines: 1, srcOffset: 1 }, { n: 2, lines: 1, srcOffset: 1 }])], { 'a:1': 'one', 'a:2': 'two' });
    await resolveCopyText('p1', SEL, d);
    expect(repliesSeen()).toEqual([[{ kind: 'code', body: 'one' }, { kind: 'code', body: 'two' }]]);
  });

  it('keeps only visible assistant replies, oldest first', async () => {
    const d = deps([
      { id: 'u', kind: 'user_text', text: 'question' },
      reply('t', 'pondering', undefined, { thinking: true }),
      reply('f', 'narration', undefined, { folded: true }),
      reply('a', 'first'),
      reply('b', 'second'),
    ]);
    await resolveCopyText('p1', SEL, d);
    expect(repliesSeen()).toEqual([[{ kind: 'prose', text: 'first' }], [{ kind: 'prose', text: 'second' }]]);
  });

  it('drops a reply whose block is truncated, keeping the others', async () => {
    const d = deps(
      [reply('a', 'kept'), reply('b', `cut${NUL}code:0${NUL}`, [{ n: 0, lines: 900, srcOffset: 1, truncated: true }])],
      { 'b:0': 'partial' },
    );
    await resolveCopyText('p1', SEL, d);
    expect(repliesSeen()).toEqual([[{ kind: 'prose', text: 'kept' }]]);
    expect(d.codeBlock).not.toHaveBeenCalled();
  });

  it('drops a reply whose block has no srcOffset, or whose fetch fails', async () => {
    const d = deps([
      reply('a', `${NUL}code:0${NUL}`, [{ n: 0, lines: 1 }]),
      reply('b', `${NUL}code:0${NUL}`, [{ n: 0, lines: 1, srcOffset: 3 }]),
      reply('c', `${NUL}code:0${NUL}`, [{ n: 0, lines: 1, srcOffset: 4 }]),
      reply('d', 'kept'),
    ], { 'c:0': 'never' });
    d.codeBlock.mockImplementation(async ({ eventId }: { eventId?: string }) => {
      if (eventId === 'c') throw new Error('read failed');
      return null; // b: unavailable
    });
    await resolveCopyText('p1', SEL, d);
    expect(repliesSeen()).toEqual([[{ kind: 'prose', text: 'kept' }]]);
  });

  it('caps the replies at the latest 20', async () => {
    const events = Array.from({ length: 25 }, (_, i) => reply(`r${i}`, `reply ${i}`));
    await resolveCopyText('p1', SEL, deps(events));
    const seen = repliesSeen();
    expect(seen).toHaveLength(20);
    expect(seen[0]).toEqual([{ kind: 'prose', text: 'reply 5' }]);
    expect(seen[19]).toEqual([{ kind: 'prose', text: 'reply 24' }]);
  });
});

describe('createCopySequence', () => {
  it('makes an older copy stale once a newer one starts', () => {
    const start = createCopySequence();
    const first = start();
    expect(first()).toBe(true);
    const second = start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
