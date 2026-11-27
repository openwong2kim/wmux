import { useSyncExternalStore } from 'react';
import { useT } from '../../hooks/useT';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import { getPendingScratchDrop, resolveScratchDrop, subscribeScratchDrop } from './dirtyEditors';

/** Asks before a pane or workspace close drops an editor's unsaved scratch
 *  text. Keep editing holds the initial focus, so Enter loses nothing. */
export default function ScratchDropConfirm() {
  const t = useT();
  const pending = useSyncExternalStore(subscribeScratchDrop, getPendingScratchDrop);
  if (!pending) return null;
  return (
    <Dialog onClose={() => resolveScratchDrop(false)} width={360} closeOnBackdrop data-testid="scratch-drop-confirm">
      <DialogHeader title={t('editor.closeDiscardTitle')} description={t('editor.closeDiscardBody')} />
      <DialogFooter>
        <Button variant="secondary" size="sm" onClick={() => resolveScratchDrop(false)} data-scratch-keep>
          {t('editor.keepEditing')}
        </Button>
        <Button variant="danger" size="sm" onClick={() => resolveScratchDrop(true)} data-scratch-discard>
          {t('editor.discardAndClose')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
