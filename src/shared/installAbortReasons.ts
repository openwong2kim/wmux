/**
 * #1525 — marker reasons the install waiter writes that the renderer needs to
 * recognize, shared so the writer (installTeardown.ts, main) and the reader
 * (AppLayout's refused-install notice, renderer) cannot drift apart.
 *
 * Matching marker TEXT is normally unsafe (see takeRefusedInstall in
 * AutoUpdater.ts): the marker is written by the pre-upgrade build's waiter and
 * read by whatever build boots next. For this reason that concern does not
 * apply — a blocked installer never ran, so the build that boots next is the
 * same build that generated the waiter. A reason the reader does not
 * recognize still falls back to the generic refused-install notice.
 */

/** Stable prefix the renderer matches on. */
export const INSTALL_BLOCKED_BY_WINDOWS_PREFIX = 'install-aborted: Windows blocked the installer';

/**
 * Written when Start-Process fails with ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION
 * (4551 — Smart App Control / App Control for Business) or
 * ERROR_ACCESS_DISABLED_BY_POLICY (1260 — Software Restriction / AppLocker).
 * Single line, no apostrophes: it is embedded in the generated PowerShell.
 */
export const INSTALL_BLOCKED_BY_WINDOWS_REASON =
  `${INSTALL_BLOCKED_BY_WINDOWS_PREFIX} (Smart App Control or an application control policy). ` +
  'wmux was left unchanged. Try again in a day or two, or install from the releases page once Windows allows it.';

export function isInstallBlockedByWindowsReason(reason: string): boolean {
  return reason.trim().startsWith(INSTALL_BLOCKED_BY_WINDOWS_PREFIX);
}
