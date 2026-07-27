import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createChatSlice,
  MAX_ROWS_IN_MEMORY,
  PENDING_ECHO_TTL_MS,
  type ChatSlice,
} from '../chatSlice';
import type {
  TranscriptCursor,
  TranscriptPage,
  TurnEvent,
} from '../../../../shared/transcript/turnEvents';

function createTestStore() {
  return create<ChatSlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createChatSlice(...args),
    })),
  );
}

function cursor(headOffset: number, tailOffset: number, extra?: Partial<TranscriptCursor>): TranscriptCursor {
  return { headOffset, tailOffset, fileSize: tailOffset, mtimeMs: 1000, ...extra };
}

function userText(id: string, text: string): TurnEvent {
  return { id, kind: 'user_text', text };
}

function assistantText(id: string, text: string): TurnEvent {
  return { id, kind: 'assistant_text', text };
}

function page(events: TurnEvent[], head: number, tail: number): TranscriptPage {
  return { events, cursor: cursor(head, tail), hasMore: head > 0, truncatedHead: head > 0 };
}

describe('chatSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with every map empty', () => {
    const s = store.getState();
    expect(s.chatEvents).toEqual({});
    expect(s.chatCursor).toEqual({});
    expect(s.chatStatus).toEqual({});
    expect(s.chatPending).toEqual({});
    expect(s.chatNeedsResnapshot).toEqual({});
  });

  describe('applyChatAppend', () => {
    it('appends deltas in order and tracks the cursor + seq', () => {
      store.getState().applyChatAppend('pty-a', {
        seq: 1,
        events: [userText('u1', 'hello')],
        cursor: cursor(0, 100),
      });
      store.getState().applyChatAppend('pty-a', {
        seq: 2,
        events: [assistantText('a1', 'hi')],
        cursor: cursor(0, 220),
      });
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'a1']);
      expect(store.getState().chatCursor['pty-a']?.tailOffset).toBe(220);
      expect(store.getState().chatSeq['pty-a']).toBe(2);
      expect(store.getState().chatNeedsResnapshot['pty-a']).toBeFalsy();
    });

    it('replaces the whole window on reset:true', () => {
      store.getState().applyChatAppend('pty-a', {
        seq: 1,
        events: [userText('u1', 'old conversation')],
        cursor: cursor(0, 100),
      });
      store.getState().applyChatAppend('pty-a', {
        seq: 7,
        reset: true,
        events: [userText('u9', 'new session')],
        cursor: cursor(0, 40),
      });
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u9']);
      expect(store.getState().chatSeq['pty-a']).toBe(7);
    });

    it('marks needs-resnapshot on a seq gap but keeps the tail moving', () => {
      store.getState().applyChatAppend('pty-a', { seq: 1, events: [userText('u1', 'a')], cursor: cursor(0, 10) });
      store.getState().applyChatAppend('pty-a', { seq: 4, events: [userText('u4', 'd')], cursor: cursor(0, 40) });
      expect(store.getState().chatNeedsResnapshot['pty-a']).toBe(true);
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'u4']);
      expect(store.getState().chatSeq['pty-a']).toBe(4);
    });

    it('clears needs-resnapshot when the reset lands', () => {
      store.getState().applyChatAppend('pty-a', { seq: 1, events: [], cursor: cursor(0, 10) });
      store.getState().applyChatAppend('pty-a', { seq: 5, events: [], cursor: cursor(0, 50) });
      expect(store.getState().chatNeedsResnapshot['pty-a']).toBe(true);
      store.getState().applyChatAppend('pty-a', {
        seq: 6,
        reset: true,
        events: [userText('u1', 'x')],
        cursor: cursor(0, 60),
      });
      expect(store.getState().chatNeedsResnapshot['pty-a']).toBe(false);
    });

    it('ignores a stale or duplicated seq instead of double-appending', () => {
      store.getState().applyChatAppend('pty-a', { seq: 2, events: [userText('u2', 'a')], cursor: cursor(0, 20) });
      store.getState().applyChatAppend('pty-a', { seq: 2, events: [userText('u2', 'a')], cursor: cursor(0, 20) });
      store.getState().applyChatAppend('pty-a', { seq: 1, events: [userText('u1', 'older')], cursor: cursor(0, 10) });
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u2']);
      expect(store.getState().chatSeq['pty-a']).toBe(2);
    });

    it('dedups by event id across an overlapping delta', () => {
      store.getState().applyChatAppend('pty-a', { seq: 1, events: [userText('u1', 'a')], cursor: cursor(0, 10) });
      store.getState().applyChatAppend('pty-a', {
        seq: 2,
        events: [userText('u1', 'a'), assistantText('a1', 'b')],
        cursor: cursor(0, 30),
      });
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'a1']);
    });

    it('head-drops past MAX_ROWS_IN_MEMORY, keeping the newest rows', () => {
      const many = Array.from({ length: MAX_ROWS_IN_MEMORY + 50 }, (_, i) => userText(`u${i}`, `t${i}`));
      store.getState().applyChatAppend('pty-a', { seq: 1, events: many, cursor: cursor(0, 10) });
      const rows = store.getState().chatEvents['pty-a'];
      expect(rows).toHaveLength(MAX_ROWS_IN_MEMORY);
      expect(rows[0].id).toBe('u50');
      expect(rows[rows.length - 1].id).toBe(`u${MAX_ROWS_IN_MEMORY + 49}`);
    });

    it('keeps panes isolated', () => {
      store.getState().applyChatAppend('pty-a', { seq: 1, events: [userText('u1', 'a')], cursor: cursor(0, 10) });
      store.getState().applyChatAppend('pty-b', { seq: 1, events: [userText('u2', 'b')], cursor: cursor(0, 10) });
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1']);
      expect(store.getState().chatEvents['pty-b'].map((e) => e.id)).toEqual(['u2']);
    });
  });

  describe('prependChatPage', () => {
    it('prepends older rows and moves only the head offset', () => {
      store.getState().applyChatAppend('pty-a', {
        seq: 1,
        events: [userText('u5', 'recent')],
        cursor: cursor(500, 900),
      });
      store.getState().prependChatPage('pty-a', page([userText('u1', 'older')], 100, 500));
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u1', 'u5']);
      expect(store.getState().chatCursor['pty-a']).toEqual({
        headOffset: 100,
        tailOffset: 900,
        fileSize: 900,
        mtimeMs: 1000,
      });
    });

    it('dedups a page that overlaps what is already held', () => {
      store.getState().applyChatAppend('pty-a', {
        seq: 1,
        events: [userText('u1', 'a'), userText('u2', 'b')],
        cursor: cursor(200, 400),
      });
      store.getState().prependChatPage('pty-a', page([userText('u0', 'z'), userText('u1', 'a')], 0, 200));
      expect(store.getState().chatEvents['pty-a'].map((e) => e.id)).toEqual(['u0', 'u1', 'u2']);
    });

    it('does not evict newer rows when the ring is already full', () => {
      const many = Array.from({ length: MAX_ROWS_IN_MEMORY }, (_, i) => userText(`u${i}`, `t${i}`));
      store.getState().applyChatAppend('pty-a', { seq: 1, events: many, cursor: cursor(500, 900) });
      store.getState().prependChatPage('pty-a', page([userText('older', 'x')], 0, 500));
      const rows = store.getState().chatEvents['pty-a'];
      expect(rows).toHaveLength(MAX_ROWS_IN_MEMORY);
      expect(rows[rows.length - 1].id).toBe(`u${MAX_ROWS_IN_MEMORY - 1}`);
      expect(rows.some((e) => e.id === 'older')).toBe(false);
    });

    it('seeds the cursor when nothing is held yet', () => {
      store.getState().prependChatPage('pty-a', page([userText('u1', 'a')], 40, 90));
      expect(store.getState().chatCursor['pty-a']).toEqual({
        headOffset: 40,
        tailOffset: 90,
        fileSize: 90,
        mtimeMs: 1000,
      });
    });
  });

  describe('pending echo reconciliation', () => {
    it('renders an echo on push and drops it when the matching user_text arrives', () => {
      store.getState().pushChatPending('pty-a', 'run the tests');
      expect(store.getState().chatPending['pty-a']).toHaveLength(1);
      store.getState().applyChatAppend('pty-a', {
        seq: 1,
        events: [userText('u1', 'run the tests')],
        cursor: cursor(0, 10),
      });
      expect(store.getState().chatPending['pty-a']).toHaveLength(0);
    });

    it('matches across reflowed whitespace', () => {
      store.getState().pushChatPending('pty-a', 'line one\nline two');
      store.getState().applyChatAppend('pty-a', {
        seq: 1,
        events: [userText('u1', 'line one line two')],
        cursor: cursor(0, 10),
      });
      expect(store.getState().chatPending['pty-a']).toHaveLength(0);
    });

    it('keeps an unrelated echo pending', () => {
      store.getState().pushChatPending('pty-a', 'my message');
      store.getState().applyChatAppend('pty-a', {
        seq: 1,
        events: [assistantText('a1', 'unrelated')],
        cursor: cursor(0, 10),
      });
      expect(store.getState().chatPending['pty-a']).toHaveLength(1);
    });

    it('drops an unmatched echo older than the TTL', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1_000_000));
      store.getState().pushChatPending('pty-a', 'never landed');
      store.getState().reconcileChatPending('pty-a', 1_000_000 + PENDING_ECHO_TTL_MS - 1);
      expect(store.getState().chatPending['pty-a']).toHaveLength(1);
      store.getState().reconcileChatPending('pty-a', 1_000_000 + PENDING_ECHO_TTL_MS + 1);
      expect(store.getState().chatPending['pty-a']).toHaveLength(0);
    });

    it('gives concurrent echoes distinct ids', () => {
      store.getState().pushChatPending('pty-a', 'one');
      store.getState().pushChatPending('pty-a', 'two');
      const [a, b] = store.getState().chatPending['pty-a'];
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('clearChatSurface', () => {
    it('forgets every map for that pane only', () => {
      store.getState().applyChatAppend('pty-a', { seq: 1, events: [userText('u1', 'a')], cursor: cursor(0, 10) });
      store.getState().setChatStatus('pty-a', { available: true, reason: 'ok' });
      store.getState().pushChatPending('pty-a', 'x');
      store.getState().applyChatAppend('pty-b', { seq: 1, events: [userText('u2', 'b')], cursor: cursor(0, 10) });

      store.getState().clearChatSurface('pty-a');

      const s = store.getState();
      expect(s.chatEvents['pty-a']).toBeUndefined();
      expect(s.chatCursor['pty-a']).toBeUndefined();
      expect(s.chatStatus['pty-a']).toBeUndefined();
      expect(s.chatSeq['pty-a']).toBeUndefined();
      expect(s.chatPending['pty-a']).toBeUndefined();
      expect(s.chatEvents['pty-b']).toBeDefined();
    });
  });

  // Structural guard: chat state is transient. buildSessionData (AppLayout) is
  // an EXPLICIT allowlist, so a leak can only happen by someone adding a
  // `state.chat*` line — this scan fails the moment they do.
  it('never enters buildSessionData (session persistence allowlist)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'components', 'Layout', 'AppLayout.tsx'),
      'utf-8',
    );
    expect(src).not.toMatch(/state\.chat(Events|Cursor|Status|Seq|Pending|NeedsResnapshot)\b/);
  });
});
