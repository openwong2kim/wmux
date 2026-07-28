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
 * There is a THIRD grid that does NOT use this helper: the `wmux web` browser
 * terminal (`src/daemon/web/frontend/app.js`) loads no Unicode addon at all and
 * so renders at xterm's Unicode 6 default. That divergence predates this
 * module — closing it means inlining the addon into the hand-built web bundle
 * and regenerating the CSP script hashes (`webCsp.ts`), which is its own piece
 * of work. Do not read this file as evidence that every wmux terminal agrees.
 *
 * Nothing in the type system enforced that before: each site named the addon
 * and the version string itself, so a future addon bump that updated one site
 * and missed another would diverge silently and still pass CI. Both sites now
 * go through `applyUnicodeWidthModel`, which makes the divergence unspeakable
 * — there is one addon choice and one version string, in one place.
 *
 * The E0 conformance harness (`core/harness/`) deliberately does NOT use this
 * helper; it is pinned to Unicode 11 as the differential baseline. See the
 * note at the top of `core/harness/differ.ts`.
 */

import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';

/**
 * KNOWN LIMITATION (accepted, not a TODO — decided 2026-07-28).
 *
 * A grapheme cluster is stored in ONE cell, and Unicode places no bound on how
 * long a cluster may be. A ZWJ chain of N emoji is, per UAX #29, a single
 * cluster, so one cell ends up holding the whole run: measured at 1,499,999
 * characters in a single cell from a 500k-emoji chain.
 *
 * The consequence worth knowing: a terminal buffer's memory is normally bounded
 * by `rows × cols × O(1) per cell`, and this removes the `O(1) per cell` term.
 * A scrollback limit counted in ROWS therefore stops bounding the buffer's
 * memory. Row eviction still works — push the row out and it is freed — but
 * while it is retained it can cost arbitrarily more than its one row suggests.
 *
 * Deliberately NOT mitigated here. The only in-process fix is a bounded
 * `IUnicodeVersionProvider` wrapper, which would have to reproduce xterm's
 * private property-value bit encoding; that is worse long-term debt than the
 * bug, because it breaks silently whenever upstream changes the encoding. The
 * behaviour is a property of the upstream addon (hence its "experimental"
 * warning), the damage is availability-only, and closing the pane recovers it.
 *
 * `scripts/repro-grapheme-cell-growth.mjs` reproduces it with no wmux deps.
 */

/**
 * Unicode version registered by `UnicodeGraphemesAddon`. Unicode 15 tables plus
 * grapheme-cluster segmentation, so a ZWJ sequence, a regional-indicator flag,
 * an emoji + skin-tone modifier and a VS16 emoji-presentation selector each
 * measure as ONE cluster of width 2 rather than the sum of their codepoints.
 */
export const TERMINAL_UNICODE_VERSION = '15-graphemes';

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
 * Load the grapheme-aware width tables and activate them.
 *
 * Requires the terminal to have been constructed with `allowProposedApi: true`
 * — registering a Unicode version provider is a proposed API, and xterm throws
 * without it.
 *
 * The addon instance is deliberately not returned: unlike `Unicode11Addon`,
 * whose `dispose()` was a no-op, `UnicodeGraphemesAddon.dispose()` restores
 * whatever `activeVersion` was set before it loaded — i.e. '6'. Disposing this
 * addon on its own (rather than with the terminal, as WebglAddon sometimes is)
 * would silently drop a live terminal back to Unicode 6 widths. Keeping the
 * handle unreachable makes that mistake impossible to write.
 */
export function applyUnicodeWidthModel(terminal: UnicodeWidthTarget): void {
  terminal.loadAddon(new UnicodeGraphemesAddon() as never);
  // Redundant today (activate() already selects this version) but explicit, so
  // the active version is pinned here rather than inherited from addon internals.
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
