import { heldNeedsPerson, heldReason } from '../../stores/slices/a2aRemoteSlice';
import type { Task } from '../../../shared/types';
import UiButton from '../ui/Button';
import { timeAgo } from '../../utils/timeAgo';

// ─── Cross-PC delivery on the Remote page ────────────────────────────────────
//
// The two delivery rows of the Needs you block. Held remote work: the target
// pane is gone or another agent holds it now; it is never re-routed on its
// own — the person delivers it to the pane as it is now, or sends it back
// (the other PC is told). A PC whose certificate changed: nothing is sent to
// it until it is removed and paired again. Pure views.

type T = (key: string, vars?: Record<string, string | number>) => string;

export { heldReason };

/** The PC a held task came from or went to: the alias' first part. */
export function heldPeer(task: Task): string {
  const remoteEnd = task.metadata.from.workspaceId.startsWith('remote:') ? task.metadata.from : task.metadata.to;
  return (remoteEnd.name ?? '').split('/')[0] || '?';
}

export interface A2aHeldRowProps {
  task: Task;
  now: number;
  busy: boolean;
  onRetry: () => void;
  onReject: () => void;
  t: T;
}

export function A2aHeldRow({ task, now, busy, onRetry, onReject, t }: A2aHeldRowProps) {
  const reason = heldReason(task) ?? 'pane-missing';
  // Work for Moa is never handed to a pane; a brain-unavailable hold goes by itself once Moa can take it.
  const brain = !heldNeedsPerson(task);
  const at = Date.parse(task.status?.timestamp ?? '');
  return (
    <li className="wmux-remote-req" data-task-id={task.id} data-testid="a2a-held">
      <div className="wmux-remote-req-body">
        <span className="wmux-remote-req-title">
          <span>{t('remotePage.needs.heldTitle', { pc: heldPeer(task) })}</span>
          {Number.isFinite(at) && <span className="wmux-remote-req-when">{timeAgo(at, now)}</span>}
        </span>
        <span className="wmux-remote-req-quote">{`“${task.metadata.title}”`}</span>
        <span className="wmux-remote-req-text" data-testid="a2a-delivery-reason">{t(`a2aDelivery.reason.${reason}`)}</span>
      </div>
      <div className="wmux-remote-req-acts">
        <UiButton variant="ghost" size="md" disabled={busy} onClick={onReject} data-testid="a2a-delivery-reject">
          {t('remotePage.needs.sendBack')}
        </UiButton>
        {!brain && (
          <UiButton variant="secondary" size="md" disabled={busy} onClick={onRetry} data-testid="a2a-delivery-retry">
            {t('remotePage.needs.deliver')}
          </UiButton>
        )}
      </div>
    </li>
  );
}

export interface A2aIdentityRowProps {
  hostId: string;
  name: string;
  /** Links removing this PC would end. */
  links: number;
  confirming: boolean;
  busy: boolean;
  onPairAgain: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  t: T;
}

export function A2aIdentityRow(p: A2aIdentityRowProps) {
  const { t } = p;
  return (
    <li className="wmux-remote-req" data-host-id={p.hostId} data-testid="a2a-identity">
      <div className="wmux-remote-req-body">
        <span className="wmux-remote-req-title"><b>{p.name}</b><span>{t('remotePage.needs.identityTitle')}</span></span>
        <span className="wmux-remote-req-text">{t('a2aDelivery.identityChanged')}</span>
        {p.links > 0 && (
          <span className="wmux-remote-req-ev" data-testid="a2a-identity-links">{t('remotePage.needs.endsLinks', { count: p.links })}</span>
        )}
      </div>
      <div className="wmux-remote-req-acts">
        {p.confirming ? (
          <>
            <UiButton variant="ghost" size="md" onClick={p.onCancelRemove} autoFocus>{t('a2aLink.keep')}</UiButton>
            <UiButton variant="danger" size="md" disabled={p.busy} onClick={p.onRemove}>{t('remotePage.removeConfirm')}</UiButton>
          </>
        ) : (
          <>
            <UiButton variant="ghost" size="md" disabled={p.busy} onClick={p.onAskRemove}>{t('remotePage.remove')}</UiButton>
            <UiButton variant="secondary" size="md" onClick={p.onPairAgain} data-testid="a2a-identity-pair-again">
              {t('remotePage.needs.pairAgain')}
            </UiButton>
          </>
        )}
      </div>
    </li>
  );
}
