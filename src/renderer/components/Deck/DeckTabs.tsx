// ─── Command Deck — dock tab bar (Phase 1 P1a) ───────────────────────────────
//
// Tab header at the top of the right dock: [Orchestrator] [Channels].
// `commander` (Orchestrator) is the default (the LLM-less command composer);
// Channels holds the classic list + conversation and is hideable via Settings,
// so the visible set is 1–2 tabs. Git·Review moved to center pane surface tabs per design A (2026-07-20).
// Warm rounded count badge: Channels = unread. Pure +
// props-driven so the tab-switch behavior is unit-testable under jsdom without
// the store-connected dock body.

import { useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { DeckTab } from '../../stores/slices/deckSlice';

export interface DeckTabsProps {
  active: DeckTab;
  onSelect: (tab: DeckTab) => void;
  /** Unread total across all channels — a small badge on the Channels tab so
   *  switching away from it doesn't hide new activity. Omit / 0 → no badge. */
  channelsUnread?: number;
  /** Whether the Channels tab renders at all. Default true (pure component —
   *  the store default is FALSE; the dock passes the setting through). With
   *  it hidden the strip shows the single Orchestrator tab, doubling as the
   *  deck's header. */
  showChannels?: boolean;
  /** Right-aligned header controls (model chip + collapse button). Rendered
   *  after the tabs, pinned to the trailing edge — the deck's one header row,
   *  so orchestrator settings live next to its name instead of buried in
   *  Settings. Omit → the strip is tabs-only (unchanged). */
  rightSlot?: React.ReactNode;
  /** Current model label inline on Orchestrator(=Agent) tab (e.g. 'Sonnet 5',
   *  default 'Default'). When set tab label renders as `Agent (Sonnet 5)`. Model
   *  selection moved here from control bar model chip. */
  commanderModelLabel?: string;
  /** Model dropdown options (reuse OrchestratorModelChip.MODEL_OPTIONS). ChannelDock
   *  injects from store; DeckTabs stays pure component. */
  commanderModelOptions?: { value: string; label: string }[];
  /** Currently selected model value (option value; '' = Default). For display. */
  commanderModelValue?: string;
  /** Model select callback. When set, re-click active Agent tab opens dropdown. */
  onCommanderModelSelect?: (value: string) => void;
  /** Translator — defaults to identity so tests can omit it. */
  t?: (key: string) => string;
}

// Warm rounded count badge (Channels unread) — a solid warm fill is reserved for
// tiny count badges (DESIGN.md two-accent grammar). Tabular figures + full-round
// per the geometry rules.
const WARM_BADGE =
  'inline-flex items-center justify-center shrink-0 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-semibold tabular-nums leading-none bg-[var(--accent)] text-[var(--bg-base)]';

const TABS: { id: DeckTab; labelKey: string; fallback: string }[] = [
  { id: 'commander', labelKey: 'deck.tabCommander', fallback: 'Orchestrator' },
  { id: 'git', labelKey: 'deck.tabGit', fallback: 'Git' },
  { id: 'channels', labelKey: 'deck.tabChannels', fallback: 'Channels' },
];

export function DeckTabs({
  active,
  onSelect,
  channelsUnread = 0,
  showChannels = true,
  rightSlot,
  commanderModelLabel,
  commanderModelOptions,
  commanderModelValue = '',
  onCommanderModelSelect,
  t: tProp,
}: DeckTabsProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const tabs = TABS.filter((tab) => tab.id !== 'channels' || showChannels);

  // Inline model dropdown state on Agent(commander) tab. Opens on re-click only when tab active;
  // closes on outside click·Esc (role="menu" a11y). Dropdown is sibling of tab button inside
  // relative wrapper (absolute positioned) to avoid nested buttons.
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const canModelMenu = !!onCommanderModelSelect && !!commanderModelOptions?.length;
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setModelMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelMenuOpen]);
  // Close open dropdown when tab no longer active (or menu disabled).
  useEffect(() => {
    if (active !== 'commander' || !canModelMenu) setModelMenuOpen(false);
  }, [active, canModelMenu]);

  return (
    <div
      data-deck-tabs
      role="tablist"
      aria-label={t('deck.tabsAriaLabel') || 'Command deck tabs'}
      className="flex items-stretch shrink-0 border-b border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        const isCommander = tab.id === 'commander';
        // Only Agent tab has inline model dropdown (toggle on re-click when active).
        const tabHasModelMenu = isCommander && canModelMenu;
        const baseLabel = t(tab.labelKey) || tab.fallback;
        // Append current model in parentheses to Agent tab label → `Agent (Sonnet 5)`.
        const label = isCommander && commanderModelLabel ? `${baseLabel} (${commanderModelLabel})` : baseLabel;
        const button = (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-deck-tab={tab.id}
            data-active={isActive ? 'true' : undefined}
            {...(tabHasModelMenu ? { 'aria-haspopup': 'menu', 'aria-expanded': modelMenuOpen } : {})}
            onClick={() => {
              // inactive → select tab (existing). active Agent tab re-click → toggle model menu.
              if (tabHasModelMenu && isActive) setModelMenuOpen((v) => !v);
              else onSelect(tab.id);
            }}
            className={`relative min-w-0 flex items-center justify-center gap-1 px-3 py-2 text-[12.5px] font-semibold transition-colors duration-150 ${FOCUS_RING} ${
              isActive
                ? 'text-[var(--text-main)] bg-[rgba(var(--bg-surface-rgb),0.5)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-sub)]'
            }`}
            {...(isActive ? tokenAttrs('textMain', 'text') : tokenAttrs('textMuted', 'text'))}
          >
            <span className="truncate">{label}</span>
            {tabHasModelMenu && (
              <span aria-hidden="true" className="text-[9px] opacity-70">▾</span>
            )}
            {tab.id === 'channels' && channelsUnread > 0 && (
              <span data-deck-tab-unread className={WARM_BADGE} {...tokenAttrs('accent', 'bg')}>
                {channelsUnread > 99 ? '99+' : channelsUnread}
              </span>
            )}
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)]"
                {...tokenAttrs('accentSecondary', 'bg')}
              />
            )}
          </button>
        );
        if (!tabHasModelMenu) return button;
        return (
          <div key={tab.id} ref={modelMenuRef} className="relative flex">
            {button}
            {modelMenuOpen && isActive && (
              <div
                role="menu"
                aria-label={t('deck.orchestratorModel') || 'Orchestrator model'}
                data-commander-model-menu
                className="absolute left-1 top-full mt-1 z-50 min-w-[128px] rounded-md border py-1 shadow-lg bg-[var(--bg-surface)]"
                style={{ borderColor: 'var(--border-soft)' }}
                {...tokenAttrs('bgSurface', 'bg')}
              >
                {(commanderModelOptions ?? []).map((o) => {
                  const sel = o.value === commanderModelValue;
                  return (
                    <button
                      key={o.value || 'default'}
                      type="button"
                      role="menuitemradio"
                      aria-checked={sel}
                      data-commander-model-option
                      data-value={o.value}
                      onClick={() => {
                        onCommanderModelSelect?.(o.value);
                        setModelMenuOpen(false);
                      }}
                      className={`flex items-center justify-between w-full px-2.5 py-1 text-left text-[11.5px] font-medium transition-colors ${
                        sel
                          ? 'text-[var(--text-main)] font-semibold'
                          : 'text-[var(--text-sub)] hover:text-[var(--text-main)]'
                      }`}
                    >
                      <span>{o.label}</span>
                      {sel && (
                        <span aria-hidden="true" className="text-[var(--accent-blue)] text-[8px]" {...tokenAttrs('accent', 'text')}>
                          ●
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {rightSlot && (
        <div data-deck-header-controls className="flex items-center ml-auto shrink-0 pr-1.5 gap-0.5">
          {rightSlot}
        </div>
      )}
    </div>
  );
}

export default DeckTabs;
