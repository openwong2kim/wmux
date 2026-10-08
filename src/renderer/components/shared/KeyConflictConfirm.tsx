import { useRef } from 'react';
import { useT } from '../../hooks/useT';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import type { KeyConflict } from '../../utils/shortcutRebind';

/**
 * "This key is already taken by a custom keybinding" (#1885), asked before a
 * shortcut is saved from Settings → Keyboard or the command palette. The
 * owner's call is warn, then allow: Use anyway saves as before, Cancel keeps
 * the old key. Cancel holds the initial focus, so Enter keeps things as they
 * were; Escape cancels too.
 */
export default function KeyConflictConfirm({ conflict, onConfirm, onCancel }: {
  conflict: KeyConflict;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const vars = { combo: conflict.combo, name: conflict.name };
  return (
    <Dialog
      onClose={onCancel}
      width={400}
      initialFocusRef={cancelRef}
      closeOnBackdrop
      role="alertdialog"
      data-testid="key-conflict-confirm"
    >
      <DialogHeader
        title={t('settings.sc.keyInUseTitle', vars)}
        description={conflict.kind === 'shadowsCustom'
          ? t('settings.sc.customKeyShadowed', vars)
          : t('settings.kb.builtinWins', vars)}
      />
      <DialogFooter>
        <Button ref={cancelRef} variant="secondary" size="sm" onClick={onCancel} data-key-conflict-cancel>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm} data-key-conflict-confirm>
          {t('settings.sc.useAnyway')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
