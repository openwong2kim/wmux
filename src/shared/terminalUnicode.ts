/**
 * Single source of truth for the terminal width model.
 *
 * Two places own a terminal grid that must agree — the renderer's xterm
 * (useTerminal.ts) and the daemon's headless snapshot terminals
 * (HeadlessSnapshot.ts) — because a snapshot is restored onto the renderer's
 * grid. If they drift, a restored snapshot paints cell-shifted against the
 * live screen: the daemon wraps a row at a different column than the screen
 * does, and everything after it sits one or more cells off.
 *
 * Nothing in the type system enforced that before: each site named the addon
 * and the version string itself, so a future addon bump that updated one site
 * and missed another would diverge silently and still pass CI — every test
 * would go green with the two grids measuring differently. Both sites now go
 * through `applyUnicodeWidthModel`, which makes the divergence unspeakable:
 * there is one addon choice and one version string, in one place.
 *
 * There is a THIRD grid that does NOT use this helper: the `wmux web` browser
 * terminal (`src/daemon/web/frontend/app.js`) loads no Unicode addon at all and
 * so renders at xterm's Unicode 6 default. That divergence predates this
 * module — closing it means inlining the addon into the hand-built web bundle
 * and regenerating the CSP script hashes (`webCsp.ts`), which is its own piece
 * of work. Do not read this file as evidence that every wmux terminal agrees.
 *
 * The E0 conformance harness (`core/harness/`) also does NOT use this helper;
 * it is pinned to Unicode 11 independently as the differential baseline. See
 * the note at the top of `core/harness/differ.ts`.
 *
 * ── Why Unicode 11 and not grapheme clustering ──────────────────────────────
 *
 * `@xterm/addon-unicode-graphemes` measures by grapheme cluster (UAX #29), so a
 * ZWJ sequence, a skin-tone modifier, a keycap and a VS16 emoji-presentation
 * selector each measure as ONE 2-cell cluster instead of the sum of their
 * codepoints. That is more correct per spec. It was evaluated in full and
 * DECLINED (owner decision, 2026-07-28). Do not re-propose it without new
 * information; the reasons were:
 *
 *   1. VS16 is the only class it actually changes for our content, and it is
 *      the contested one. Programs on the other side of the PTY — ncurses, Go
 *      `runewidth` in its default mode, older Python `wcwidth` — still measure
 *      ⚠️ ❤️ ✔️ as ONE column using the classic wcwidth tables. Those programs
 *      are exactly what runs in our panes, so widening VS16 buys spec accuracy
 *      at the cost of agreeing with the apps we host.
 *   2. Upstream decodes its compressed Unicode trie with
 *      `new DataView(data.buffer)`, dropping `byteOffset`. Node returns a small
 *      `Buffer.from(str, 'base64')` as a view into its shared pool, so in any
 *      Node process that already allocated a small Buffer the addon reads its
 *      trie header out of unrelated bytes — throwing `Data error`, hanging on a
 *      multi-gigabyte allocation, or (worst) loading quietly and answering with
 *      wrong widths. Reported upstream:
 *      https://github.com/xtermjs/xterm.js/issues/6079. Working around it in
 *      the embedder is possible but leaves module import ORDER load-bearing.
 *   3. A grapheme cluster is held in a single cell and UAX #29 puts no bound on
 *      its length, so one cell can hold an entire ZWJ run (measured: 1,499,999
 *      characters). A scrollback limit counted in ROWS then stops bounding the
 *      buffer's memory.
 *   4. CJK throughput measured ~37% lower.
 *
 * The trade is: multi-codepoint emoji (👨‍👩‍👧, 👍🏽, 1️⃣) measure as the sum of
 * their codepoints and therefore over-measure. That is a real, known defect —
 * it just costs less than the four above.
 */

import { Unicode11Addon } from '@xterm/addon-unicode11';

/**
 * Unicode version registered by `Unicode11Addon`. Every site that measures
 * character width must activate exactly this string; a mismatch silently drops
 * the terminal back to xterm's Unicode 6 default.
 */
export const TERMINAL_UNICODE_VERSION = '11';

/**
 * The subset of a terminal this helper touches. Declared structurally so the
 * same function serves the renderer's `@xterm/xterm` Terminal and the daemon's
 * `@xterm/headless` Terminal, whose `ITerminalAddon` types come from different
 * packages and are otherwise not interchangeable.
 */
export interface UnicodeWidthTarget {
  loadAddon(addon: never): void;
  unicode: { activeVersion: string };
}

/**
 * Load the Unicode 11 width tables and activate them.
 *
 * Requires the terminal to have been constructed with `allowProposedApi: true`
 * — registering a Unicode version provider is a proposed API, and xterm throws
 * without it.
 *
 * The addon instance is deliberately not returned: no caller needs it, and
 * handing one out is how a second site ends up managing the width model
 * separately from this one.
 */
export function applyUnicodeWidthModel(terminal: UnicodeWidthTarget): void {
  terminal.loadAddon(new Unicode11Addon() as never);
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
