// Moa panel options: one ⋯ button at the end of the header row, plus the
// current mode as a quiet label beside "Main bot". It replaces the control
// rows that sat under the header and above the composer (Mode, Loop,
// Schedules, New session, Wake, View as terminal, Automation): every action
// is here, with the same presence rules, disabled states and confirmations.
//
// Portalled into the header slot DeckTabs registers (deckHeaderSlot.ts), since
// the state it acts on lives in CommanderView. Without a slot it renders
// nothing.
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import PaneActionsMenu, { type PaneActionItem } from '../Pane/PaneActionsMenu';
import Dialog, { DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import { FOCUS_RING } from '../focusRing';
import { claudeModelLabel } from '../../../shared/claudeModels';
import { MODEL_OPTIONS } from './OrchestratorModelChip';
import { MODE_ORDER, modeDesc, modeLabel, useAgentMode, type AgentModeApi } from './AgentModeChip';
import { startNewSession, type NewSessionApi } from './NewSessionChip';
import { useDeckHeaderSlot } from './deckHeaderSlot';

type Rect = { top: number; left: number; right: number; bottom: number };

export interface MoaHeaderMenuProps {
  t: (key: string) => string;
  /** Moa's chat workspace (the HQ). */
  workspaceId?: string;
  brainBusy: boolean;
  /** The terminal brain is up: Wake exists only then (as before). */
  brainPtyId: string | null;
  /** Chat and terminal are both available: the view switch exists only then. */
  chatAvailable: boolean;
  view: 'chat' | 'terminal';
  onViewChange: (view: 'chat' | 'terminal') => void;
  onOpenLoop: () => void;
  onOpenSchedules: () => void;
  /** Injected in tests; default to the preload. */
  modeApi?: AgentModeApi;
  sessionApi?: NewSessionApi;
  wake?: (workspaceId: string) => Promise<unknown>;
  hasLoop?: boolean;
  hasSchedules?: boolean;
}

export function MoaHeaderMenu({
  t,
  workspaceId,
  brainBusy,
  brainPtyId,
  chatAvailable,
  view,
  onViewChange,
  onOpenLoop,
  onOpenSchedules,
  modeApi,
  sessionApi,
  wake,
  hasLoop,
  hasSchedules,
}: MoaHeaderMenuProps): React.ReactElement | null {
  const slot = useDeckHeaderSlot();
  const deck = window.electronAPI?.deck;
  const modeBridge = modeApi ?? (deck as unknown as { mode?: AgentModeApi } | undefined)?.mode;
  const wakeFn = wake ?? deck?.wake;
  // An older preload may lack either call (as NewSessionChipContainer checks).
  const sessionBridge: NewSessionApi | undefined =
    sessionApi ?? (deck && typeof deck.conversation?.clear === 'function' && typeof deck.wake === 'function'
      ? { clear: (id) => deck.conversation.clear(id), wake: (id) => deck.wake(id) }
      : undefined);
  const loopAvailable = hasLoop ?? !!(deck as unknown as { loop?: unknown } | undefined)?.loop;
  const schedulesAvailable = hasSchedules ?? !!(deck as unknown as { schedules?: unknown } | undefined)?.schedules;

  const { mode, pick } = useAgentMode(modeBridge, workspaceId);
  const model = useStore((s) => s.deckBrainModel);
  const setModel = useStore((s) => s.setDeckBrainModel);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<null | 'main' | 'model' | 'mode'>(null);
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [running, setRunning] = useState(false);

  // An item that opens a submenu sets it in onSelect; the menu's own close
  // runs right after and must not undo that.
  const closeMenu = useCallback(() => setMenu((m) => (m === 'main' ? null : m)), []);
  const closeSub = useCallback(() => setMenu(null), []);

  if (!slot) return null;

  const modelLabel = model === '' ? t('deck.orchestratorModelDefault') : claudeModelLabel(model);
  const newSessionTitle =
    t('deck.newSessionTooltip') ||
    'Replace this workspace’s orchestrator with a fresh session. The brain forgets the conversation so far — the #commander transcript stays as the record. Panes, worktrees, loops and schedules are untouched.';
  const confirmLabel = brainBusy
    ? t('deck.newSessionConfirmBusy') || 'Interrupt & start new session?'
    : t('deck.newSessionConfirm') || 'Start a new session?';

  const mainItems: PaneActionItem[] = [
    {
      key: 'model',
      label: `${t('moa.panel.menu.model') || 'Model'}: ${modelLabel}`,
      onSelect: () => setMenu('model'),
    },
    ...(mode !== null
      ? [{
          key: 'mode',
          label: `${t('deck.mode.label') || 'Mode'}: ${modeLabel(t, mode)}`,
          title: modeDesc(t, mode),
          onSelect: () => setMenu('mode'),
        }]
      : []),
    ...(workspaceId && sessionBridge
      ? [{
          key: 'new-session',
          label: t('deck.newSession') || 'New session',
          // Deliberately not disabled mid-turn: a stuck turn is the main
          // reason to want a fresh brain. Only a clear in flight disables it.
          disabled: running,
          title: newSessionTitle,
          separatorBefore: true,
          onSelect: () => setConfirmNew(true),
        }]
      : []),
    ...(workspaceId && brainPtyId && wakeFn
      ? [{
          key: 'wake',
          label: t('deck.wakeNow') || 'Wake',
          disabled: brainBusy,
          title: brainBusy ? t('moa.panel.busy') : undefined,
          separatorBefore: !(workspaceId && sessionBridge),
          onSelect: () => {
            void wakeFn(workspaceId).catch(() => {
              /* best-effort — a rejected wake just means the brain is busy */
            });
          },
        }]
      : []),
    ...(chatAvailable
      ? [{
          key: 'view',
          label: view === 'terminal' ? t('moa.panel.viewAsChat') : t('moa.panel.viewAsTerminal'),
          onSelect: () => onViewChange(view === 'terminal' ? 'chat' : 'terminal'),
        }]
      : []),
    ...(workspaceId && loopAvailable
      ? [{ key: 'loop', label: t('moa.panel.menu.loop') || 'Loop…', separatorBefore: true, onSelect: onOpenLoop }]
      : []),
    ...(workspaceId && schedulesAvailable
      ? [{
          key: 'schedules',
          label: t('moa.panel.menu.schedules') || 'Schedules…',
          separatorBefore: !(workspaceId && loopAvailable),
          onSelect: onOpenSchedules,
        }]
      : []),
    {
      key: 'settings',
      label: t('moa.panel.menu.settings') || 'Moa settings…',
      separatorBefore: true,
      onSelect: () => useStore.getState().openSettingsTab('moa'),
    },
  ];

  const modelItems: PaneActionItem[] = MODEL_OPTIONS.map((o) => ({
    key: `model:${o.value || 'default'}`,
    label: o.value === '' ? t('deck.orchestratorModelDefault') : o.label,
    active: o.value === model,
    onSelect: () => setModel(o.value),
  }));
  const modeItems: PaneActionItem[] = MODE_ORDER.map((m) => ({
    key: `mode:${m}`,
    label: modeLabel(t, m),
    title: modeDesc(t, m),
    active: m === mode,
    onSelect: () => pick(m),
  }));

  const open = () => {
    const el = buttonRef.current;
    if (!el) return;
    // Focus first, so every close path hands focus back to this button.
    el.focus();
    const r = el.getBoundingClientRect();
    setAnchor({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });
    setMenu((m) => (m ? null : 'main'));
  };

  // The confirm opened from a menu item that is gone: hand focus back to ⋯.
  const closeConfirm = () => {
    setConfirmNew(false);
    buttonRef.current?.focus();
  };
  const runNewSession = () => {
    closeConfirm();
    if (!workspaceId || !sessionBridge || running) return;
    setRunning(true);
    void startNewSession(sessionBridge, workspaceId).finally(() => setRunning(false));
  };

  return createPortal(
    <>
      {mode !== null && (
        <span
          data-moa-mode-chip={mode}
          title={modeDesc(t, mode)}
          className={`text-[11px] leading-none ${mode === 'danger' ? 'text-[var(--accent-red)]' : 'text-[var(--text-sub)]'}`}
        >
          {modeLabel(t, mode)}
        </span>
      )}
      <button
        ref={buttonRef}
        type="button"
        data-moa-header-more
        aria-label={t('moa.panel.options') || 'Moa options'}
        title={t('moa.panel.options') || 'Moa options'}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={open}
        className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--text-sub)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-main)] transition-colors ${FOCUS_RING}`}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
          <circle cx="3.5" cy="8" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="12.5" cy="8" r="1.25" />
        </svg>
      </button>
      {menu && (
        <PaneActionsMenu
          key={menu}
          anchor={anchor}
          triggerRef={buttonRef}
          items={menu === 'model' ? modelItems : menu === 'mode' ? modeItems : mainItems}
          onClose={menu === 'main' ? closeMenu : closeSub}
        />
      )}
      {/* To the body: the header row would clip a fixed overlay. */}
      {confirmNew && createPortal(
        <Dialog onClose={closeConfirm} width={360} closeOnBackdrop data-testid="moa-new-session-confirm">
          <DialogHeader title={confirmLabel} description={newSessionTitle} />
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={closeConfirm} data-moa-new-session-cancel>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button variant="danger" size="sm" onClick={runNewSession} data-moa-new-session-confirm>
              {t('deck.newSession') || 'New session'}
            </Button>
          </DialogFooter>
        </Dialog>,
        document.body,
      )}
    </>,
    slot,
  );
}

export default MoaHeaderMenu;
