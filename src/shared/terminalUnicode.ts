/**
 * Single source of truth for the terminal width model.
 *
 * Two places own a terminal grid — the renderer's xterm (useTerminal.ts) and
 * the daemon's headless snapshot terminals (HeadlessSnapshot.ts) — and they
 * MUST measure character width identically. If they drift, a restored snapshot
 * paints cell-shifted against the live screen: the daemon wraps a row at a
 * different column than the screen does, and everything after it sits one or
 * more cells off.
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
 */
export function applyUnicodeWidthModel(terminal: UnicodeWidthTarget): void {
  terminal.loadAddon(new UnicodeGraphemesAddon() as never);
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
