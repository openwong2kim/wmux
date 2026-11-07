import type { RemoteErrorReason } from '../../../shared/remoteHosts';

type Translate = (key: 'remote.newPaneNoWorkspaceGrant', params: { name: string }) => string;

/**
 * The desktop's own words for a host that refused a new pane's workspace id:
 * this computer's pairing may open what already runs on that PC but not start
 * panes there. Null for any other failure. The host's English detail is never
 * shown for this reason.
 */
export function noWorkspaceGrantMessage(t: Translate, reason: RemoteErrorReason | undefined, pcName: string): string | null {
  return reason === 'unknown-workspace-id' ? t('remote.newPaneNoWorkspaceGrant', { name: pcName }) : null;
}
