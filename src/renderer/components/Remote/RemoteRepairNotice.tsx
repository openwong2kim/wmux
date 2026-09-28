import { useT } from '../../hooks/useT';
import Button from '../ui/Button';
import { IconWarning } from '../icons';

/**
 * Notice row for a host that answered 401 — it no longer accepts this
 * computer's credential, so nothing but pairing again will bring it back.
 * Shared by the attach modal and the remote workspace view so the wording and
 * the one action are the same wherever the rejection surfaces.
 */
export default function RemoteRepairNotice({ hostLabel, onRepair, busy = false, insecure = false }: {
  hostLabel: string;
  onRepair?: () => void;
  busy?: boolean;
  /** The host needs HTTPS: its token is never sent over plain http. Pairing
   *  again here would keep the same http address, so the notice says what to
   *  do (remove it, pair over HTTPS from the Remote hub) and offers no button. */
  insecure?: boolean;
}) {
  const t = useT();
  return (
    <div className="ui-notice ui-row shrink-0" role="alert" data-remote-repair-notice>
      <span className="ui-row-icon" style={{ color: 'var(--accent-yellow)' }} aria-hidden="true">
        <IconWarning size={14} />
      </span>
      <div className="ui-row-text">
        <p className="ui-row-title">
          {insecure ? t('remote.insecureHost', { host: hostLabel }) : t('remote.authRejected', { host: hostLabel })}
        </p>
        <p className="ui-row-detail">{insecure ? t('remote.insecureHostDetail') : t('remote.authRejectedDetail')}</p>
      </div>
      {!insecure && onRepair ? (
        <div className="ui-row-action">
          <Button size="sm" variant={busy ? 'secondary' : 'primary'} disabled={busy} onClick={onRepair}>
            {t('remote.pairAgain')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
