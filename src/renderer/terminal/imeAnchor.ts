/**
 * IME candidate-window anchoring (#874).
 *
 * Windows CJK IMEs draw their candidate window at the caret rect Chromium
 * reports for the focused editable element. In a terminal that element is
 * xterm's hidden helper textarea, so wherever xterm parks the textarea is
 * where the candidate list appears. xterm parks it in the wrong place, twice
 * over:
 *
 *   1. Wrong row while the viewport is scrolled up. `_syncTextArea` anchors at
 *      `buffer.y * cellHeight`, which is ybase-relative, but the renderer
 *      paints the cursor at `(ybase + y) - ydisp` (WebglRenderer.ts:402), which
 *      is ydisp-relative. The two disagree by exactly the number of rows the
 *      viewport is scrolled up. xterm's own guard `isCursorInViewport`
 *      (Buffer.ts:97) applies the ydisp term correctly, and InputHandler.ts:502
 *      converts with `+ (ybase - ydisp)` and a comment explaining why, so the
 *      anchor code is simply missing it. Measured live: ybase=22, ydisp=14,
 *      cursorY=38, cellHeight=17.6 -> anchor row 38, painted row 46, drift -8.
 *      wmux runs with `scrollOnUserInput: false`, so unlike stock xterm the
 *      drift does not self-heal when the user types — one stray wheel scroll
 *      leaves the candidate window misaligned until the user scrolls back.
 *
 *   2. Moving target while composing. `CompositionHelper.updateCompositionElements`
 *      re-anchors on every `compositionupdate` (plus a recursive setTimeout),
 *      so while an agent streams output the candidate window chases wherever
 *      the TUI last parked the cursor mid-redraw. Latin input shows no
 *      candidate window, which is why only CJK users see it.
 *
 * And a third cause lives in the anchor's input rather than its math
 * (field-verified on v3.42.0 after the first two were fixed): the buffer
 * cursor sampled at `compositionstart` is not always the input caret. A TUI
 * like Claude Code repaints its lower region every frame, and while a frame's
 * escape stream is being parsed the cursor rides along with the writes — it is
 * only parked back on the caret by the cursor-positioning sequence at the end
 * of the frame. Frames arrive from the PTY split across chunks, so there are
 * real JS turns where the cursor sits mid-frame, and a composition starting in
 * one of them freezes a wrong-but-stable anchor:
 *
 *   PTY frame (one TUI repaint, split across N chunks):
 *
 *    chunk1        chunk2        chunk3(final: CUP to caret)
 *    ├─parse─┤gap├─parse─┤gap├─parse─┤───────── rest ─────────┤ next frame
 *    cursor:  mid-frame    mid-frame  caret     caret (holds)
 *             (transient)  (transient)
 *    gap  = inter-chunk, sub-ms to a few ms
 *    rest = inter-frame, >= ~50 ms streaming, seconds when idle
 *
 *    compositionstart in a "gap"  -> samples a transient   <- the bug
 *    compositionstart in "rest"   -> samples the caret
 *
 * The countermeasure is a resting-cell tracker: the anchor freezes to the last
 * cell the cursor held for at least RESTING_MS when the instantaneous cursor
 * is inside a move burst. Known limit, accepted deliberately: dwell time
 * cannot distinguish the caret from any cell the cursor parks on for
 * >= RESTING_MS, so the compositionstart diagnostic reports which source was
 * selected and why — the field log is the discriminator before any further
 * complexity is added.
 *
 * That limit is exactly what #951 hit (field logs, WeChat IME + Microsoft
 * Pinyin, Claude Code streaming into a 128x45 pane): `src=instant` selections
 * at (127,43), (53,43), (127,38) — screen corners and output rows, never the
 * user's input line. While an agent streams, output arrives in bursts with
 * inter-burst gaps far above RESTING_MS (token pacing, network), and between
 * bursts the cursor sits wherever the last write left it. Dwell time
 * certifies that parked cursor as "at rest"; the resting fallback is derived
 * from the same buffer cursor and is just as blind. The missing signal is
 * output recency: a cell the cursor held through a period with NO parsed PTY
 * output is where the TUI deliberately parked it — the caret at rest — while
 * any cursor position observed with output still flowing is repaint state.
 * So the tracker also records the last "quiet caret": the cell the cursor
 * held across the most recent >= OUTPUT_QUIET_MS output-free span, stored
 * ybase-RELATIVE (screen row), because a TUI addresses its input line by
 * screen position and scrolling output changes that line's absolute row while
 * its screen row stays put. A composition starting while output is recent
 * AND has been flowing for STREAM_SUSTAIN_MS anchors there (`src=caret`)
 * instead of trusting dwell. The sustain gate is what keeps the quiet-shell
 * typing flow intact: a committed syllable's echo is also "recent output",
 * but it is an isolated burst — without the gate, every commit would push
 * the next composition onto the stale snapshot instead of the correctly
 * advanced cursor, and a fluid typist's candidate window would drift further
 * from the caret with every word (3-model panel finding on the first cut).
 * Dwell has one more blind spot even when quiet (#953 field cases 1-3): a
 * TUI with nothing to point at — empty input box, mid-edit redraw — parks
 * its real cursor at the LAST column of the line it painted, and a long gap
 * then certifies that placeholder. A CJK composition can never sit on the
 * last column (the glyph alone is two cells wide), so such a selection is
 * FLAGGED (`edge=1` in the diagnostic), and while output is FLOWING it also
 * defers to the quiet-caret snapshot; while output is quiet the selection is
 * NOT rerouted. Such a cell is also refused as a snapshot, so a quiet span
 * that finds the TUI parked at the line end keeps the caret the last real one
 * recorded instead of replacing it — without that, deferring to the snapshot
 * just moves the same wrong cell one step earlier.
 * That last split is the whole lesson of three earlier generations, all of
 * which rerouted a line-end park in every condition and all of which lost to
 * the untouched baseline: re-selecting the quiet snapshot wandered between
 * inputs (an idle TUI keeps twitching its cursor, so consecutive quiet spans
 * certify different cells); reusing the previous composition's anchor locked
 * whatever error the first anchor had for the whole session; and withholding
 * line-end cells from the snapshot measured worse too. What they had in
 * common was acting while the pane was IDLE, which is exactly where dwell was
 * already right. The streaming half was still broken after they were reverted
 * (#953 field log, 2026-08-21: `gap=203ms caretAge=602ms src=instant edge=1`
 * — a usable snapshot passed over, candidate window pinned to the pane's
 * bottom-right corner), so the rule now fires only when output arrived within
 * OUTPUT_QUIET_MS. The idle line-end miss stays a KNOWN, flagged residual.
 * The 2026-08-23 field round (#953, final report) then showed the snapshot
 * side of the same shape: the SNAPSHOT is sometimes the park, and a park is
 * "wherever the painted text ended", which can be any column at all — the
 * log holds snapshots at column 137 of a 139-column pane and at column 53
 * mid-line — so the last-column refusal only catches a painted line that
 * happens to fill the row. Underneath both: while an agent streams, its
 * cursor never visits the input caret at all — the ecosystem contract says
 * the TUI must park its cursor on the caret (Ink's useCursor exists; Claude
 * Code has not shipped it, see anthropics/claude-code#25186) — so no
 * cursor-derived rule, in any combination, can find the caret mid-stream.
 * That is why the streaming anchor has a second signal class (#1016): at
 * compositionstart, when the pane's agent is recognized and output is
 * flowing, the input line is read out of the buffer by its chrome
 * (scanClaudeInputLine) and outranks every cursor source (`src=marker`).
 * The cursor path remains for unrecognized agents, for a scan that finds
 * nothing, and for the idle pane, which stays cursor-driven on purpose —
 * idle is field-verified correct and every generation that touched it lost.
 * Known residuals, all identifiable in a field log via the src/gap/
 * caretAge/edge fields: the line-end park above; a mid-stream pause longer
 * than OUTPUT_QUIET_MS with the cursor parked mid-line on repaint state
 * re-snapshots a wrong caret; a resize or clear mid-stream drops (resize)
 * or strands (clear — no reset event fires) the snapshot until output next
 * goes quiet; and a caret deliberately moved by the very chunk that ends a
 * quiet span is snapshotted at its pre-move cell.
 *
 * All of this lives in upstream xterm and this repo does not patch
 * node_modules, so the correction is applied downstream as a `transform` that
 * composes with the `style.top` / `style.left` xterm keeps writing, instead of
 * fighting it. #875 put that transform on the `.xterm-helpers` container;
 * #942 showed the container is the wrong unit, because its two children have
 * opposite requirements while a composition is live:
 *
 *   .xterm-screen  (position: relative, origin for everything below)
 *     +-- .xterm-helpers
 *     |     +-- textarea            <- style.top/left [xterm] + transform [ours: pinned]
 *     |     +-- .composition-view   <- style.top/left [xterm] + transform [ours: live]
 *     +-- canvas                    <- painted cursor                     [webgl]
 *
 * The textarea is what Chromium reports the caret rect from, so it is what a
 * floating candidate window (Chinese/Japanese) follows — pinning it for the
 * whole composition is the point of the freeze. The `.composition-view` is
 * the visible inline preedit, and `CompositionHelper.updateCompositionElements`
 * deliberately re-anchors it to the live cursor on every `compositionupdate`.
 * Korean Microsoft IME draws no candidate window at all: the preedit rendered
 * inline at the caret IS the text the user is watching. Freezing the shared
 * parent turned every committed syllable's echo into a backwards drag — the
 * caret advances past the pinned point, `frozen - actual` goes negative, and
 * the composing syllable is painted on top of the one that just committed
 * (typing 대한민국 reads 대한국, #942). The composition ending cleared the
 * transform and the WebGL repaint restored the real cells, which is why the
 * buffer was never wrong, only the paint. So the pin applies to the textarea
 * alone, and the preedit gets the same anchor math against the live cursor —
 * applied at xterm's own composition-event cadence (not per render frame, see
 * syncPreedit) so it lands on the painted caret when the viewport is scrolled
 * (cause 1 applies to it too) without chasing mid-repaint transient cursors.
 * One exception (#951 field report on the first quiet-caret build): when the
 * freeze cell came from the quiet caret and the live cursor sits on some
 * OTHER screen row — the streaming agent's repaint cursor — the preedit pins
 * to the same frozen point as the textarea; otherwise the pinyin rides the
 * agent's output rows while its candidate list sits at the input line, and
 * the two IME surfaces tear apart. The exception is row-gated (#1032, the
 * first ship of it was not): fluid Korean typing reaches the streaming
 * branch too — each committed syllable's echo is output, and sub-quiet gaps
 * sustain the epoch — and there the live cursor IS the caret advancing along
 * the anchor's own row while the snapshot's column is one quiet-span stale.
 * Pinning the preedit there repainted the composing syllable over text
 * already committed (typing 정확히 어떻 read 떻확히 어) — the very drag #945
 * removed, reintroduced on the new path. A same-row cursor is the caret; a
 * cross-row cursor is repaint state (see preeditFollowsLiveCursor).
 *
 * The correction is computed as `desired - actual`, where `actual` is read back
 * from the styles xterm wrote rather than re-derived from the buffer. That
 * matters for three reasons: `_syncTextArea` early-returns while composing (so
 * a buffer-derived estimate would be wrong exactly when it counts), xterm stops
 * syncing entirely once the cursor leaves the viewport (leaving stale
 * coordinates a model cannot predict), and if a future xterm release fixes the
 * anchor upstream then `desired - actual` collapses to zero on its own instead
 * of double-correcting.
 */

