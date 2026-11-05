// Scrollback bookmarks (Ctrl+M) stay on the line they were set on. They used
// to be stored as baseY + viewportY, which counts baseY twice (viewportY is
// already absolute), so k lines of output while scrolled up moved the dot k
// rows onto other text. Driven through a headless xterm, which has the same
// marker API as the browser one.
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUISlice, type UISlice } from '../../../stores/slices/uiSlice';
import { addAt, keepAcrossRepaint, logicalLine, rowsInView, watchScrollbackBookmarks } from '../scrollbackBookmarks';

function createTestStore() {
  return create<UISlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createUISlice(...args),
    })),
  );
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function lines(from: number, count: number): string {
  let out = '';
  for (let i = from; i < from + count; i++) out += `line-${i}\r\n`;
  return out;
}

// 30 columns each: one row at 40 columns, two at 20.
function longLines(from: number, count: number): string {
  let out = '';
  for (let i = from; i < from + count; i++) out += `entry-${String(i).padStart(4, '0')}-`.padEnd(30, 'x') + '\r\n';
  return out;
}

function textAt(term: Terminal, line: number): string {
  return term.buffer.active.getLine(line)?.translateToString(true) ?? '';
}

describe('scrollback bookmarks', () => {
  it('stays on its line and its row while output streams in below', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 100));
    term.scrollLines(-30);
    const viewportY = term.buffer.active.viewportY;
    const text = textAt(term, viewportY);
    expect(text).toMatch(/^line-\d+$/);

    expect(addAt(term, 'pty-a', store)).toBe('added');
    expect(addAt(term, 'pty-a', store)).toBe('exists');
    const ids = store.getState().terminalBookmarks['pty-a'];
    expect(ids).toHaveLength(1);
    expect(rowsInView(term, ids)).toEqual([{ id: ids[0], row: 0 }]);

    await write(term, lines(100, 200));

    expect(term.buffer.active.viewportY).toBe(viewportY);
    expect(rowsInView(term, ids)).toEqual([{ id: ids[0], row: 0 }]);
    const marker = term.markers.find((m) => m.id === ids[0]);
    expect(marker && textAt(term, marker.line)).toBe(text);
    term.dispose();
  });

  it('is dropped, id and all, when its line leaves a full scrollback', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 50, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 30));
    expect(addAt(term, 'pty-b', store)).toBe('added');
    const ids = store.getState().terminalBookmarks['pty-b'];
    expect(ids).toHaveLength(1);

    await write(term, lines(30, 300));

    expect(term.markers.some((m) => m.id === ids[0])).toBe(false);
    expect(store.getState().terminalBookmarks['pty-b']).toBeUndefined();
    expect(rowsInView(term, ids)).toEqual([]);
    term.dispose();
  });

  it('adds nothing on the alternate screen', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 30));
    await write(term, '\x1b[?1049h');
    expect(term.buffer.active.type).toBe('alternate');

    expect(addAt(term, 'pty-c', store)).toBe('alternate');
    expect(store.getState().terminalBookmarks['pty-c']).toBeUndefined();
    expect(term.markers).toHaveLength(0);
    term.dispose();
  });

  it('leaves the store when its terminal is disposed', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 30));
    expect(addAt(term, 'pty-d', store)).toBe('added');
    expect(store.getState().terminalBookmarks['pty-d']).toHaveLength(1);

    term.dispose();

    expect(store.getState().terminalBookmarks['pty-d']).toBeUndefined();
  });

  it('disposes its marker when the store drops its id', async () => {
    const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
    const store = createTestStore();
    await write(term, lines(0, 30));
    expect(addAt(term, 'pty-e', store)).toBe('added');
    expect(term.markers).toHaveLength(1);
    const stop = watchScrollbackBookmarks(store, (ptyId) => (ptyId === 'pty-e' ? term : undefined));

    store.getState().clearBookmarks('pty-e');

    expect(term.markers).toHaveLength(0);
    stop();
    term.dispose();
  });

  describe('across a repaint (reset, then the session replayed)', () => {
    async function bookmarked(ptyId: string, cols = 40) {
      const term = new Terminal({ cols, rows: 10, scrollback: 1000, allowProposedApi: true });
      const store = createTestStore();
      await write(term, longLines(0, 100));
      term.scrollLines(-30);
      const text = textAt(term, term.buffer.active.viewportY);
      expect(addAt(term, ptyId, store)).toBe('added');
      return { term, store, text };
    }

    it('comes back on the same text when the replay is the same, in two store sets', async () => {
      const { term, store, text } = await bookmarked('pty-f');
      term.scrollLines(-5);
      const text2 = textAt(term, term.buffer.active.viewportY);
      expect(addAt(term, 'pty-f', store)).toBe('added');
      let sets = 0;
      const unsubscribe = store.subscribe(() => { sets++; });

      const restore = keepAcrossRepaint(term, 'pty-f', store);
      term.reset();
      expect(store.getState().terminalBookmarks['pty-f']).toBeUndefined();
      await write(term, longLines(0, 100));
      restore(term);

      unsubscribe();
      expect(sets).toBe(2);
      const ids = store.getState().terminalBookmarks['pty-f'];
      expect(ids).toHaveLength(2);
      const texts = ids.map((id) => {
        const marker = term.markers.find((m) => m.id === id);
        return marker && textAt(term, marker.line);
      });
      expect(texts.sort()).toEqual([text, text2].sort());
      term.dispose();
    });

    it('comes back on its own text when output arrived while the pane was hidden', async () => {
      const { term, store, text } = await bookmarked('pty-g');

      const restore = keepAcrossRepaint(term, 'pty-g', store);
      term.reset();
      await write(term, longLines(0, 105));
      restore(term);

      const ids = store.getState().terminalBookmarks['pty-g'];
      expect(ids).toHaveLength(1);
      const marker = term.markers.find((m) => m.id === ids[0]);
      expect(marker && textAt(term, marker.line)).toBe(text);
      term.dispose();
    });

    it('is dropped, not moved, when the line above it changed', async () => {
      const { term, store, text } = await bookmarked('pty-j');
      const n = Number(/^entry-(\d+)-/.exec(text)?.[1]);

      const restore = keepAcrossRepaint(term, 'pty-j', store);
      term.reset();
      await write(term, longLines(0, n - 1) + 'changed\r\n' + longLines(n, 100 - n));
      restore(term);

      expect(store.getState().terminalBookmarks['pty-j']).toBeUndefined();
      expect(term.markers).toHaveLength(0);
      term.dispose();
    });

    it('drops a bookmark on a blank line, which nothing tells apart', async () => {
      const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
      const store = createTestStore();
      const content = longLines(0, 60) + '\r\n' + longLines(60, 40);
      await write(term, content);
      term.scrollToLine(60);
      expect(textAt(term, 60)).toBe('');
      expect(addAt(term, 'pty-k', store)).toBe('added');

      const restore = keepAcrossRepaint(term, 'pty-k', store);
      term.reset();
      await write(term, content);
      restore(term);

      expect(store.getState().terminalBookmarks['pty-k']).toBeUndefined();
      term.dispose();
    });

    it('drops a bookmark on a repeated prompt it cannot single out', async () => {
      const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000, allowProposedApi: true });
      const store = createTestStore();
      const content = '$ ls\r\nok\r\n'.repeat(50);
      await write(term, content);
      term.scrollToLine(60);
      expect(textAt(term, 60)).toBe('$ ls');
      expect(addAt(term, 'pty-l', store)).toBe('added');

      const restore = keepAcrossRepaint(term, 'pty-l', store);
      term.reset();
      await write(term, content);
      restore(term);

      expect(store.getState().terminalBookmarks['pty-l']).toBeUndefined();
      term.dispose();
    });

    it('comes back on its own text when a full scrollback moved it while hidden', async () => {
      // Once the scrollback is full the cursor line stays put, so how far the
      // line moved can't be read from it; the line is still in the buffer.
      const term = new Terminal({ cols: 40, rows: 10, scrollback: 50, allowProposedApi: true });
      const store = createTestStore();
      await write(term, longLines(0, 100));
      term.scrollLines(-5);
      const text = textAt(term, term.buffer.active.viewportY);
      expect(addAt(term, 'pty-m', store)).toBe('added');

      const restore = keepAcrossRepaint(term, 'pty-m', store);
      term.reset();
      await write(term, longLines(0, 120));
      restore(term);

      const ids = store.getState().terminalBookmarks['pty-m'];
      expect(ids).toHaveLength(1);
      const marker = term.markers.find((m) => m.id === ids[0]);
      expect(marker && textAt(term, marker.line)).toBe(text);
      term.dispose();
    });

    it('comes back on its own text when the replay reflows to another width', async () => {
      const { term, store, text } = await bookmarked('pty-h');

      const restore = keepAcrossRepaint(term, 'pty-h', store);
      term.reset();
      term.resize(20, 10);
      await write(term, longLines(0, 100));
      restore(term);

      const ids = store.getState().terminalBookmarks['pty-h'];
      expect(ids).toHaveLength(1);
      const marker = term.markers.find((m) => m.id === ids[0]);
      expect(marker && logicalLine(term, marker.line)?.text).toBe(text);
      expect(marker && logicalLine(term, marker.line)?.start).toBe(marker?.line);
      term.dispose();
    });

    it('drops every bookmark when the repaint starts on the alternate screen', async () => {
      const { term, store } = await bookmarked('pty-i');
      await write(term, '\x1b[?1049h');

      const restore = keepAcrossRepaint(term, 'pty-i', store);

      expect(store.getState().terminalBookmarks['pty-i']).toBeUndefined();
      term.reset();
      await write(term, longLines(0, 100));
      restore(term);
      expect(store.getState().terminalBookmarks['pty-i']).toBeUndefined();
      term.dispose();
    });
  });
});
