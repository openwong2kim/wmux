import type { IMarker } from '@xterm/xterm';
import type { UISlice } from '../../stores/slices/uiSlice';

/**
 * Scrollback bookmarks (Ctrl+M) as xterm markers.
 *
 * A marker is the only line reference that survives the buffer moving under
 * it: xterm shifts it when lines are inserted or deleted above it and disposes
 * it when its line is trimmed out of a full scrollback. The store's
 * `terminalBookmarks` lists the marker ids of each pane and is the one record
 * of which bookmarks exist; the markers themselves stay in their xterm
 * Terminal (`term.markers`). A marker never goes into the store, because immer
 * freezes what it holds and a frozen marker can no longer move.
 *
 * The two stay in step both ways: a disposed marker (trimmed, or its Terminal
 * disposed or reset) takes its id out of the store, and an id taken out of the
 * store (clearBookmarks, clearAllPtyState) disposes its marker
 * (watchScrollbackBookmarks).
 */

interface BookmarkLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** The part of an xterm Terminal a bookmark uses; @xterm/headless has it too. */
export interface BookmarkTerminal {
  readonly rows: number;
  /** The active buffer's markers; always empty on the alternate screen. */
  readonly markers: ReadonlyArray<IMarker>;
  readonly buffer: {
    readonly active: {
      readonly type: 'normal' | 'alternate';
      readonly baseY: number;
      readonly viewportY: number;
      readonly cursorY: number;
      readonly length: number;
      getLine(y: number): BookmarkLine | undefined;
    };
  };
  registerMarker(cursorYOffset?: number): IMarker;
}

type BookmarkState = Pick<UISlice, 'terminalBookmarks' | 'addBookmark' | 'removeBookmark' | 'setBookmarks'>;

export interface BookmarkStore {
  getState(): BookmarkState;
}

/** A marker `cursorOffset` lines from the cursor's line, whose disposal takes
 *  its id out of the store. The caller puts the id in. */
function register(term: BookmarkTerminal, ptyId: string, store: BookmarkStore, cursorOffset: number): IMarker {
  const marker = term.registerMarker(cursorOffset);
  marker.onDispose(() => store.getState().removeBookmark(ptyId, marker.id));
  return marker;
}

function bookmarkMarkers(term: BookmarkTerminal, ids: readonly number[] | undefined): IMarker[] {
  return ids ? term.markers.filter((m) => ids.includes(m.id)) : [];
}

/** The logical line row `y` belongs to: its first and last rows and its text,
 *  wrapped rows joined. Exported for the tests. */
export function logicalLine(term: BookmarkTerminal, y: number): { start: number; end: number; text: string } | undefined {
  const buffer = term.buffer.active;
  if (!buffer.getLine(y)) return undefined;
  let start = y;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let end = start;
  let text = '';
  for (let row = start; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line || (row > start && !line.isWrapped)) break;
    end = row;
    text += line.translateToString(!buffer.getLine(row + 1)?.isWrapped);
  }
  return { start, end, text };
}

/** A logical line's text with the lines just above and below it: what a
 *  restored bookmark must find again. */
function fingerprint(term: BookmarkTerminal, line: { start: number; end: number; text: string }): string[] {
  const above = line.start > 0 ? logicalLine(term, line.start - 1)?.text : undefined;
  const below = logicalLine(term, line.end + 1)?.text;
  return [above ?? '\0', line.text, below ?? '\0'];
}

/**
 * Whether Ctrl+M is the bookmark key for this terminal. On a full-screen app's
 * alternate screen there is no scrollback to mark and the key is the app's
 * Enter, so useKeyboard leaves it alone and useTerminal lets xterm send it.
 */
export function claimsBookmarkKey(term: Pick<BookmarkTerminal, 'buffer'> | undefined): boolean {
  return term?.buffer.active.type !== 'alternate';
}

/**
 * Bookmark the top line of the viewport. 'alternate' when a full-screen app's
 * alternate screen is active (it has no scrollback to mark), 'exists' when the
 * line already has a bookmark.
 */
export function addAt(term: BookmarkTerminal, ptyId: string, store: BookmarkStore): 'added' | 'exists' | 'alternate' {
  const buffer = term.buffer.active;
  if (buffer.type === 'alternate') return 'alternate';
  const ids = store.getState().terminalBookmarks[ptyId];
  if (bookmarkMarkers(term, ids).some((m) => m.line === buffer.viewportY)) return 'exists';
  // viewportY is already an absolute buffer line; registerMarker counts from
  // the cursor's absolute line (baseY + cursorY).
  const marker = register(term, ptyId, store, buffer.viewportY - (buffer.baseY + buffer.cursorY));
  store.getState().addBookmark(ptyId, marker.id);
  return 'added';
}

