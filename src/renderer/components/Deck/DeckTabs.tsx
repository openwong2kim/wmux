// ─── Command Deck — dock tab bar (Phase 1 P1a) ───────────────────────────────
//
// Tab header at the top of the right dock: [Orchestrator] [Channels].
// `commander` (Orchestrator) is the default (the LLM-less command composer);
// Channels holds the classic list + conversation and is hideable via Settings,
// so the visible set is 1–2 tabs. Git·Review는 시안 A(2026-07-20)로 중앙 페인
// surface 탭으로 이관됐다. Warm rounded count badge: Channels = unread. Pure +
// props-driven so the tab-switch behavior is unit-testable under jsdom without
// the store-connected dock body.
//
// Icons, not words (owner decision 2026-08-14, orca): the strip used to read
// `Agent (Default) ▾ | Git | Channels` and three text labels ate the whole
// header of a 248–320px column. Each tab is now a 36px glyph cell — the name
// (and the orchestrator's model) moved into the tooltip/aria-label, the steel
// underline still says which one is active, and the unread badge moved to the
// glyph's corner.

import { useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { IconRobot, IconGitBranch, IconHash } from '../icons';
import { DECK_ICON_BUTTON, DECK_ICON_BADGE, deckIconTone, formatDeckCount } from './deckIconStyles';
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
  /** Non-tab glyphs that sit right after the tabs (the wmux-web toggle). They
   *  are not tabs — web is a popover, not a deck view — so they render outside
   *  the tablist semantics but inside the same 36px strip. */
  afterTabs?: React.ReactNode;
  /** Right-aligned header controls (model chip + collapse button). Rendered
   *  after the tabs, pinned to the trailing edge — the deck's one header row,
   *  so orchestrator settings live next to its name instead of buried in
   *  Settings. Omit → the strip is tabs-only (unchanged). */
  rightSlot?: React.ReactNode;
  /** Orchestrator(=Agent) 탭에 인라인으로 붙는 현재 모델 라벨(예: 'Sonnet 5',
   *  기본값은 'Default'). 있으면 탭 라벨이 `Agent (Sonnet 5)`로 렌더된다. 모델
   *  선택은 탭에서만 하도록 컨트롤 바의 모델 칩을 이 자리로 옮긴 결과다. */
  commanderModelLabel?: string;
  /** 모델 드롭다운 옵션(OrchestratorModelChip.MODEL_OPTIONS 재사용). ChannelDock이
   *  store에서 주입하고, DeckTabs는 순수 컴포넌트로 유지된다. */
  commanderModelOptions?: { value: string; label: string }[];
  /** 현재 선택된 모델 값(옵션의 value; '' = Default). 선택 표시용. */
  commanderModelValue?: string;
  /** 모델 선택 콜백. 있으면 활성 Agent 탭 재클릭 시 드롭다운이 열린다. */
  onCommanderModelSelect?: (value: string) => void;
  /** Translator — defaults to identity so tests can omit it. */
  t?: (key: string) => string;
}

const TABS: {
  id: DeckTab;
  labelKey: string;
  fallback: string;
  Icon: (props: { size?: number }) => React.ReactElement;
}[] = [
  { id: 'commander', labelKey: 'deck.tabCommander', fallback: 'Orchestrator', Icon: IconRobot },
  { id: 'git', labelKey: 'deck.tabGit', fallback: 'Git', Icon: IconGitBranch },
  { id: 'channels', labelKey: 'deck.tabChannels', fallback: 'Channels', Icon: IconHash },
];

