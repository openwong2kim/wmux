import { t } from '../../i18n';
import Button from '../ui/Button';
import { IconCheck, IconRefresh, IconWarning } from '../icons';
import { dismissPaneLinkNotice, type PaneLinkNotice } from '../../daemon/daemonLinkNotice';

/**
 * The pane's daemon link notice, as a notice row (DESIGN.md, Dialogs & forms):
 * icon · title + one-line description · vertical hairline · Dismiss. Neutral
 * while reconnecting and once reconnected; the warning tone (text and
 * hairline only, never a fill) when input may not have reached the shell; the
 * danger tone once wmux gave up. A narrow pane wraps Dismiss onto its own row
 * rather than squeezing the text into a column that breaks words
 * (`.wmux-link-notice` in styles/ui.css).
 */
export default function DaemonLinkNotice({ notice, surfaceId }: { notice: PaneLinkNotice; surfaceId: string }) {
  const tone = notice.state === 'gave-up' ? 'danger' : notice.inputLost ? 'warning' : 'neutral';
  const title = notice.state === 'reconnecting'
    ? (notice.attempt > 0 ? t('daemon.linkReconnectingAttempt', { attempt: notice.attempt }) : t('daemon.linkReconnecting'))
    : notice.state === 'reconnected' ? t('daemon.linkReconnected') : t('daemon.linkGaveUp');
  const lost = notice.inputLost
    ? (notice.state === 'reconnected' ? t('daemon.linkInputLost') : t('daemon.linkInputLostWhileDown'))
    : null;
  return (
    <div className="ui-surface wmux-link-notice absolute inset-x-2 top-2 z-20 max-h-[calc(100%-1rem)] overflow-y-auto rounded-[12px] bg-[var(--bg-base)]">
      <div className="ui-notice ui-row" data-tone={tone}
        role={notice.state === 'reconnecting' ? 'status' : 'alert'} aria-live={notice.state === 'reconnecting' ? 'polite' : undefined}>
        <span className="ui-row-icon ui-notice-tone" aria-hidden="true">
          {notice.state === 'gave-up' || notice.inputLost ? <IconWarning size={14} />
            : notice.state === 'reconnecting' ? <IconRefresh size={14} /> : <IconCheck size={14} />}
        </span>
        <div className="ui-row-text">
          <p className={`ui-row-title${notice.state === 'gave-up' ? ' ui-notice-tone' : ''}`}>{title}</p>
          {notice.state === 'gave-up' && <p className="ui-row-detail">{t('daemon.linkGaveUpHint')}</p>}
          {lost && <p className="ui-row-detail ui-notice-tone">{lost}</p>}
        </div>
        {notice.state !== 'reconnecting' && (
          <div className="ui-row-action">
            <Button size="sm" variant="secondary" onClick={() => dismissPaneLinkNotice(surfaceId)}>
              {t('daemon.linkDismiss')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