/** Minimal view of `terminal.buffer.active` that the anchor math needs. */
export interface ImeAnchorBufferState {
  /** Cursor column, ybase-relative buffer coordinates. */
  cursorX: number;
  /** Cursor row, ybase-relative (this is xterm's `buffer.y`). */
  cursorY: number;
  /** Rows scrolled off the top of the buffer (xterm's `ybase`). */
  baseY: number;
  /** Row currently at the top of the viewport (xterm's `ydisp`). */
  viewportY: number;
}

/** Cell metrics plus the grid size, in CSS pixels / cells. */
export interface ImeAnchorGeometry {
  cellWidth: number;
  cellHeight: number;
  rows: number;
  cols: number;
}

/** A position in `.xterm-screen`-local CSS pixels. */
export interface ImeAnchorPoint {
  left: number;
  top: number;
}

export interface ImeAnchorCorrection {
  dx: number;
  dy: number;
}

/** True when the geometry is usable — a hidden pane reports zero-sized cells. */
export function isUsableGeometry(geometry: ImeAnchorGeometry): boolean {
  const { cellWidth, cellHeight, rows, cols } = geometry;
  return (
    Number.isFinite(cellWidth) && cellWidth > 0 &&
    Number.isFinite(cellHeight) && cellHeight > 0 &&
    Number.isFinite(rows) && rows > 0 &&
    Number.isFinite(cols) && cols > 0
  );
}

/**
 * Where the renderer would paint a given buffer cell, in screen-local CSS
 * pixels.
 *
 * The row is clamped into the viewport: once the cursor scrolls out of view
 * xterm stops moving the textarea at all, and an unclamped anchor would send
 * the candidate window outside the pane. Pinning it to the nearest visible edge
 * keeps it attached to the terminal, which is the least surprising thing an IME
 * can do when the caret itself is off-screen. The column is clamped to
 * `cols - 1` to match what xterm does (CompositionHelper.ts:221) so a
 * wrap-pending cursor at `col === cols` does not land a cell too far right.
 */
export function pointFromCell(
  absRow: number,
  col: number,
  buffer: ImeAnchorBufferState,
  geometry: ImeAnchorGeometry,
): ImeAnchorPoint {
  const viewportRow = absRow - buffer.viewportY;
  const row = Math.min(Math.max(viewportRow, 0), geometry.rows - 1);
  const clampedCol = Math.min(Math.max(col, 0), geometry.cols - 1);
  return { left: clampedCol * geometry.cellWidth, top: row * geometry.cellHeight };
}

/** Where the renderer actually paints the live cursor. */
export function paintedCursorPosition(
  buffer: ImeAnchorBufferState,
  geometry: ImeAnchorGeometry,
): ImeAnchorPoint {
  return pointFromCell(buffer.baseY + buffer.cursorY, buffer.cursorX, buffer, geometry);
}

/**
 * The translate that moves the helper container's children from where xterm
 * put them to where they belong.
 */
