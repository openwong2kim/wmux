import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';

// ─── Recent unattended fan-outs (Approvals tab) ──────────────────────────────
//
// Fan-out runs without a prompt by default, so the Approvals tab is also where
// the operator can see what ran without one. Read from main's audit log (the
// same record written before anything spawns); refreshed when the tab opens.
// Quiet by design: history, not a call to action, so no accent colour.

interface AutoRun {
  at: number;
  kind?: string;
  ownerWorkspaceId: string;
  repoPath: string;
  titles: string[];
}

const LIMIT = 10;

export default function RecentAutoRuns() {
  const t = useT();
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
  const [runs, setRuns] = useState<AutoRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.fanout?.recentAudit?.(LIMIT * 3)
      .then((records) => {
        if (cancelled || !Array.isArray(records)) return;
        // The pre-spawn record only; the 'launched' follow-up describes the same run.
        setRuns(records.filter((r) => r.approvedBy === 'auto' && r.kind !== 'launched').slice(0, LIMIT));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (runs.length === 0) return null;
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id;

  return (
    <section className="px-3 py-2 flex flex-col gap-1" aria-label={t('fleet.approvals.recentAutoRuns')}>
      <p className="text-[11px] font-semibold text-[var(--text-muted)]">{t('fleet.approvals.recentAutoRuns')}</p>
      <ul className="flex flex-col gap-0.5">
        {runs.map((r, k) => (
          <li
            key={`${k}-${r.at}`}
            className="text-[11px] text-[var(--text-sub)] truncate"
            title={`${r.repoPath}\n${r.titles.join('\n')}`}
          >
            <span className="font-mono text-[var(--text-muted)]">{new Date(r.at).toLocaleString()}</span>{' '}
            {t('fleet.approvals.autoRunRow', {
              count: r.titles.length,
              workspace: wsName(r.ownerWorkspaceId),
              repo: r.repoPath.split(/[\\/]/).pop() ?? r.repoPath,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
