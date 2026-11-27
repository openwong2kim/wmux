import { useStore } from '../stores';
import { t } from '../i18n';

// Sessions already told their folder is gone: a create's bind and a later
// reconnect of the same session say it once between them.
const missingCwdTold = new Set<string>();

/**
 * #3443 — tell the user once per session that its folder no longer exists
 * and the pane opened in home. A no-op without a folder.
 */
export function noticeMissingCwd(ptyId: string, folder: string | undefined): void {
  if (!folder || missingCwdTold.has(ptyId)) return;
  missingCwdTold.add(ptyId);
  console.warn(`[Terminal] ${ptyId}: folder ${folder} no longer exists; opened in home`);
  useStore.getState().pushToast({ level: 'warn', message: t('terminal.cwdMissingHome', { folder }) });
}
