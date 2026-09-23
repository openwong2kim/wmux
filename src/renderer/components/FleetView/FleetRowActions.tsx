// Row verbs for the Fleet attention board: one ⋮ trigger per row that opens
// the shared PaneActionsMenu (same popover, same placePopover placement as the
// pane header's overflow menu), plus the inline editors the verbs open under a
// row — a single-line message composer, a label input, and a close confirm.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fleetTargetPtyId,
  selectFleetPanes,
  selectHookRunningByPtyId,
  type FleetPane,
} from '../../stores/selectors/fleet';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import PaneActionsMenu, { type PaneActionItem } from '../Pane/PaneActionsMenu';
import { IconChevron, IconEye, IconEyeOff, IconPencil, IconTerminal, IconX } from '../icons';
import { submitBracketedPasteToPty } from '../../utils/ptyMessageDelivery';
import { disposePanePtys } from '../../utils/paneTeardown';
import { findParent, findPane } from '../../../shared/paneUtils';
import { findStashedEntry } from '../../../shared/paneStash';
import type { TranslationKey } from '../../i18n/locales/en';

export type FleetEditorKind = 'message' | 'label' | 'close';

export interface FleetRowVerbs {
  /** Remote rows can only be jumped to; every other verb is hidden. */
  remoteOnly: boolean;
  /** Message is shown but unavailable while a turn is running (or before the
   *  pane has a pty) — typing into a busy agent would interleave two requests —
   *  and on a permission prompt, where the trailing Enter would pick the
   *  highlighted option. */
  messageEnabled: boolean;
  messageReason?: TranslationKey;
  stashed: boolean;
  /** Closing the only pane of a workspace is a no-op in closePane; the verb is
   *  disabled there and the workspace close is the way out. */
  closeEnabled: boolean;
  closeReason?: TranslationKey;
}

/** Live signals the verbs depend on, read by the caller from the store. */
export interface FleetRowVerbContext {
  pendingQuestion?: string;
  /** Hook turn latch / fresh hook activity (selectHookRunningByPtyId). */
  hookRunning?: boolean;
  /** OSC 133: a foreground command owns the pty. */
  commandRunning?: boolean;
  /** An agent is identified on the pty (surfaceAgent). An agent TUI is itself
   *  the foreground command for its whole life, so `commandRunning` says
   *  nothing about its turn; it only gates plain shell panes. */
  hasAgent?: boolean;
  /** The pane is its workspace's root (single-pane workspace). */
  isRootPane?: boolean;
}

export function fleetRowVerbs(pane: FleetPane, ctx: FleetRowVerbContext = {}): FleetRowVerbs {
  const permissionPrompt = pane.agentStatus === 'awaiting_input' && !ctx.pendingQuestion?.trim();
  const busy = pane.agentStatus === 'running' || !!ctx.hookRunning || (!!ctx.commandRunning && !ctx.hasAgent);
  const messageEnabled = !pane.remote && !!fleetTargetPtyId(pane) && !busy && !permissionPrompt;
  const closeEnabled = !pane.remote && !(ctx.isRootPane && !pane.stashed);
  return {
    remoteOnly: !!pane.remote,
    messageEnabled,
    ...(messageEnabled ? {} : {
      messageReason: permissionPrompt ? 'fleet.verb.messagePermission' as const : 'fleet.verb.messageUnavailable' as const,
    }),
    stashed: !!pane.stashed,
    closeEnabled,
    ...(closeEnabled ? {} : { closeReason: 'fleet.verb.closeRoot' as const }),
  };
}

type VerbStoreState = ReturnType<typeof useStore.getState>;

/** `fleetRowVerbs` with its context read from a store snapshot, keyed on the
 *  row's target pty (the background tab that needs you, else the active one). */
