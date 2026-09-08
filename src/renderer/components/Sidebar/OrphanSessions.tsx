import { useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { HIT_TARGET_24_ROW } from '../hitArea';
import { IconX } from '../icons';
import { timeAgo } from '../../utils/timeAgo';

/**
 * #1101 — orphaned daemon sessions: still running, owned by no pane.
 *
 * Sessions survive pane close and app quit by design (the daemon holds the
 * PTY), but nothing in the UI listed them — the only visibility was the tray's
 * background-session count. This section is that list, in the sidebar under
 * the workspaces: click a row to bring the session back into a pane (a new
 * leaf bound to its id; the terminal's reconnect path attaches), or kill it.
 *
 * Renders ONLY when the list is non-empty — this is recovery chrome, not a
 * standing surface. Rows stay monochrome: alive-but-unnecessary is not the
 * amber "alive + focus" grammar, and these sessions asked for nothing.
 */
export default function OrphanSessions() {
  const t = useT();
  const orphans = useStore((s) => s.orphanSessions);
  const adoptOrphanSession = useStore((s) => s.adoptOrphanSession);
  const disposeOrphanSession = useStore((s) => s.disposeOrphanSession);
  const refresh = useStore((s) => s.refreshOrphanSessions);

  // Slow poll: orphans appear via app quit / crash / a dispose that raced a
  // daemon disconnect — none of which the renderer sees an event for. 30s is
  // far under the resource cost the issue is about and far above noise.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (orphans.length === 0) return null;

  return (
    <div
      className="pt-2 mt-1 border-t space-y-0.5"
      style={{ borderColor: 'var(--border-soft)' }}
      data-orphan-sessions
    >
      <p className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {t('sidebar.orphanSessions')} · {orphans.length}
      </p>
      {orphans.map((session) => {
        const created = session.createdAt ? new Date(session.createdAt).getTime() : undefined;
        const ago = created ? timeAgo(created) : undefined;
        return (
          <div key={session.id} className="flex items-center min-w-0 group/orphan-row">
            <button
              type="button"
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors hover:bg-[rgba(var(--bg-surface-rgb),0.65)] ${HIT_TARGET_24_ROW} ${FOCUS_RING}`}
              title={t('sidebar.orphanAdopt')}
              aria-label={`${session.label}${session.cwd ? `, ${session.cwd}` : ''} — ${t('sidebar.orphanAdopt')}`}
              onClick={() => { adoptOrphanSession(session.id); }}
            >
              {/* Filled, muted: alive (a hollow ring dies under
                  forced-colors), but not asserting the amber alive grammar. */}
              <span className="sidebar-dot h-1.5 w-1.5 flex-none rounded-full bg-[var(--text-muted)]" />
              <span className="flex min-w-0 flex-1 items-baseline gap-1">
                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-[var(--text-main)]">
                  {session.label}
                </span>
                {session.cwd && (
                  <span className="max-w-[40%] flex-none truncate text-[10px] font-mono text-[var(--text-muted)]">
                    {session.cwd}
                  </span>
                )}
              </span>
              {ago && (
                <span className="flex-none text-[10px] text-[var(--text-muted)]">{ago}</span>
              )}
            </button>
            <button
              type="button"
              className={`${HIT_TARGET_24_ROW} ml-0.5 rounded text-[var(--text-muted)] opacity-0 transition-opacity group-hover/orphan-row:opacity-100 hover:text-[var(--accent-red)] ${FOCUS_RING}`}
              title={t('sidebar.orphanDispose')}
              aria-label={t('sidebar.orphanDispose')}
              onClick={() => { void disposeOrphanSession(session.id); }}
            >
              <IconX size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