export function computeImeAnchorCorrection(
  desired: ImeAnchorPoint,
  actual: ImeAnchorPoint,
): ImeAnchorCorrection {
  return { dx: desired.left - actual.left, dy: desired.top - actual.top };
}

/**
 * Parse a `<n>px` inline style value. Returns null for anything else, notably
 * xterm's stylesheet default of `left: -9999em`, which means "xterm has not
 * positioned this yet" and must not be read as a pixel offset. The number
 * accepts every CSS form (`.5px`, `1e2px`) rather than only what Chromium
 * happens to serialize today, so a change in how the offset is computed
 * upstream degrades into a wrong-but-parsed value we can see rather than
 * silently switching the correction off.
 */
export function parsePxOrNull(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)px$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Resting-cell tracker (cause 3)
// ---------------------------------------------------------------------------

/**
 * A cell counts as "at rest" once the cursor has held it this long. Inter-chunk
 * gaps inside one TUI repaint are sub-ms to a few ms; the inter-frame rest is
 * >= ~50 ms while streaming and seconds when idle — 32 ms sits between the two
 * populations with roughly 10x margin on both sides.
 */
export const RESTING_MS = 32;

/**
 * Output silence required before the buffer cursor is trusted again (#951).
 * Streaming agents keep their spinner/stream repaints under a few hundred ms
 * apart, so mid-turn gaps stay below this; a pane whose agent has finished (or
 * that never streamed) crosses it almost immediately. A cell the cursor held
 * through a span this long with no parsed output is the TUI's parked caret.
 */
export const OUTPUT_QUIET_MS = 500;

/**
 * How long output must have been flowing (sub-quiet gaps, measured from the
 * chunk that ended the last quiet span) before the quiet-caret snapshot
 * outranks the live cursor. An isolated burst — a committed syllable's echo,
 * a prompt redraw — stays well under this, so ordinary typing keeps trusting
 * the freshly advanced cursor; an agent streaming output crosses it within
 * the first second of its turn.
 */
export const STREAM_SUSTAIN_MS = 700;

/**
 * Mutable tracker record. The transition functions below mutate it in place —
 * that is how "pure-function testability" and an allocation-free hot path
 * coexist: each function is deterministic in (state, args), returns scalars,
 * and tests simply construct a fresh record per case.
 */
export interface RestingTrackerState {
  /** Cell the cursor is in right now (absolute row = ybase + buffer.y). */
  currentAbsRow: number;
  currentCol: number;
  /** Screen row of the current cell at entry (xterm's `buffer.y`). */
  currentRelRow: number;
  /** Clock reading when the current cell was entered. */
  currentSince: number;
  /** Last cell that was held for >= RESTING_MS before the cursor left it. */
  lastRestingAbsRow: number;
  lastRestingCol: number;
  /** Screen row of the resting cell at its entry. */
  lastRestingRelRow: number;
  /** Clock reading when the resting cell was promoted. */
  lastRestingAt: number;
  hasResting: boolean;
  /** Clock reading of the last parsed PTY output (#951). */
  lastOutputAt: number;
  /** True once a PTY chunk has actually been parsed since creation/reset.
   *  `lastOutputAt` is SEEDED with the creation clock (so "no output since
   *  attach" reads as quiet), but that same seed would read as "output 0ms
   *  ago" — i.e. flowing — for the first OUTPUT_QUIET_MS after an attach or
   *  resize. The streaming branch must not fire on a seed (panel finding):
   *  gate it on output that was actually observed. */
  hasOutput: boolean;
  /** Clock reading of the chunk that ended the last quiet span — the start
   *  of the current output epoch. Age >= STREAM_SUSTAIN_MS means the output
   *  is a sustained stream, not an isolated echo burst. */
  epochStart: number;
  /**
   * Cell the cursor held through the most recent >= OUTPUT_QUIET_MS
   * output-free span — the TUI's parked caret. Screen-row coordinates: a TUI
   * addresses its input line by screen position, so this survives the buffer
   * scrolling underneath it, which an absolute row would not.
   */
  caretRelRow: number;
  caretCol: number;
  /** Clock reading when the caret snapshot was taken. */
  caretAt: number;
  hasCaret: boolean;
}

/**
 * Seed the tracker from the live cursor. Seeding (rather than starting empty)
 * means an idle caret that never moves still reads as "at rest", so the
 * pre-first-move window has no hole where the selection could do nothing.
 */
export function createRestingTracker(absRow: number, col: number, now: number, relRow: number = absRow): RestingTrackerState {
  return {
    currentAbsRow: absRow,
    currentCol: col,
    currentRelRow: relRow,
    currentSince: now,
    lastRestingAbsRow: 0,
    lastRestingCol: 0,
    lastRestingRelRow: 0,
    lastRestingAt: 0,
    hasResting: false,
    // Seeded with the creation clock: "no output since attach" reads as quiet,
    // matching the seeded-at-rest semantics of the cell fields above.
    lastOutputAt: now,
    hasOutput: false,
    epochStart: now,
    caretRelRow: 0,
    caretCol: 0,
    caretAt: 0,
    hasCaret: false,
  };
}

/** Record a cursor movement. Promotes the cell being left if it had rested. */
export function noteCursorMove(state: RestingTrackerState, absRow: number, col: number, now: number, relRow: number = absRow): void {
  if (absRow === state.currentAbsRow && col === state.currentCol) {
    // Same buffer cell, so the dwell clock keeps running — but a scroll can
    // move the screen row under a stationary absolute cell (baseY up, cursorY
    // down by the same amount), and the caret snapshot records SCREEN rows,
    // so the screen coordinate must stay fresh.
    state.currentRelRow = relRow;
    return;
  }
  if (now - state.currentSince >= RESTING_MS) {
    state.lastRestingAbsRow = state.currentAbsRow;
    state.lastRestingCol = state.currentCol;
    state.lastRestingRelRow = state.currentRelRow;
    state.lastRestingAt = now;
    state.hasResting = true;
  }
  state.currentAbsRow = absRow;
  state.currentCol = col;
  state.currentRelRow = relRow;
  state.currentSince = now;
}

/**
 * Record a parsed PTY write (#951). When this chunk ends an output-free span
 * of >= OUTPUT_QUIET_MS, the cell that held the cursor through that span is
 * promoted to the quiet caret. Which tracker field holds that cell depends on
 * event order inside the chunk, and both orders are covered: if the cursor
 * has not (yet) been reported moved this chunk, the current cell still spans
 * the quiet period (`currentSince <= lastOutputAt` — the cursor cannot move
 * without output); if the move was already reported, the spanning cell was
 * just promoted to the resting slot (its dwell covered the whole span, which
 * exceeds RESTING_MS by construction) with a promotion clock inside this
 * chunk.
 */