export function fleetRowVerbsFromState(pane: FleetPane, state: VerbStoreState): FleetRowVerbs {
  const target = fleetTargetPtyId(pane);
  const ws = state.workspaces.find((w) => w.id === pane.workspaceId);
  return fleetRowVerbs(pane, {
    pendingQuestion: state.surfacePendingQuestion[target],
    hookRunning: !!selectHookRunningByPtyId(state)[target],
    commandRunning: state.commandRunningByPtyId[target] === true,
    hasAgent: !!state.surfaceAgent[target]?.name,
    isRootPane: !!ws && ws.rootPane.id === pane.paneId && findParent(ws.rootPane, pane.paneId) === null,
  });
}

/** Close a pane from Fleet the way every other close path does: dispose its
 *  ptys and remote sessions first (a visible pane via the layout tree, a
 *  stashed one via its stash entry), then remove it. */
export function closeFleetPane(pane: FleetPane): void {
  const s = useStore.getState();
  const ws = s.workspaces.find((w) => w.id === pane.workspaceId);
  const subtree = ws
    ? findPane(ws.rootPane, pane.paneId) ?? findStashedEntry(ws.stashedPanes, pane.paneId)?.pane
    : undefined;
  if (subtree) disposePanePtys(subtree);
  s.closePane(pane.paneId, pane.workspaceId);
}

/** Stash a visible pane or bring a stashed one back. */
export function toggleFleetStash(pane: FleetPane): void {
  const s = useStore.getState();
  if (pane.stashed) s.unstashPane(pane.paneId, pane.workspaceId);
  else s.stashPane(pane.paneId, pane.workspaceId);
}

interface FleetRowMenuProps {
  pane: FleetPane;
  verbs: FleetRowVerbs;
  /** Told the menu's close function while it is open (null once closed), so
   *  FleetView's Escape handler can close the menu instead of the overlay. */
  onMenuOpenChange?: (close: (() => void) | null) => void;
  /** Roving slot owner — only its trigger is in the Tab order. */
  focused: boolean;
  onJump: (pane: FleetPane) => void;
  onEdit: (pane: FleetPane, kind: FleetEditorKind) => void;
}

export function FleetRowMenu({ pane, verbs, focused, onJump, onEdit, onMenuOpenChange }: FleetRowMenuProps) {
  const t = useT();
  const [anchor, setAnchor] = useState<{ top: number; left: number; right: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setAnchor(null);
    onMenuOpenChange?.(null);
  }, [onMenuOpenChange]);
  // A row that unmounts with its menu open must not leave FleetView holding
  // a dead close function (Escape would then do nothing once).
  const openRef = useRef(false);
  openRef.current = anchor !== null;
  useEffect(() => () => { if (openRef.current) onMenuOpenChange?.(null); }, [onMenuOpenChange]);

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
        title: verbs.messageReason ? t(verbs.messageReason) : undefined,
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
        disabled: !verbs.closeEnabled,
        title: verbs.closeReason ? t(verbs.closeReason) : undefined,
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
          onMenuOpenChange?.(close);
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
  const target = fleetTargetPtyId(pane);
  const agentName = useStore((s) => s.surfaceAgent[target]?.name);
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
          onClick={() => { closeFleetPane(pane); onDone(); }}>
          {t('fleet.verb.close')}
        </button>
      </div>
    );
  }

  const submit = () => {
    if (kind === 'message') {
      const text = value.trim();
      if (!text) return;
      // The composer can stay open while the pane changes state: re-check
      // against the store as it is now, not as it was when the editor opened.
      const s = useStore.getState();
      const fresh = selectFleetPanes({ ...s, hookRunningByPtyId: selectHookRunningByPtyId(s) })
        .find((p) => p.paneId === pane.paneId && p.workspaceId === pane.workspaceId);
      if (!fresh || !fleetRowVerbsFromState(fresh, s).messageEnabled) {
        s.pushToast({ level: 'warn', message: t('fleet.message.refused') });
        return;
      }
      submitBracketedPasteToPty(fleetTargetPtyId(fresh), text, { agent: agentName ?? pane.agentName });
    } else {
      window.electronAPI.metadata.setLabel(pane.paneId, pane.workspaceId, value.trim()).catch((err: unknown) => {
        console.error('[fleet] setLabel failed', err);
        useStore.getState().pushToast({ level: 'error', message: t('fleet.label.failed') });
      });
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
