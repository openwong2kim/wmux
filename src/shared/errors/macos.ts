// macOS-specific error catalog.
//
// Tier 2 Rust-style messages: state the problem, name the cause, and give the
// user the exact command they should run. New macOS users hit a small set of
// well-known speed bumps (Gatekeeper, Xcode CLT missing, MCP file ACLs, brew
// tap discovery, Playwright quarantine). Centralizing the wording keeps every
// surface (CLI banner, registrar throw, MCP server stderr) on the same script.
//
// This module only DEFINES the catalog. Wiring it into specific catch sites
// (registrar ENOACCES, etc.) happens in a follow-up batch — see the task brief.
// Do not import this from runtime call sites yet.

export interface MacosErrorTemplate {
  /** Stable identifier — safe to log, search, and match in tests. */
  code: string;
  /** What the user actually sees / experiences. */
  problem: string;
  /** Why it happens (one sentence; no jargon the user can't act on). */
  cause: string;
  /** Exact command(s) or step(s) to fix it. Copy-pasteable. */
  fix: string;
  /** Optional link for users who want background. */
  docsUrl?: string;
}

export const MACOS_ERRORS = {
  gatekeeperBlocked: {
    code: 'GATEKEEPER_BLOCKED',
    problem:
      'macOS won\'t open wmux: "wmux can\'t be opened because Apple cannot check it for malicious software"',
    cause:
      'The downloaded build is not yet notarized by Apple, or the quarantine extended attribute is set. Notarized DMGs from GitHub Releases skip this dialog.',
    fix:
      'Right-click wmux.app -> Open -> confirm. Or run: xattr -d com.apple.quarantine /Applications/wmux.app',
    docsUrl: 'https://support.apple.com/guide/mac-help/mh40616/mac',
  },
  nodePtyBuildFailed: {
    code: 'NODE_PTY_BUILD_FAILED',
    problem: 'node-pty failed to build during npm install',
    cause:
      'Xcode Command Line Tools are required for native module compilation but are not installed.',
    fix: 'Run: xcode-select --install -- then re-run npm install',
  },
  mcpPermissionDenied: {
    code: 'MCP_PERMISSION_DENIED',
    problem: 'wmux could not register the MCP server in ~/.claude.json',
    cause:
      'The file exists but is not writable by the current user (likely due to Time Machine restore or sudo write).',
    fix:
      'Run: chmod 600 ~/.claude.json -- or delete and recreate: mv ~/.claude.json ~/.claude.json.bak && wmux mcp register',
  },
  brewTapNotFound: {
    code: 'BREW_TAP_NOT_FOUND',
    problem: "brew install openwong2kim/tap/wmux fails with 'No such tap'",
    cause: 'Homebrew tap is not registered locally.',
    fix:
      'Run: brew tap openwong2kim/tap https://github.com/openwong2kim/homebrew-tap -- then retry the install',
  },
  playwrightChromiumQuarantine: {
    code: 'PLAYWRIGHT_CHROMIUM_QUARANTINE',
    problem:
      "browser_open fails with 'cannot launch chromium' or system Gatekeeper dialog",
    cause:
      'Playwright downloaded chromium at runtime; macOS quarantined the binary because it was not notarized in our build process.',
    fix:
      'Run: xattr -d com.apple.quarantine ~/.cache/ms-playwright/chromium-*/chrome-mac/Chromium.app -- then retry browser_open',
  },
} as const satisfies Record<string, MacosErrorTemplate>;

export type MacosErrorKey = keyof typeof MACOS_ERRORS;

/**
 * Format a macOS error template into a multi-line message suitable for stderr,
 * a CLI banner, or a thrown Error. All four fields are emitted in a fixed
 * order so tests and snapshots stay stable.
 */
export function formatMacosError(t: MacosErrorTemplate): string {
  const lines = [
    `error[${t.code}]: ${t.problem}`,
    '',
    `  cause: ${t.cause}`,
    `  fix:   ${t.fix}`,
  ];
  if (t.docsUrl) {
    lines.push(`  docs:  ${t.docsUrl}`);
  }
  return lines.join('\n');
}
