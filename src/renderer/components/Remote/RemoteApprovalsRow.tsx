import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import { IconElbow } from '../icons';
import { APPROVAL_LEVELS, type ApprovalLevel } from './remoteApprovals';

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface RemoteApprovalsRowProps {
  hostId: string;
  /** That PC's name here. */
  name: string;
  level: ApprovalLevel;
  /** A raise of this PC waiting for its confirmation. */
  pending: ApprovalLevel | null;
  busy: boolean;
  /** The approvals settings file was damaged: off for every PC until one is set. */
  damaged: boolean;
  error: string | null;
  onChange: (level: ApprovalLevel) => void;
  onConfirm: () => void;
  onCancel: () => void;
  t: T;
}

/**
 * One nested row under a paired PC on the Remote page: "Agents on <PC> can
 * allow or deny permission prompts in tasks they sent here", with Off / Tool
 * only / Command. A raise waiting for its confirmation shows Cancel and
 * Confirm (secondary) in place of the control and says under the row what it
 * allows. Pure (props only), so it renders in a node test.
 */
export default function RemoteApprovalsRow(props: RemoteApprovalsRowProps) {
  const { hostId, name, level, pending, busy, damaged, error, onChange, onConfirm, onCancel, t } = props;
  const label = t('remotePage.approvals.row', { pc: name });
  return (
    <li className="wmux-remote-link" data-remote-approvals={hostId} data-level={level}>
      <span className="wmux-remote-link-ln" aria-hidden="true"><IconElbow size={16} /></span>
      <span className="wmux-remote-link-what" title={label}>{label}</span>
      <span className="wmux-remote-acts">
        {pending ? (
          <>
            <Button size="sm" variant="ghost" onClick={onCancel} autoFocus data-remote-approvals-cancel={hostId}>{t('remotePage.cancel')}</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={onConfirm} data-remote-approvals-confirm={hostId}>
              {t('remotePage.approvals.confirm')}
            </Button>
          </>
        ) : (
          <SegmentedControl
            value={level}
            options={APPROVAL_LEVELS.map((value) => ({ value, label: t(`remotePage.approvals.level.${value}`), disabled: busy }))}
            onValueChange={onChange}
            ariaLabel={label}
            data-testid={`remote-approvals-level-${hostId}`}
          />
        )}
      </span>
      {pending && (
        <p className="wmux-remote-row-note" role="status" data-remote-approvals-ask={pending}>
          {t(pending === 'command' ? 'remotePage.approvals.askCommand' : 'remotePage.approvals.askToolOnly', { pc: name })}
        </p>
      )}
      {!pending && damaged && <p className="wmux-remote-row-note" data-remote-approvals-damaged>{t('remotePage.approvals.damaged')}</p>}
      {error && <p className="wmux-remote-row-error" role="alert">{error}</p>}
    </li>
  );
}
