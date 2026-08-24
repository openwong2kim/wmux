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

const AUTO_DISMISS_MS = 5_000;

function levelColor(level: ToastLevel): string {
  switch (level) {
    case 'error':
      return 'var(--accent-red, #f38ba8)';
    case 'warn':
      return 'var(--accent-yellow, #f9e2af)';
    case 'info':
    default:
      return 'var(--accent-blue, #89b4fa)';
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
}: {
  id: string;
  message: string;
  level: ToastLevel;
  action?: { label: string; onClick: () => void };
  target?: Toast['target'];
  persist?: boolean;
  durationMs?: number;
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

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 px-3 py-2 rounded-lg shadow-lg max-w-sm text-xs"
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
        <span className="flex-1 leading-snug">{message}</span>
      )}
      {/* F5 — optional action button (fan-out "diff 열기"). Runs then dismisses. */}
      {action && (
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
            boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 1px 2px rgba(0, 0, 0, 0.3)',
          }}
        >
          {action.label}
        </button>
      )}
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

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none"
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
          />
        </div>
      ))}
    </div>
  );
}
