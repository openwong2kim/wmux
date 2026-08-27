/**
 * #1055 — pure decision logic for AppLayout's update notices.
 *
 * Extracted from the hooks so the behavior is unit-testable: AppLayout has no
 * jsdom fixture (the house pattern pins its hooks structurally, see
 * appLayout.updateNotices.test.ts), and these decisions are exactly the ones
 * a structural regex cannot verify.
 */

import type { ElectronAPI } from '../../../preload/preload';

/**
 * Payload of IPC.UPDATE_ERROR as the renderer sees it — derived from the
 * preload surface (the repo's single source of truth for this shape,
 * `ElectronAPI = typeof electronAPI`) so this module cannot silently drift
 * when a field is added there.
 *
 * Semantics: `source: 'install'` is present on every error sent from an
 * install context (performInstall's refusals, the install watchdog, the
 * whole darwin install path) and never on background check/download
 * failures. `code: 'in-progress'` marks the re-entrancy refusal — shown,
 * but it must not re-offer the Install button (the in-flight attempt
 * re-announces on its own outcome).
 */
export type UpdateErrorData =
  Parameters<Parameters<ElectronAPI['updater']['onUpdateError']>[0]>[0];

/**
 * Whether an UPDATE_ERROR belongs on the always-mounted toast surface.
 *
 * Tagged (`source: 'install'`) → always. An install error is install-origin by
 * construction, so the click-correlation window is unnecessary — and harmful:
 * the macOS staging/handoff deadlines legitimately fire minutes after the
 * click, and the one-shot "check for updates" install never stamps a click at
 * all. Both were silently dropped by the window (#1055 review).
 *
 * Untagged → the original 30s-from-click window, unchanged: UPDATE_ERROR also
 * carries failed background polls (the first runs ~15s after launch) and
 * failed downloads, and an offline machine must not post "could not be
 * installed" every poll on a persistent surface.
 */
export function shouldShowInstallError(
  data: UpdateErrorData,
  installRequestedAt: number,
  now: number,
  windowMs: number,
): boolean {
  if (data.source === 'install') return true;
  return installRequestedAt !== 0 && now - installRequestedAt <= windowMs;
}

/** After a shown install error, should the ready-to-install toast come back? */
export function shouldReannounceAfterError(data: UpdateErrorData): boolean {
  return data.code !== 'in-progress';
}

/**
 * Bound the marker/reason detail for a toast. Toasts are narrow (max-w-sm,
 * text-xs) with no overflow guard, and the refusal toast is persistent — an
 * unbounded reason would crowd the 10-slot oldest-evicting toast list.
 */
export function truncateReason(reason: string, max = 200): string {
  const trimmed = reason.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