export function noteOutputParsed(state: RestingTrackerState, now: number, cols?: number): void {
  if (now - state.lastOutputAt >= OUTPUT_QUIET_MS) {
    state.epochStart = now;
    // A cell on the LAST column is the TUI's line-end park, never a caret: a
    // CJK composition cannot sit there, since the glyph is two cells wide. It
    // must not become the snapshot — and specifically must not REPLACE a good
    // one, which is the shape the field log shows (#953, 2026-08-21):
    // `cursor=(13,36) sel=(127,43) src=caret`, the live cursor mid-line while
    // the snapshot points at column 127. Refusing keeps whatever caret the
    // last real quiet span recorded. `cols` is optional so a caller with no
    // geometry keeps the old behaviour rather than silently disabling the
    // check with a wrong bound.
    const lastCol = cols !== undefined ? cols - 1 : Infinity;
    const promote = (relRow: number, col: number): void => {
      if (col >= lastCol) return;
      state.caretRelRow = relRow;
      state.caretCol = col;
      state.caretAt = now;
      state.hasCaret = true;
    };
    if (state.currentSince <= state.lastOutputAt) {
      promote(state.currentRelRow, state.currentCol);
    } else if (state.hasResting && state.lastRestingAt > state.lastOutputAt) {
      promote(state.lastRestingRelRow, state.lastRestingCol);
    }
  }
  state.lastOutputAt = now;
  state.hasOutput = true;
}

/**
 * Invalidate everything and re-seed. Resize reflow and buffer switches
 * (alt-screen) change what both an absolute and a screen row mean, so neither
 * a resting cell nor a quiet caret recorded before either event may be
 * selected after it. The output clock is re-seeded too: without that, the
 * chunk ending the first post-reset quiet span would see
 * `currentSince > lastOutputAt` (the reset stamped `currentSince`) and could
 * never take the current-cell branch of noteOutputParsed, so a pane that
 * kept streaming after a resize would not regain a caret snapshot until the
 * cursor happened to move in exactly the right chunk (2-model panel
 * finding). Re-seeding makes the quiet clock start fresh in the new
 * coordinate frame, which is also the conservative reading: only silence
 * observed entirely after the reflow counts toward a new snapshot.
 */
export function resetRestingTracker(state: RestingTrackerState, absRow: number, col: number, now: number, relRow: number = absRow): void {
  state.currentAbsRow = absRow;
  state.currentCol = col;
  state.currentRelRow = relRow;
  state.currentSince = now;
  state.hasResting = false;
  state.hasCaret = false;
  state.lastOutputAt = now;
  state.hasOutput = false;
  state.epochStart = now;
}

// ---------------------------------------------------------------------------
// Agent input-line content scan (#1016)
// ---------------------------------------------------------------------------

/** The agent's input line, found by content rather than cursor behavior. */
export interface AgentInputLineMarker {
  /** Screen row of the prompt row, ybase-RELATIVE like the quiet-caret
   *  snapshot. The scan reads the LIVE screen (baseY + relRow), not the
   *  viewport: a user scrolled up mid-stream sees history, and history can
   *  quote the box chrome — matching there would anchor into old transcript
   *  (3-model panel finding). Reading the live rows finds the real box even
   *  while scrolled, and `pointFromCell` then clamps the off-screen anchor
   *  to the nearest visible edge, same contract as every other off-screen
   *  anchor here. */
  relRow: number;
  /** Column where typed input begins — just after the `> ` prompt. Used as
   *  the anchor floor rather than the exact caret: the exact caret would need
   *  cell-accurate width math over typed CJK, and a candidate window at the
   *  input's start is already on the right row, which is what field reports
   *  complain about. */
  col: number;
  /** Rows the box interior spans — 1 plus the wrapped continuation rows
   *  under the prompt row (#1032). Wrapped input grows the box downward and
   *  the caret lives on whichever interior row the user is typing on, so the
   *  preedit's row gate must treat the whole interior as caret territory. */
  rowSpan: number;
}

