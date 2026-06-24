/**
 * Build-time feature flags.
 *
 * COMPANY_MODE_ENABLED — the in-app "company / AI team / departments" mode
 * (src/company) is a separate paid product idea ("wmux max"). Its source and
 * logic stay in the tree, but the UI entry points are gated off by this flag:
 *   - the Sidebar workspaces⇄company toggle button
 *   - the Sidebar CompanyPanel render
 *   - the command-palette "Company: …" commands
 * Flip to `true` in a paid build to re-enable the whole company UI. Channels
 * are decoupled from company mode and are unaffected either way.
 */
export const COMPANY_MODE_ENABLED = false;