/** The viewport rows (0..rows-1) that hold one of the given bookmarks. */
export function rowsInView(term: BookmarkTerminal, ids: readonly number[]): { id: number; row: number }[] {
  const viewportY = term.buffer.active.viewportY;
  const out: { id: number; row: number }[] = [];
  for (const marker of bookmarkMarkers(term, ids)) {
    const row = marker.line - viewportY;
    if (row >= 0 && row < term.rows) out.push({ id: marker.id, row });
  }
  return out;
}

/** Where each bookmark marker sits: its row in its logical line, and the
 *  line's fingerprint. */
function carriedBookmarks(term: BookmarkTerminal, markers: readonly IMarker[]): { rowInLine: number; print: string[] }[] {
  return markers.flatMap((m) => {
    const line = logicalLine(term, m.line);
    if (!line || line.text.trim() === '') return [];
    return [{ rowInLine: m.line - line.start, print: fingerprint(term, line) }];
  });
}

/**
 * Carry a pane's bookmarks across a repaint that resets the Terminal (RIS
 * disposes every marker) and replays the session. Call it right before the
 * reset; call what it returns once the replay has been parsed.
 *
 * A bookmark comes back only on a line it provably still is: the one logical
 * line in the whole buffer with the same text and the same lines just above
 * and below. The whole buffer, because how far a line moved is unknown: output
 * that arrived while the pane was hidden pushes it up, and once the scrollback
 * is full the cursor line no longer shows by how much. With no such line, or
 * more than one, the bookmark is dropped, never moved to another line, and so
 * is one on a blank line, which nothing can tell apart. None survive a repaint
 * that starts or ends on the alternate screen, whose markers the public API
 * cannot reach.
 *
 * The store changes twice whatever the number of bookmarks: the ids go out
 * here, and the restored ones come back in one set.
 */
export function keepAcrossRepaint(term: BookmarkTerminal, ptyId: string, store: BookmarkStore): (target: BookmarkTerminal) => void {
  const markers = term.buffer.active.type === 'alternate'
    ? []
    : bookmarkMarkers(term, store.getState().terminalBookmarks[ptyId]);
  const carried = carriedBookmarks(term, markers);
  if (store.getState().terminalBookmarks[ptyId]) store.getState().setBookmarks(ptyId, []);
  for (const marker of markers) marker.dispose();
  // `target` is the terminal the repaint lands in: the same one, or (an engine
  // swap of the Labs wongtty switch) the one that replaces it. What is
  // returned holds no reference to `term`, so a swap's carry does not keep
  // the replaced terminal alive.
  return (target) => {
    const after = target.buffer.active;
    if (carried.length === 0 || after.type === 'alternate') return;
    // One pass over the buffer: a line's neighbours are read only when its
    // own text is one a bookmark had.
    const wanted = new Set(carried.map((c) => c.print[1]));
    const found: { start: number; end: number }[][] = carried.map(() => []);
    for (let y = after.length - 1; y >= 0;) {
      const line = logicalLine(target, y);
      if (!line) break;
      if (wanted.has(line.text)) {
        const print = fingerprint(target, line);
        carried.forEach((c, i) => {
          if (print.every((text, k) => text === c.print[k])) found[i].push(line);
        });
      }
      y = line.start - 1;
    }
    const cursorLine = after.baseY + after.cursorY;
    const ids = store.getState().terminalBookmarks[ptyId] ?? [];
    const taken = new Set(bookmarkMarkers(target, ids).map((m) => m.line));
    const restored: number[] = [];
    carried.forEach(({ rowInLine }, i) => {
      if (found[i].length !== 1) return;
      const row = Math.min(found[i][0].start + rowInLine, found[i][0].end);
      if (taken.has(row)) return;
      taken.add(row);
      restored.push(register(target, ptyId, store, row - cursorLine).id);
    });
    if (restored.length > 0) store.getState().setBookmarks(ptyId, [...ids, ...restored]);
  };
}

/**
 * Dispose the marker of every id the store drops (clearBookmarks,
 * clearAllPtyState), when its pane's Terminal is still reachable. One
 * subscription for the app; returns the teardown.
 */
export function watchScrollbackBookmarks(
  store: { subscribe(listener: (state: BookmarkState, prev: BookmarkState) => void): () => void },
  terminalFor: (ptyId: string) => BookmarkTerminal | undefined,
): () => void {
  return store.subscribe((state, prev) => {
    if (state.terminalBookmarks === prev.terminalBookmarks) return;
    for (const [ptyId, before] of Object.entries(prev.terminalBookmarks)) {
      const after = state.terminalBookmarks[ptyId];
      if (after === before) continue;
      const dropped = before.filter((id) => !after?.includes(id));
      if (dropped.length === 0) continue;
      const term = terminalFor(ptyId);
      if (term) for (const marker of bookmarkMarkers(term, dropped)) marker.dispose();
    }
  });
}
