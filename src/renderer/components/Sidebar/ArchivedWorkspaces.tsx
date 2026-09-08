import { useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { timeAgo } from '../../utils/timeAgo';
import { workspaceColorHex } from '../../../shared/workspaceColors';

/**
 * #1011 — the Archived section: workspaces the user put away. Collapsed by
 * default (the whole point is a quiet sidebar), one line per snapshot with
 * Restore on click and a permanent Delete on hover — the two-step ladder the
 * issue asks for: Active → Archived → Permanently Deleted.
 *
 * Restoring brings the configuration back as a LIVE workspace: same name,
 * color tag, profile and pane arrangement, fresh sessions. Rendered only
 * when something is archived.
 */
export default function ArchivedWorkspaces() {
  const t = useT();
  const archived = useStore((s) => s.archivedWorkspaces);
  const restoreArchivedWorkspace = useStore((s) => s.restoreArchivedWorkspace);
  const deleteArchivedWorkspace = useStore((s) => s.deleteArchivedWorkspace);
  const [open, setOpen] = useState(false);

  if (archived.length === 0) return null;

  return (
    <div className="pt-2 mt-1 border-t" style={{ borderColor: 'var(--border-soft)' }} data-archived-workspaces>
      <button
        type="button"
        className={`flex w-full items-center gap-1.5 px-1 py-0.5 text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text-sub)] ${FOCUS_RING}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden="true"
          className="w-3 h-3 flex-none inline-flex items-center justify-center text-[10px] font-mono transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          ▸
        </span>
        {t('workspace.archived')} · {archived.length}
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5">
          {[...archived].reverse().map((entry) => (
            <div key={entry.id} className="flex items-center min-w-0 group/archived-row">
              <button
                type="button"
                className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-[3px] text-left transition-colors hover:bg-[rgba(var(--bg-surface-rgb),0.65)] ${FOCUS_RING}`}
                title={t('workspace.restore')}
                aria-label={`${entry.name} — ${t('workspace.restore')}`}
                onClick={() => { restoreArchivedWorkspace(entry.id); }}
              >
                <span
                  className="h-1.5 w-1.5 flex-none rounded-full"
                  style={workspaceColorHex(entry.color)
                    ? { backgroundColor: workspaceColorHex(entry.color) }
                    : { border: '1px solid var(--text-muted)' }}
                />
                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-[var(--text-main)]">
                  {entry.name}
                </span>
                <span className="flex-none text-[10px] text-[var(--text-muted)]">
                  {timeAgo(entry.archivedAt)}
                </span>
              </button>
              <button
                type="button"
                className="ml-0.5 rounded px-1 text-[var(--text-muted)] opacity-0 transition-opacity group-hover/archived-row:opacity-100 hover:text-[var(--accent-red)]"
                title={t('workspace.deletePermanently')}
                aria-label={`${entry.name} — ${t('workspace.deletePermanently')}`}
                onClick={() => { deleteArchivedWorkspace(entry.id); }}
              >
                <span aria-hidden="true" className="text-[10px] font-mono">✕</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