export function DeckTabs({
  active,
  onSelect,
  channelsUnread = 0,
  showChannels = true,
  afterTabs,
  rightSlot,
  commanderModelLabel,
  commanderModelOptions,
  commanderModelValue = '',
  onCommanderModelSelect,
  t: tProp,
}: DeckTabsProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const tabs = TABS.filter((tab) => tab.id !== 'channels' || showChannels);

  // Agent(commander) 탭의 인라인 모델 드롭다운 상태. 탭이 활성일 때만 재클릭으로
  // 열리며, 외부 클릭·Esc로 닫힌다(role="menu" a11y). 중첩 button을 피하려고
  // 드롭다운은 탭 button의 형제로, relative 래퍼 안에 절대배치한다.
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
  // 활성 탭이 아니게 되면(또는 메뉴 비활성) 열린 드롭다운을 닫는다.
  useEffect(() => {
    if (active !== 'commander' || !canModelMenu) setModelMenuOpen(false);
  }, [active, canModelMenu]);

  return (
    <div
      data-deck-tabs
      className="flex items-stretch shrink-0 border-b border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {/* `tablist` owns the tabs and NOTHING else: the web glyph and the
          header controls are not tabs, and a tablist that contains them makes
          AT announce "1 of 5" and wire arrow keys to buttons that aren't tabs.
          They are siblings of the list, inside the same 36px strip. */}
      <div
        role="tablist"
        aria-label={t('deck.tabsAriaLabel') || 'Command deck tabs'}
        className="flex items-stretch shrink-0"
      >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        const isCommander = tab.id === 'commander';
        // Agent 탭만 모델 인라인 드롭다운을 가진다(활성 상태에서 재클릭 시 토글).
        const tabHasModelMenu = isCommander && canModelMenu;
        const baseLabel = t(tab.labelKey) || tab.fallback;
        // 라벨은 아이콘 탭의 툴팁/aria로 간다. Agent는 현재 모델을 괄호로 덧붙여
        // `Agent (Sonnet 5)` — 글자가 사라진 만큼 모델을 확인할 곳이 여기뿐이다.
        const label = isCommander && commanderModelLabel ? `${baseLabel} (${commanderModelLabel})` : baseLabel;
        const unread = tab.id === 'channels' ? formatDeckCount(channelsUnread) : null;
        // The badge digit is decoration to a screen reader — with the text
        // label gone it has to ride in the accessible name, or the count is
        // simply not announced (the deleted sidebar rows read it as text).
        const ariaLabel = unread ? `${label} (${unread} unread)` : label;
        const button = (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={ariaLabel}
            title={label}
            data-deck-tab={tab.id}
            data-active={isActive ? 'true' : undefined}
            {...(tabHasModelMenu ? { 'aria-haspopup': 'menu', 'aria-expanded': modelMenuOpen } : {})}
            onClick={() => {
              // 비활성 → 탭 선택(기존 동작). 활성 Agent 탭 재클릭 → 모델 메뉴 토글.
              if (tabHasModelMenu && isActive) setModelMenuOpen((v) => !v);
              else onSelect(tab.id);
            }}
            className={`${DECK_ICON_BUTTON} ${deckIconTone(isActive, unread !== null)}`}
            {...(isActive ? tokenAttrs('textMain', 'text') : tokenAttrs('textMuted', 'text'))}
          >
            <tab.Icon size={15} />
            {/* 활성 Agent 탭에만 붙는 힌트 — 재클릭하면 모델 메뉴가 열린다는 표시. */}
            {tabHasModelMenu && isActive && (
              <span aria-hidden="true" className="absolute bottom-0.5 right-1 text-[10px] opacity-70">▾</span>
            )}
            {unread && (
              <span aria-hidden="true" data-deck-tab-unread className={DECK_ICON_BADGE} {...tokenAttrs('accent', 'bg')}>
                {unread}
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
                      className={`flex items-center justify-between w-full px-2.5 py-1 text-left text-[11px] font-medium transition-colors ${
                        sel
                          ? 'text-[var(--text-main)] font-semibold'
                          : 'text-[var(--text-sub)] hover:text-[var(--text-main)]'
                      }`}
                    >
                      <span>{o.value === '' ? t('deck.orchestratorModelDefault') : o.label}</span>
                      {sel && (
                        <span aria-hidden="true" className="text-[var(--accent-blue)] text-[10px]" {...tokenAttrs('accent', 'text')}>
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
      </div>
      {afterTabs && (
        <div data-deck-header-tools className="flex items-stretch shrink-0">
          {afterTabs}
        </div>
      )}
      {rightSlot && (
        <div data-deck-header-controls className="flex items-center ml-auto shrink-0 pr-1.5 gap-0.5">
          {rightSlot}
        </div>
      )}
    </div>
  );
}

export default DeckTabs;