// Claude Code draws its input as a rounded box; the prompt row is the first
// row inside it:            ╭──────────────╮
//                           │ > typed text │
//                           ╰──────────────╯
// The prompt glyph varies by mode — `>` normal, `!` bash mode, `#` memory
// mode — and all three mark the same caret row. Matching only `>` would let
// a quoted `│ > ` in the transcript win bottom-most while the live box sits
// in another mode (panel finding). The lead-in is pure ASCII/box-drawing
// (single-cell glyphs), so a string index below IS the buffer column — typed
// CJK only ever appears after it.
const CLAUDE_PROMPT_ROW = /^(\s*)│ [>!#] /;
const CLAUDE_BOX_TOP = /^\s*╭─/;
const CLAUDE_BOX_BOTTOM = /^\s*╰─/;
// Interior rows of the box below the prompt row: wrapped continuation lines.
// They carry the side border but no prompt glyph (#1032).
const CLAUDE_BOX_ROW = /^\s*│ /;

/**
 * Find Claude Code's input line in the visible rows (#1016).
 *
 * Bottom-up, because the input box is the bottom-most chrome that matches —
 * streamed transcript ABOVE it may quote the same glyphs (an agent printing
 * its own UI), and the rows BELOW it (`? for shortcuts`, status hints) match
 * nothing. A prompt row only counts with the box's top border directly above
 * it, which is true for single- and multi-line input alike (the `│ > ` row
 * is always the first row inside the box; wrapped continuation rows carry no
 * `>`), and false for a bare quoted prompt line in scrolled output.
 *
 * `readLine` returns the trimmed text of a viewport row, or undefined when
 * the row cannot be read; unreadable rows are skipped rather than trusted.
 * Runs at compositionstart only — user-paced, so a full-viewport scan is
 * free.
 */
export function scanClaudeInputLine(
  readLine: (relRow: number) => string | undefined,
  rows: number,
): AgentInputLineMarker | null {
  for (let r = rows - 1; r >= 1; r--) {
    const line = readLine(r);
    if (line === undefined) continue;
    const m = CLAUDE_PROMPT_ROW.exec(line);
    if (!m) continue;
    const above = readLine(r - 1);
    if (above === undefined || !CLAUDE_BOX_TOP.test(above)) continue;
    // Wrapped input grows the box downward: continuation rows carry the side
    // border but no prompt glyph, and the caret lives on whichever interior
    // row the user is typing on (#1032). Count the interior down to the
    // bottom border so the preedit's row gate can treat all of it as caret
    // territory. A bottom border that never appears (unreadable row, box
    // taller than the screen) keeps the conservative single-row span.
    let rowSpan = 1;
    for (let d = r + 1; d < rows; d++) {
      const below = readLine(d);
      if (below === undefined) break;
      if (CLAUDE_BOX_BOTTOM.test(below)) { rowSpan = d - r; break; }
      if (!CLAUDE_BOX_ROW.test(below)) break;
    }
    // `│ > x`: border, space, prompt, space — input begins 4 cells past the
    // border.
    return { relRow: r, col: m[1].length + 4, rowSpan };
  }
  return null;
}

/** Where the freeze cell came from. `scrolled_out` is `instant` chosen because
 *  the resting cell had left the viewport — kept distinct so a field log can
 *  tell that rejection apart from a cursor that was simply at rest. `caret` is
 *  the quiet-caret snapshot, chosen because output was still flowing (#951).
 *  `marker` is the agent's input line found by content (#1016), chosen over
 *  every cursor source while output flows. */
export type FreezeCellSource = 'instant' | 'resting' | 'scrolled_out' | 'caret' | 'marker';

export interface FreezeCellSelection {
  absRow: number;
  col: number;
  src: FreezeCellSource;
  /** How long the instantaneous cell had been held when selection ran. */
  held: number;
  /** Age of the resting cell at selection time; -1 when none exists. */
  restAge: number;
  /** Time since the last parsed PTY output when selection ran (#951). */
  outputGap: number;
  /** Age of the caret snapshot at selection time; -1 when none exists. */
  caretAge: number;
  /** True when the instantaneous cursor sat on the last column — a TUI
   *  line-end park (#953). Diagnostic only; the selection is not rerouted. */
  edge: boolean;
  /** Rows the anchor's input area spans, starting at the anchor row. 1 for
   *  every cursor-derived source; the box-interior height for `marker`
   *  (#1032 — wrapped input puts the caret on a continuation row). */
  rowSpan: number;
}

/**
 * Pick the cell the composition should anchor to. When output has been quiet
 * for OUTPUT_QUIET_MS the buffer cursor is where the TUI parked it — trust it
 * when at rest (RESTING_MS), fall back to the resting cell mid-burst. While
 * output is recent AND sustained (STREAM_SUSTAIN_MS since the current epoch
 * began), dwell time certifies nothing (#951: a streaming agent parks its
 * cursor on screen corners between bursts for far longer than RESTING_MS),
 * so the quiet-caret snapshot wins over both — and an input line found by
 * content (`marker`, #1016) wins over the snapshot, which the 2026-08-23
 * field round proved is itself sometimes a park. Recent-but-isolated output —
 * a committed syllable's echo — keeps the normal dwell selection, because
 * there the freshly moved cursor IS the caret and the snapshot is one word
 * stale. The snapshot's
 * screen row is rebased onto the CURRENT ybase: the TUI keeps its input line
 * at a fixed screen position while output scrolls the buffer underneath.
 * `pointFromCell` clamps the result into the viewport, which for a scrolled-up
 * user pins the candidate window to the nearest visible edge — same contract
 * as every other off-screen anchor here. With no snapshot (pane streamed from
 * the moment it attached), selection degrades to the pre-#951 behavior.
 *
 * `viewport` guards the one case where the resting cell is the WORSE of the
 * two. A resting cell is by definition a past cell, so output that scrolls the
 * buffer (a build log, not an in-place TUI repaint) pushes it off the top of
 * the screen within a frame or two. `pointFromCell` then clamps that row into
 * view and parks the candidate window at the very top of the terminal — a
 * bigger miss than the live cursor, and one #875 could not produce because it
 * only ever read the live cursor, which is always on screen. Verified on the
 * dev build: 20k lines of scrolling output selected resting cells 1000+ rows
 * above `ydisp`, every one correcting to the top edge. Off-screen resting
 * cells are therefore rejected rather than trusted.
 */
export function selectFreezeCell(
  state: RestingTrackerState,
  instAbsRow: number,
  instCol: number,
  now: number,
  viewport?: { top: number; rows: number; cols?: number },
  baseY = 0,
  getMarker?: () => AgentInputLineMarker | null,
): FreezeCellSelection {
  const held = now - state.currentSince;
  const restAge = state.hasResting ? now - state.lastRestingAt : -1;
  const outputGap = now - state.lastOutputAt;
  const caretAge = state.hasCaret ? now - state.caretAt : -1;
  // Diagnostic only (#953): a last-column cursor is a TUI line-end park, not
  // a caret — but every generation of acting on it (reroute to the quiet
  // snapshot, reuse the previous anchor, withhold the snapshot) field-tested
  // worse than leaving it alone, so it is flagged and nothing more. See the
  // header for the full account.
  const lastCol = viewport?.cols !== undefined ? viewport.cols - 1 : Infinity;
  const edge = instCol >= lastCol;
  // The sustain gate exists to stop a COMMIT ECHO from pushing the next
  // composition onto a stale snapshot — an echo is recent output too, and
  // there the freshly moved cursor really is the caret. It has nothing to
  // protect when the cursor is parked on the last column: a commit leaves the
  // caret where the syllable landed, mid-line, and a CJK composition cannot
  // sit on the last column at all (the glyph is two cells wide). So while
  // output is flowing, a line-end park defers to the snapshot even before the
  // epoch is old enough.
  //
  // This is narrower than the three generations the header records as losing.
  // Each of those rerouted a line-end park in EVERY condition, idle included,
  // and idle is exactly where dwell was right; this one cannot fire unless
  // output arrived within OUTPUT_QUIET_MS. Field evidence for the distinction
  // (#953, 2026-08-21): with idle confirmed good on 5ca90958, streaming still
  // anchored bottom-right, and the log shows why — `gap=203ms caretAge=602ms
  // src=instant edge=1`, a usable snapshot passed over because a token-paced
  // stream pauses longer than OUTPUT_QUIET_MS between bursts, so `epochStart`
  // kept restarting and never reached STREAM_SUSTAIN_MS.
  if (state.hasOutput && outputGap < OUTPUT_QUIET_MS
    && (now - state.epochStart >= STREAM_SUSTAIN_MS || edge)) {
    // #1016: the input line found by CONTENT outranks the snapshot. The
    // 2026-08-23 field round proved the snapshot itself is sometimes a park
    // ("wherever the painted text ended" — any column, so no column check
    // can classify it), while the marker is read from the frame currently on
    // screen. The scan is a thunk so it runs ONLY when this branch is taken:
    // the quiet and echo-burst paths never pay for it, and the scan gate can
    // never drift from the selection gate (panel finding).
    const marker = getMarker?.() ?? null;
    // One shape reaches this branch that is NOT an agent stream: fluid CJK
    // typing, where each committed syllable's echo is output and a fast
    // typist keeps every gap under OUTPUT_QUIET_MS for longer than the
    // sustain. There the snapshot sits ON the prompt row at the caret's
    // last-pause column — better than the marker's input-start floor (which
    // would drag the Korean inline preedit back over already-typed text,
    // panel finding). So a snapshot on the marker's own row keeps its
    // column, UNLESS it sits in the border zone (the last two columns): a
    // prompt-row cell there is the box's right border where the repaint
    // parked, which is the 2026-08-23 field shape (col 137 of 139) and
    // exactly what the marker exists to override. Without a column count
    // the zone is unknowable and the snapshot is kept — the conservative,
    // shipped behavior.
    if (marker !== null) {
      const borderZone = viewport?.cols !== undefined ? viewport.cols - 2 : Infinity;
      const typingSnapshot = state.hasCaret
        && state.caretRelRow === marker.relRow
        && state.caretCol < borderZone;
      if (!typingSnapshot) {
        return {
          absRow: baseY + marker.relRow, col: marker.col,
          src: 'marker', held, restAge, outputGap, caretAge, edge,
          rowSpan: marker.rowSpan,
        };
      }
    }
    if (state.hasCaret) {
      return {
        absRow: baseY + state.caretRelRow, col: state.caretCol,
        src: 'caret', held, restAge, outputGap, caretAge, edge, rowSpan: 1,
      };
    }
  }
  if (held >= RESTING_MS || !state.hasResting) {
    return { absRow: instAbsRow, col: instCol, src: 'instant', held, restAge, outputGap, caretAge, edge, rowSpan: 1 };
  }
  if (viewport && (state.lastRestingAbsRow < viewport.top
    || state.lastRestingAbsRow >= viewport.top + viewport.rows)) {
    return { absRow: instAbsRow, col: instCol, src: 'scrolled_out', held, restAge, outputGap, caretAge, edge, rowSpan: 1 };
  }
  return { absRow: state.lastRestingAbsRow, col: state.lastRestingCol, src: 'resting', held, restAge, outputGap, caretAge, edge, rowSpan: 1 };
}

/**
 * Whether the inline preedit keeps following the live cursor for a
 * composition whose textarea pin came from the streaming branch (#1032).
 *
 * `caret`/`marker` freeze cells answer a line-level question — which row the
 * agent's input line is on — with a column that can be one quiet-span stale.
 * The inline preedit needs the character-level answer: where in that line the
 * user is NOW. The live cursor gives that answer exactly when it sits on the
 * anchor's own screen row (commit echoes advance it along the input line —
 * the field-clean v3.46.0 behavior for Korean), and is repaint state when it
 * sits anywhere else (#951: screen corners, output rows — following it there
 * tears the preedit away from the candidate window). Rows are compared
 * screen-relative, like the caret snapshot itself: streaming output scrolls
 * the buffer under the input line while its screen row stays put.
 *
 * The gate is a row RANGE, not a single row: a `marker` anchor knows the
 * box's interior height, and wrapped input puts the caret on a continuation
 * row that is still the user's caret (#1032 review finding — without the
 * span, multi-line messages kept exactly the drag this gate exists to
 * remove). Cursor-derived anchors have no box knowledge and keep a span
 * of 1.
 *
 * Known, accepted residual (3-way review consensus): an agent repaint that
 * PARKS inside this row range — the #953 line-end park landing on a box
 * row — reads as the caret, and the preedit follows it until the next
 * composition event. Every prior generation that tried to outsmart a park
 * (column heuristics, hysteresis, reroutes) field-tested worse than
 * leaving it alone (see the header history), and for Korean a same-row
 * follow is exactly the field-clean v3.46.0 behavior. The diagnostic's
 * pin/preedit pair discriminates it in a field log.
 */
export function preeditFollowsLiveCursor(
  src: FreezeCellSource,
  selRelRow: number,
  cursorRelRow: number,
  rowSpan = 1,
): boolean {
  if (src !== 'caret' && src !== 'marker') return true;
  return cursorRelRow >= selRelRow && cursorRelRow < selRelRow + rowSpan;
}

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

interface Disposable {
  dispose(): void;
}

interface EventEmitterLike<T> {
  (listener: (arg: T) => void): Disposable;
}

/** One buffer row, as xterm's IBufferLine exposes it (#1016). */
export interface ImeAnchorBufferLine {
  translateToString(trimRight?: boolean): string;
}

/** The slice of xterm's public Terminal API this needs. */
export interface ImeAnchorTerminal {
  readonly rows: number;
  readonly cols: number;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly element: HTMLElement | undefined;
  readonly buffer: {
    active: ImeAnchorBufferState & {
      /** Row content lookup (xterm's IBuffer.getLine), indexed from the top
       *  of the scrollback. Optional: a caller without it (minimal fakes)
       *  simply has the #1016 content scan disabled. */
      getLine?(y: number): ImeAnchorBufferLine | undefined;
    };
    /** Fires on normal <-> alt buffer switches. */
    onBufferChange: EventEmitterLike<unknown>;
  };
  onRender: EventEmitterLike<unknown>;
  onScroll: EventEmitterLike<unknown>;
  onResize: EventEmitterLike<unknown>;
  onCursorMove: EventEmitterLike<unknown>;
  /** Fires after each PTY chunk is parsed — the output-recency signal (#951). */
  onWriteParsed: EventEmitterLike<unknown>;
}

export interface ImeAnchorOptions {
  /**
   * Called with the coordinates that produced the correction. #874/#942 could
   * not be reproduced locally (no CJK IME here), so this is how a reporter's
   * log tells us whether any offset survives the fix. Fires on every
   * `compositionstart`, and again mid-composition (`update`) or at
   * `compositionend` ONLY when a correction changed since the last report —
   * #942's log was all `correction=(0,0)` precisely because the drag developed
   * after the start-only diagnostic had already fired.
   */
  onCompositionDiagnostic?: (info: {
    phase: 'start' | 'update' | 'end';
    baseY: number;
    viewportY: number;
    cursorY: number;
    cursorX: number;
    cellHeight: number;
    /** Correction applied to the textarea (the pinned candidate-window anchor). */
    dx: number;
    dy: number;
    /** Live correction applied to the inline preedit box; 0,0 when none. */
    preeditDx: number;
    preeditDy: number;
    /** Which cell the anchor froze to (cause 3 discriminator). */
    src: FreezeCellSource;
    held: number;
    restAge: number;
    /** Output silence at compositionstart — the #951 discriminator. */
    outputGap: number;
    /** Age of the caret snapshot at compositionstart; -1 when none existed.
     *  A large value on a src=caret record means the anchor came from a
     *  long-past quiet span — the stale-snapshot residual in action. */
    caretAge: number;
    /** True when the cursor sat on the last column — a TUI line-end park
     *  (#953). Diagnostic only; the selection is not rerouted. */
    edge: boolean;
    /** Rows the anchor's input area spans (#1032); 1 for cursor-derived
     *  sources, the box-interior height for `marker`. */
    rowSpan: number;
    /** Selected cell, ybase-relative like cursorY/cursorX. */
    selY: number;
    selX: number;
  }) => void;
  /**
   * Slug of the agent running in this pane, when known (#1016). Gates the
   * input-line content scan to agents whose chrome the scanner understands —
   * today `'claude'`. Read at compositionstart, so a pane whose agent is
   * recognized mid-session starts scanning without a re-attach, and a pane
   * whose agent exits stops.
   */
  getAgentSlug?: () => string | undefined;
  /** Clock override for tests. Defaults to performance.now. */
  now?: () => number;
}

const NO_OP: Disposable = { dispose: () => undefined };

export function attachImeAnchor(
  terminal: ImeAnchorTerminal,
  options: ImeAnchorOptions = {},
): Disposable {
  const textarea = terminal.textarea;
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
  const helpers = screen?.querySelector<HTMLElement>('.xterm-helpers') ?? null;
  if (!textarea || !screen || !helpers) {
    return NO_OP;
  }
  // The inline preedit box (#942). Optional on purpose: if an xterm upgrade
  // renames it, the preedit stays on xterm's own live positioning — the
  // pre-#875 behavior Korean reporters describe as clean — instead of breaking.
  const compositionView = helpers.querySelector<HTMLElement>('.composition-view');

  const now = options.now ?? ((): number => performance.now());

  // xterm's own cell height, learned from the `style.height` it writes onto the
  // textarea in _syncTextArea. Deriving it from clientHeight instead leaves a
  // sub-pixel disagreement (xterm rounds the cell to whole device pixels, the
  // client box does not), which would make every correction a fraction off and
  // put a transform on the element even when nothing needs moving.
  let xtermCellHeight: number | null = null;

  const readGeometry = (): ImeAnchorGeometry => {
    const rows = terminal.rows;
    const cols = terminal.cols;
    const fromLayout = rows > 0 ? screen.clientHeight / rows : 0;
    // Trust xterm's number when it is in the same ballpark as the measured box;
    // anything wilder means we read something that is not a cell height.
    const cellHeight = xtermCellHeight !== null
      && xtermCellHeight > 0
      && fromLayout > 0
      && xtermCellHeight > fromLayout / 2
      && xtermCellHeight < fromLayout * 2
      ? xtermCellHeight
      : fromLayout;
    return {
      cellWidth: cols > 0 ? screen.clientWidth / cols : 0,
      cellHeight,
      rows,
      cols,
    };
  };

  const readHelpersOrigin = (): ImeAnchorPoint => ({
    left: helpers.offsetLeft,
    top: helpers.offsetTop,
  });

  // Cell metrics need a layout read, so they are cached and refreshed only on
  // resize. Recomputing them inside onRender would put a forced synchronous
  // layout in the streaming-output hot path, which is the one place this must
  // stay free.
  let geometry: ImeAnchorGeometry = readGeometry();
  // `.xterm-helpers` is `position: absolute; top: 0` inside `.xterm-screen`, so
  // this is normally {0,0}; read it anyway rather than assume, and refresh it
  // with the rest of the geometry.
  let helpersOrigin: ImeAnchorPoint = readHelpersOrigin();

  const bufferState = (): ImeAnchorBufferState => terminal.buffer.active;
  const tracker = createRestingTracker(
    bufferState().baseY + bufferState().cursorY,
    bufferState().cursorX,
    now(),
    bufferState().cursorY,
  );

  let frozen: ImeAnchorPoint | null = null;
  // Tracked separately from `frozen`: unusable geometry at compositionstart
  // leaves `frozen` null while a composition IS live, and both the cell-height
  // sampling gate and the preedit correction key off the composition itself.
  let composing = false;
  let pendingCompositionSync: ReturnType<typeof setTimeout> | null = null;

  /**
   * Where xterm currently has a child, in screen-local pixels, with our own
   * transform excluded. Read from the inline styles xterm wrote rather than
   * from `offsetTop`, so the hot path stays layout-read-free.
   */
  const readStyledPoint = (el: HTMLElement): ImeAnchorPoint | null => {
    const top = parsePxOrNull(el.style.top);
    const left = parsePxOrNull(el.style.left);
    if (top === null || left === null) return null;
    return { left: helpersOrigin.left + left, top: helpersOrigin.top + top };
  };

  /** Write-elided transform setter. #942 split the correction per child, so
   *  each child carries its own last-applied pair; `get` exposes it so the
   *  diagnostic reports what is actually on the element, not a recomputed
   *  value that may be zero while a stale transform persists. */
  const makeTransformApplier = (el: HTMLElement): {
    set(dx: number, dy: number): void;
    get(): ImeAnchorCorrection;
  } => {
    let lastDx = 0;
    let lastDy = 0;
    return {
      set(dx: number, dy: number): void {
        if (dx === lastDx && dy === lastDy) return;
        lastDx = dx;
        lastDy = dy;
        el.style.transform = dx === 0 && dy === 0 ? '' : `translate(${dx}px, ${dy}px)`;
      },
      get(): ImeAnchorCorrection {
        return { dx: lastDx, dy: lastDy };
      },
    };
  };
  const textareaTransform = makeTransformApplier(textarea);
  const preeditTransform = compositionView ? makeTransformApplier(compositionView) : null;

  const sync = (): ImeAnchorCorrection | null => {
    if (!composing) {
      // Not composing, so `style.height` is still the cell height xterm wrote
      // in _syncTextArea (during a composition it holds the preedit box size
      // instead, which is why this only samples outside one).
      const h = parsePxOrNull(textarea.style.height);
      if (h !== null && h > 0 && h !== xtermCellHeight) {
        xtermCellHeight = h;
        geometry = readGeometry();
      }
    }
    if (!isUsableGeometry(geometry)) return null;
    const actual = readStyledPoint(textarea);
    // xterm has not positioned the textarea yet (stylesheet default
    // `left: -9999em`). Nothing to correct against, and forcing a transform
    // now would only move the off-screen parking spot around.
    if (!actual) return null;
    const desired = frozen ?? paintedCursorPosition(bufferState(), geometry);
    const correction = computeImeAnchorCorrection(desired, actual);
    textareaTransform.set(correction.dx, correction.dy);
    return correction;
  };

  /**
   * The preedit follows the live cursor in a quiet pane (#942): while
   * composing it gets the same anchor math against the live cursor — the
   * ydisp term xterm forgot — so a committed syllable's echo advances the
   * composing syllable with the caret (Korean inline input). Outside a
   * composition it carries no transform (xterm hides it).
   *
   * The one exception is a composition whose freeze cell came from the quiet
   * caret or the content marker (`src=caret`/`src=marker`, #951/#953/#1016
   * field reports) while the live cursor sits on a DIFFERENT screen row than
   * the frozen cell: there the cursor is the streaming agent's repaint
   * cursor, and following it split the two IME surfaces apart — the candidate
   * window pinned at the input line while the inline pinyin chased the
   * agent's output rows. Both surfaces must anchor to the same cell, so those
   * compositions pin the preedit to the same frozen point as the textarea.
   * A live cursor on the SAME screen row keeps the live follow (#1032): fluid
   * Korean typing reaches the streaming branch too — commit echoes are
   * output, and sub-quiet gaps sustain the epoch — but there the cursor is
   * the true caret advancing along the input line while the snapshot's column
   * is one quiet-span stale, and pinning to it painted the composing syllable
   * over committed text (the very drag #945 removed, reintroduced on the new
   * path). The row test is preeditFollowsLiveCursor, evaluated per
   * composition event, so a cursor that leaves the row mid-composition (an
   * agent chunk landing between keystrokes) pins for that event and resumes
   * following when it returns. The quiet case is untouched: there the
   * selection is instant/resting and the live follow stays (#942 stays
   * fixed).
   *
   * Deliberately called only from the composition handlers, NOT from
   * onRender/onScroll: at a composition event xterm has just written the
   * preedit's styles from the same instantaneous cursor this reads, so the
   * correction reduces to the ydisp term and the preedit's motion profile
   * stays exactly stock xterm's. Following the cursor per render frame would
   * re-open the cause-3 hole for the preedit — an agent streaming into the
   * pane parks the cursor mid-repaint on real JS turns, and a per-frame
   * follow would drag the composing syllable around the screen (2-model
   * panel finding on the first cut of this fix).
   */
  const syncPreedit = (): void => {
    if (!preeditTransform || !compositionView) return;
    if (!composing) {
      preeditTransform.set(0, 0);
      return;
    }
    if (!isUsableGeometry(geometry)) return;
    const actualPreedit = readStyledPoint(compositionView);
    if (!actualPreedit) return;
    const b = bufferState();
    const desired = frozen !== null
      && lastSel !== null
      && !preeditFollowsLiveCursor(lastSel.src, lastSelRelY, b.cursorY, lastSel.rowSpan)
      ? frozen
      : paintedCursorPosition(b, geometry);
    const c = computeImeAnchorCorrection(desired, actualPreedit);
    preeditTransform.set(c.dx, c.dy);
  };

  const resetTracker = (): void => {
    const b = bufferState();
    resetRestingTracker(tracker, b.baseY + b.cursorY, b.cursorX, now(), b.cursorY);
  };

  const onRefreshGeometry = (): void => {
    geometry = readGeometry();
    helpersOrigin = readHelpersOrigin();
    // Resize reflow re-wraps the buffer — absolute rows recorded before it no
    // longer name the same content, so the resting cell must not survive.
    resetTracker();
    sync();
  };

  // Freeze-cell selection of the current composition, for the diagnostic.
  let lastSel: FreezeCellSelection | null = null;
  // Screen row of the selection, fixed at compositionstart: update/end records
  // fire after the stream may have scrolled the buffer on, and re-deriving
  // against the emission-time ybase would corrupt the very field the log
  // exists to discriminate on (panel finding).
  let lastSelRelY = 0;
  // Last corrections the diagnostic reported: update/end records fire only on
  // change, so a healthy composition costs one record and a developing offset
  // is captured the moment it develops (#942's field log was all
  // `correction=(0,0)` because the start-only diagnostic fired before the
  // committed syllable's echo moved anything).
  let reportedDx = 0;
  let reportedDy = 0;
  let reportedPreeditDx = 0;
  let reportedPreeditDy = 0;

  const emitDiagnostic = (phase: 'start' | 'update' | 'end'): void => {
    if (!options.onCompositionDiagnostic || lastSel === null) return;
    // Report what is actually applied to the elements, not the last computed
    // correction — when sync() bails (unusable geometry, unpositioned
    // textarea) a previous transform is still live, and reporting zeros there
    // would recreate the all-zeros-log misdiagnosis #942 was filed with.
    const { dx, dy } = textareaTransform.get();
    const preedit = preeditTransform?.get() ?? { dx: 0, dy: 0 };
    if (phase !== 'start'
      && dx === reportedDx && dy === reportedDy
      && preedit.dx === reportedPreeditDx && preedit.dy === reportedPreeditDy) {
      return;
    }
    reportedDx = dx;
    reportedDy = dy;
    reportedPreeditDx = preedit.dx;
    reportedPreeditDy = preedit.dy;
    const b = bufferState();
    options.onCompositionDiagnostic({
      phase,
      baseY: b.baseY,
      viewportY: b.viewportY,
      cursorY: b.cursorY,
      cursorX: b.cursorX,
      cellHeight: geometry.cellHeight,
      dx,
      dy,
      preeditDx: preedit.dx,
      preeditDy: preedit.dy,
      src: lastSel.src,
      held: lastSel.held,
      restAge: lastSel.restAge,
      outputGap: lastSel.outputGap,
      caretAge: lastSel.caretAge,
      edge: lastSel.edge,
      rowSpan: lastSel.rowSpan,
      selY: lastSelRelY,
      selX: lastSel.col,
    });
  };

  const onCompositionStart = (): void => {
    // Pin the textarea anchor for the whole composition. The buffer cursor
    // keeps moving while the agent streams, but the candidate window belongs
    // where the user started typing, not wherever the TUI's redraw last left
    // the cursor. The cell it pins to is the resting-tracker selection: the
    // instantaneous cursor when it is at rest, the last resting cell when the
    // composition starts inside a repaint burst (cause 3).
    composing = true;
    const b = bufferState();
    // #1016: while output flows, the cursor never visits the input caret
    // (Claude Code parks it at the end of painted content — any column), so
    // for a recognized agent the input line is read out of the buffer
    // instead. A thunk: selectFreezeCell invokes it only inside the
    // streaming branch, so the idle pane — field-verified correct on the
    // cursor path — never scans. The scan reads the LIVE screen (baseY),
    // not the viewport: a user scrolled up mid-stream sees history, which
    // can quote the very chrome being scanned for.
    const getMarker = options.getAgentSlug?.() === 'claude'
      ? (): AgentInputLineMarker | null => scanClaudeInputLine(
          (relRow) => terminal.buffer.active.getLine?.(b.baseY + relRow)?.translateToString(true),
          geometry.rows,
        )
      : undefined;
    const sel = selectFreezeCell(tracker, b.baseY + b.cursorY, b.cursorX, now(), {
      top: b.viewportY,
      rows: geometry.rows,
      cols: geometry.cols,
    }, b.baseY, getMarker);
    lastSel = sel;
    lastSelRelY = sel.absRow - b.baseY;
    frozen = isUsableGeometry(geometry)
      ? pointFromCell(sel.absRow, sel.col, b, geometry)
      : null;
    sync();
    syncPreedit();
    emitDiagnostic('start');
  };

  const onCompositionUpdate = (): void => {
    // xterm's own compositionupdate handler already ran (it registered first)
    // and re-anchored the children; correct on top of that. It also queues a
    // setTimeout(0) re-run of the same repositioning, so queue one behind it.
    sync();
    syncPreedit();
    emitDiagnostic('update');
    if (pendingCompositionSync !== null) clearTimeout(pendingCompositionSync);
    pendingCompositionSync = setTimeout(() => {
      pendingCompositionSync = null;
      sync();
      syncPreedit();
      emitDiagnostic('update');
    }, 0);
  };

  const onCompositionEnd = (): void => {
    composing = false;
    frozen = null;
    // A deferred update-sync from this composition must not straddle into the
    // next one and report against its selection.
    if (pendingCompositionSync !== null) {
      clearTimeout(pendingCompositionSync);
      pendingCompositionSync = null;
    }
    sync();
    syncPreedit();
    emitDiagnostic('end');
    lastSel = null;
  };

  // onRender fires after xterm has written the child styles for the frame, so
  // reading them here never sees a half-updated position. Only the textarea is
  // corrected here — see syncPreedit for why the preedit must not follow the
  // per-frame cursor.
  const renderSub = terminal.onRender(() => sync());
  // xterm does NOT re-sync the textarea on scroll — that omission is half of
  // #874 — so this is where the scrolled-viewport correction actually lands.
  const scrollSub = terminal.onScroll(() => sync());
  const resizeSub = terminal.onResize(onRefreshGeometry);
  // Coalesced per parse batch by xterm; the handler is a compare plus a few
  // number writes, so the streaming hot path stays cold.
  const cursorSub = terminal.onCursorMove(() => {
    const b = bufferState();
    noteCursorMove(tracker, b.baseY + b.cursorY, b.cursorX, now(), b.cursorY);
  });
  // Per parsed PTY chunk — the output-recency signal (#951). The handler is a
  // clock compare plus at most three number writes, so the streaming hot path
  // stays cold. noteOutputParsed tolerates either firing order relative to
  // onCursorMove within a chunk (see its doc comment).
  const writeParsedSub = terminal.onWriteParsed(() => noteOutputParsed(tracker, now(), terminal.cols));
  // Normal <-> alt buffer switches change what an absolute row means.
  const bufferSub = terminal.buffer.onBufferChange(resetTracker);

  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('compositionupdate', onCompositionUpdate);
  textarea.addEventListener('compositionend', onCompositionEnd);

  sync();

  return {
    dispose: (): void => {
      renderSub.dispose();
      scrollSub.dispose();
      resizeSub.dispose();
      cursorSub.dispose();
      writeParsedSub.dispose();
      bufferSub.dispose();
      textarea.removeEventListener('compositionstart', onCompositionStart);
      textarea.removeEventListener('compositionupdate', onCompositionUpdate);
      textarea.removeEventListener('compositionend', onCompositionEnd);
      if (pendingCompositionSync !== null) clearTimeout(pendingCompositionSync);
      textarea.style.transform = '';
      if (compositionView) compositionView.style.transform = '';
    },
  };
}
