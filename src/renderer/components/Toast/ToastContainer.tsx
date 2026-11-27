/**
 * T4 — Toast container.
 *
 * Renders transient toasts from the `toastSlice`. Each toast auto-dismisses
 * after 5 seconds, and can be dismissed early via the close button.
 *
 * Intentionally minimal — uses existing CSS variables (--bg-mantle,
 * --accent-*, --text-main) so it inherits the active theme.
 */
import { useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { Toast, ToastLevel } from '../../stores/slices/toastSlice';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { prepNoticeToast } from '../../../shared/gitHandoff';
import { prepCardToast, type WorkspacePrepCardStatus } from '../../../shared/workspacePrepCard';

const AUTO_DISMISS_MS = 5_000;

function levelColor(level: ToastLevel): string {
  switch (level) {
    case 'error':
      return 'var(--accent-red)';
    case 'warn':
      return 'var(--accent-yellow)';
    case 'info':
    default:
      return 'var(--accent-blue)';
  }
}

function ToastItem({
  id,
  message,
  level,
  action,
  target,
  persist,
  durationMs,
  code,
}: {
  id: string;
  message: string;
  level: ToastLevel;
  action?: { label: string; onClick: () => void };
  target?: Toast['target'];
  persist?: boolean;
  durationMs?: number;
  code?: string;
}) {
  const t = useT();
  const dismissToast = useStore((s) => s.dismissToast);

  useEffect(() => {
    // A persistent toast reports a state that is still true after five seconds
    // and needs the user to act (#898). The ✕ is still the way out.
    if (persist) return;
    const t = setTimeout(() => dismissToast(id), durationMs ?? AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [id, dismissToast, persist, durationMs]);

  // Notification-sourced toasts carry a click-jump target: body click lands
  // on the originating pane (ptyId → surfaceId → workspaceId resolution),
  // then dismisses — same contract as the OS toast / panel row click.
  const jumpToTarget = target
    ? () => {
        focusNotificationTarget(() => useStore.getState(), target);
        dismissToast(id);
      }
    : undefined;

  // F5 — optional action button (fan-out "diff 열기"). Runs then dismisses.
  const actionButton = action && (
    <button
      type="button"
      onClick={() => {
        action.onClick();
        dismissToast(id);
      }}
      className="flex-shrink-0 px-2 py-0.5 rounded font-semibold transition-colors"
      style={{
        backgroundColor: 'var(--accent)',
        color: 'var(--bg-base)',
        boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--surface-highlight) 22%, transparent), 0 1px 2px rgba(0, 0, 0, 0.3)',
      }}
    >
      {action.label}
    </button>
  );

  // A toast with a code block puts its action under the block, so the message
  // and the code take the toast's full width instead of sharing a row with it.
  const actionBelowCode = Boolean(code) && !jumpToTarget;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 px-3 py-2 rounded-[7px] shadow-lg max-w-sm text-xs"
      style={{
        backgroundColor: 'var(--bg-mantle)',
        border: `1px solid ${levelColor(level)}`,
        color: 'var(--text-main)',
      }}
    >
      <span
        className="inline-block w-2 h-2 rounded-full mt-1 flex-shrink-0"
        style={{ backgroundColor: levelColor(level) }}
        aria-hidden="true"
      />
      {jumpToTarget ? (
        <button
          type="button"
          onClick={jumpToTarget}
          title={t('toast.goToTerminal')}
          className="flex-1 leading-snug text-left cursor-pointer bg-transparent border-0 p-0 text-inherit hover:underline"
        >
          {message}
        </button>
      ) : (
        <span className="flex-1 min-w-0 leading-snug" style={{ overflowWrap: 'anywhere' }}>
          {message}
          {code && (
            <code data-toast-code className="ui-code block mt-1" style={{ overflowWrap: 'anywhere' }}>{code}</code>
          )}
          {actionBelowCode && actionButton && <span className="flex mt-2">{actionButton}</span>}
        </span>
      )}
      {!actionBelowCode && actionButton}
      <button
        type="button"
        aria-label={t('toast.dismiss')}
        onClick={() => dismissToast(id)}
        className="text-[color:var(--text-muted)] hover:text-[color:var(--text-main)] transition-colors flex-shrink-0"
      >
        ✕
      </button>
    </div>
  );
}

export default function ToastContainer() {
  const t = useT();
  const toasts = useStore((s) => s.toasts);
  // The Bots page keeps its composer and working rail at the bottom right:
  // toasts drop from the top there instead of covering them, below the
  // titlebar (40px) AND the page's 44px header band, whose right end holds the
  // narrow layout's workers button and the worker panel's controls (#2231).
  const top = useStore((s) => s.appRoute === 'bots');

  // A new worktree's preparation notice from main (Quick Launch): one toast.
  useEffect(() => {
    const off = window.electronAPI?.workspacePrepNotice?.on((notice) => {
      const toast = prepNoticeToast(notice);
      if (toast) useStore.getState().pushToast({ level: 'warn', message: t(toast.key, toast.values) });
    });
    return () => off?.();
  }, [t]);

  // A "Preparing" card that failed, was skipped or left files out: a toast
  // too, so it is seen from any page (the card in the sidebar is where to
  // answer it).
  useEffect(() => {
    const seen = new Map<string, WorkspacePrepCardStatus>();
    const off = window.electronAPI?.workspacePrep?.onCard((card) => {
      const toast = prepCardToast(seen.get(card.id), card);
      if (card.status === 'closed') seen.delete(card.id);
      else seen.set(card.id, card.status);
      if (toast) useStore.getState().pushToast({ level: 'warn', message: t(toast.key, toast.values) });
    });
    return () => off?.();
  }, [t]);

  if (toasts.length === 0) return null;

  return (
    <div
      data-toast-edge={top ? 'top' : 'bottom'}
      className={`fixed ${top ? 'top-[92px]' : 'bottom-4'} right-4 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none`}
      aria-label={t('toast.notifications')}
    >
      {/* `toast`, not `t` — the translator is in scope here now, and shadowing
          it makes the next t('…') added inside this map a TypeError. */}
      {toasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <ToastItem
            id={toast.id}
            message={toast.message}
            level={toast.level}
            action={toast.action}
            target={toast.target}
            persist={toast.persist}
            durationMs={toast.durationMs}
            code={toast.code}
          />
        </div>
      ))}
    </div>
  );
}
