// A pending decision an earlier wmux version raised has no card in this one,
// so main expires it at startup (#2943). This tells the operator once, one
// toast per expired decision, quoting its question.
import { useEffect } from 'react';
import { useStore } from '../stores';
import { t } from '../i18n';
import { truncateReason } from '../components/Layout/updateNoticePolicy';

const QUESTION_MAX_CHARS = 120;

export function useExpiredDecisionNotice(): void {
  useEffect(() => {
    const read = window.electronAPI?.deck?.expiredDecisions;
    if (!read) return;
    let alive = true;
    void read().then(
      ({ decisions }) => {
        if (!alive) return;
        for (const d of decisions) {
          const question = truncateReason(d.question, QUESTION_MAX_CHARS);
          useStore.getState().pushToast({
            message: d.workspaceName
              ? t('deck.expiredDecision', { workspace: d.workspaceName, question })
              : t('deck.expiredDecisionNoWorkspace', { question }),
            level: 'info',
            target: { workspaceId: d.workspaceId },
            // Shown while the app is still coming up: five seconds is easy to miss.
            durationMs: 15_000,
          });
        }
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
}
