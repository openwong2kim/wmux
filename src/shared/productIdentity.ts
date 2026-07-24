/**
 * Forge Mux product identity — the small, deliberate collision-facing layer.
 *
 * Keep upstream source identifiers (symbols, filenames, env vars, CSS classes)
 * as `wmux` so rebases stay reviewable. Only these user-facing / install /
 * coexistence boundaries use the Forge values below.
 */

/** Display name shown in About, tray, dialogs, and Settings. */
export const PRODUCT_NAME = 'Forge Mux';

/** Short slug: package name, CLI binary, MCP server key, data/app dirs. */
export const PRODUCT_SLUG = 'fmux';

/** Primary CLI invocation name (`bin` in package.json). */
export const PRODUCT_CLI = 'fmux';

/** Public repository URL for About / Settings links. */
export const PRODUCT_REPO_URL = 'https://github.com/skflowne/fmux';
