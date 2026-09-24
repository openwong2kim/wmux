import { useT } from '../../hooks/useT';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';

/**
 * First-boot consent for automatic update checks. A question that must be
 * answered, so it has no Escape, backdrop or close button — it stays until one
 * of the two buttons is pressed (AppLayout sequences it after the welcome
 * dialog). Sits at --z-modal, under the welcome dialog's --z-dialog.
 */
export default function AutoUpdatePrompt({ onChoose }: { onChoose: (enabled: boolean) => void }) {
  const t = useT();
  return (
    <Dialog
      onClose={() => onChoose(false)}
      closeOnEscape={false}
      width={400}
      zIndexClassName="z-[var(--z-modal)]"
      data-testid="auto-update-prompt"
    >
      <DialogHeader title={t('firstRun.autoUpdateTitle')} description={t('firstRun.autoUpdateMessage')} />
      <DialogFooter className="pt-5">
        <Button size="md" variant="secondary" onClick={() => onChoose(false)}>
          {t('firstRun.disable')}
        </Button>
        <Button size="md" variant="primary" onClick={() => onChoose(true)}>
          {t('firstRun.enable')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
