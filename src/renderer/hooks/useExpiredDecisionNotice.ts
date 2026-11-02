// A pending decision an earlier wmux version raised has no card in this one,
// so main removes it at startup (#2943). This tells the operator once, one
// toast per removed decision, quoting its question. It asks once the panes are
// ready, so the workspace names are in the store; a decision of a workspace
// the store does not know is skipped (the orphan reconcile settles those).
import { useEffect } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';
import { truncateReason } from '../components/Layout/updateNoticePolicy';

const QUESTION_MAX_CHARS = 120;

export function useExpiredDecisionNotice(): void {
  const ready = useStore((s) => s.paneGate === 'ready');
  useEffect(() => {
    const take = window.electronAPI?.deck?.expiredDecisions;
    if (!ready || !take) return;
    // Main hands the list over once, so a response is never dropped here (a
    // StrictMode remount would lose it); pushToast after an unmount is harmless.
    void take().then(
      ({ decisions }) => {
        const { workspaces, pushToast } = useStore.getState();
        for (const d of decisions) {
          const workspace = workspaces.find((w) => w.id === d.workspaceId);
          if (!workspace) continue;
          pushToast({
            message: t('deck.expiredDecision', {
              workspace: workspace.name,
              question: truncateReason(d.question, QUESTION_MAX_CHARS),
            }),
            level: 'info',
            target: { workspaceId: d.workspaceId },
            // Shown while the app is still coming up: five seconds is easy to miss.
            durationMs: 15_000,
          });
        }
      },
      () => undefined,
    );
  }, [ready]);
}
