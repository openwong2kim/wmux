// Row verbs for the Fleet attention board: one ⋮ trigger per row that opens
// the shared PaneActionsMenu (same popover, same placePopover placement as the
// pane header's overflow menu), plus the inline editors the verbs open under a
// row — a single-line message composer, a label input, and a close confirm.
import { useCallback, useRef, useState } from 'react';
import type { FleetPane } from '../../stores/selectors/fleet';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import PaneActionsMenu, { type PaneActionItem } from '../Pane/PaneActionsMenu';
import { IconChevron, IconEye, IconEyeOff, IconPencil, IconTerminal, IconX } from '../icons';
import { submitBracketedPasteToPty } from '../../utils/ptyMessageDelivery';

export type FleetEditorKind = 'message' | 'label' | 'close';

export interface FleetRowVerbs {
  /** Remote rows can only be jumped to; every other verb is hidden. */
  remoteOnly: boolean;
  /** Message is shown but unavailable while a turn is running (or before the
   *  pane has a pty) — typing into a busy agent would interleave two requests. */
  messageEnabled: boolean;
  stashed: boolean;
}

export function fleetRowVerbs(pane: FleetPane): FleetRowVerbs {
  return {
    remoteOnly: !!pane.remote,
    messageEnabled: !pane.remote && !!pane.ptyId && pane.agentStatus !== 'running',
    stashed: !!pane.stashed,
  };
}

/** Stash a visible pane or bring a stashed one back. */
export function toggleFleetStash(pane: FleetPane): void {
  const s = useStore.getState();
  if (pane.stashed) s.unstashPane(pane.paneId, pane.workspaceId);
  else s.stashPane(pane.paneId, pane.workspaceId);
}

interface FleetRowMenuProps {
  pane: FleetPane;
  /** Roving slot owner — only its trigger is in the Tab order. */
  focused: boolean;
  onJump: (pane: FleetPane) => void;
  onEdit: (pane: FleetPane, kind: FleetEditorKind) => void;
}

export function FleetRowMenu({ pane, focused, onJump, onEdit }: FleetRowMenuProps) {
  const t = useT();
  const [anchor, setAnchor] = useState<{ top: number; left: number; right: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const verbs = fleetRowVerbs(pane);

  const items: PaneActionItem[] = [
    { key: 'jump', label: t('fleet.verb.jump'), shortcut: 'Enter', icon: <IconChevron size={12} />, onSelect: () => onJump(pane) },
  ];
  if (!verbs.remoteOnly) {
    items.push(
      {
        key: 'message',
        label: t('fleet.verb.message'),
        shortcut: 'M',
        icon: <IconTerminal size={12} />,
        disabled: !verbs.messageEnabled,
        title: verbs.messageEnabled ? undefined : t('fleet.verb.messageUnavailable'),
        onSelect: () => onEdit(pane, 'message'),
      },
      {
        key: 'stash',
        label: verbs.stashed ? t('pane.unstash') : t('pane.stash'),
        shortcut: 'S',
        icon: verbs.stashed ? <IconEye size={12} /> : <IconEyeOff size={12} />,
        onSelect: () => toggleFleetStash(pane),
      },
      { key: 'label', label: t('fleet.verb.label'), shortcut: 'L', icon: <IconPencil size={12} />, onSelect: () => onEdit(pane, 'label') },
      {
        key: 'close',
        label: t('fleet.verb.close'),
        shortcut: '⌫',
        icon: <IconX size={12} />,
        separatorBefore: true,
        onSelect: () => onEdit(pane, 'close'),
      },
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="wmux-fleet-row-trigger"
        tabIndex={focused ? 0 : -1}
        title={t('pane.moreActions')}
        aria-label={t('pane.moreActions')}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-fleet-row-trigger
        onClick={(e) => {
          e.stopPropagation();
          if (anchor) { close(); return; }
          setAnchor(e.currentTarget.getBoundingClientRect());
        }}
      >
        <span aria-hidden="true" className="font-mono text-[13px] leading-none">⋮</span>
      </button>
      {anchor && <PaneActionsMenu anchor={anchor} triggerRef={triggerRef} items={items} onClose={close} />}
    </>
  );
}

interface FleetRowEditorProps {
  pane: FleetPane;
  kind: FleetEditorKind;
  /** Called after a send / save / close / cancel; the row takes focus back. */
  onDone: () => void;
}

export function FleetRowEditor({ pane, kind, onDone }: FleetRowEditorProps) {
  const t = useT();
  const agentName = useStore((s) => s.surfaceAgent[pane.ptyId]?.name);
  const [value, setValue] = useState(kind === 'label' ? pane.paneLabel ?? '' : '');

  if (kind === 'close') {
    return (
      <div className="wmux-fleet-editor" role="group" aria-label={t('fleet.verb.close')} data-fleet-editor="close">
        <span className="wmux-fleet-editor-text">{t('fleet.close.confirm')}</span>
        {/* Cancel is first and focused, so Enter on arrival cancels. */}
        <button type="button" autoFocus data-fleet-close-cancel onClick={onDone}>
          {t('fleet.close.cancel')}
        </button>
        <button type="button" className="is-destructive" data-fleet-close-confirm
          onClick={() => { useStore.getState().closePane(pane.paneId, pane.workspaceId); onDone(); }}>
          {t('fleet.verb.close')}
        </button>
      </div>
    );
  }

  const submit = () => {
    if (kind === 'message') {
      const text = value.trim();
      if (!text) return;
      submitBracketedPasteToPty(pane.ptyId, text, { agent: agentName ?? pane.agentName });
    } else {
      void window.electronAPI.metadata.setLabel(pane.paneId, pane.workspaceId, value.trim());
    }
    onDone();
  };

  return (
    <div className="wmux-fleet-editor" data-fleet-editor={kind}>
      <input
        type="text"
        autoFocus
        value={value}
        placeholder={kind === 'message' ? t('fleet.message.placeholder') : t('fleet.label.placeholder')}
        aria-label={kind === 'message' ? t('fleet.verb.message') : t('fleet.verb.label')}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Escape is handled by FleetView's capture handler (cancels the editor).
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
        }}
      />
    </div>
  );
}
