import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconBell, IconComputer, IconServer, IconX } from '../icons';
import PaneActionsMenu, { PANE_ACTIONS_MENU_WIDTH, type PaneActionItem } from '../Pane/PaneActionsMenu';
import { selectFleetSectionCounts } from '../../stores/selectors/fleet';
import { selectActivePcId, selectPcRailHosts, selectPcRailVisible } from '../../stores/selectors/pcRail';
import { LOCAL_PC_ID } from '../../../shared/pcRail';
import { accessLines, badgeText, hostSummary, monogram, pcBadge, pcIconState, type PcBadge } from './pcRailModel';

/** Column width; the titlebar segment widens by the same amount. */
export const PC_RAIL_WIDTH = 48;

/** False until the Workspaces page lists a selected host's rows. */
const HOST_ROWS_SHOWN = false;

function Badge({ badge }: { badge: PcBadge }) {
  if (badge.kind === 'needs-you') {
    // Pushed to the icon's corner: a monogram is wider than a page glyph.
    return <span className="wmux-nav-count wmux-nav-badge" style={{ top: -2, right: -2 }} data-pc-badge="needs-you" aria-hidden="true">{badgeText(badge.count)}</span>;
  }
  if (badge.kind === 'finished') {
    // The sidebar's neutral done dot, in the corner the needs-you dot uses.
    return (
      <span
        className="absolute h-1.5 w-1.5 rounded-full bg-[var(--text-main)]"
        style={{ top: 7, right: 7 }}
        data-pc-badge="finished"
        aria-hidden="true"
      />
    );
  }
  return null;
}

/**
 * The computer column (DESIGN.md "Window: frame and sheet"): a 48px column on
 * the frame, left of the page rail, shown only while at least one web host is
 * paired. This computer first, then each web-paired computer.
 *
 * Picking one sets the active computer (pcRail slice). Keys: arrows, Home and
 * End move between icons (one tab stop, roving); Enter or Space selects;
 * Shift+F10, the context-menu key or a right-click opens a host's menu.
 */
export default function PcRail() {
  const t = useT();
  const visible = useStore(selectPcRailVisible);
  const railHosts = useStore(selectPcRailHosts);
  // How each credential was issued comes on main's roster rows; the column's
  // host rows do not carry it yet, so it is joined here.
  const roster = useStore((s) => s.pcRailHosts);
  const hosts = useMemo(() => railHosts.map((h) => {
    const tokenKind = roster.find((r) => r.id === h.id)?.tokenKind;
    return tokenKind ? { ...h, tokenKind } : h;
  }), [railHosts, roster]);
  const active = useStore(selectActivePcId);
  const feeds = useStore((s) => s.pcRailFeeds);
  const localNeeds = useStore(useShallow(selectFleetSectionCounts)).needsYou;
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const navRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ hostId: string; anchor: { top: number; left: number; right: number; bottom: number } } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const openMenu = useCallback((hostId: string, button: HTMLElement) => {
    const r = button.getBoundingClientRect();
    const left = sidebarPosition === 'right' ? r.left - 4 - PANE_ACTIONS_MENU_WIDTH : r.right + 4;
    menuTriggerRef.current = button;
    setMenu({ hostId, anchor: { top: r.top, bottom: r.top, left, right: left + PANE_ACTIONS_MENU_WIDTH } });
  }, [sidebarPosition]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>('button[data-pc-id]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      const id = buttons[at].dataset.pcId;
      if (id && id !== LOCAL_PC_ID) {
        e.preventDefault();
        openMenu(id, buttons[at]);
      }
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    // Alt+Shift+arrows belong to the global "cycle computers" shortcut.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? buttons.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    // The column scrolls when it holds more computers than fit.
    buttons[next]?.scrollIntoView?.({ block: 'nearest' });
  }, [openMenu]);

  if (!visible) return null;

  const select = (id: string) => useStore.getState().setActivePc(id);
  const menuHost = menu ? hosts.find((h) => h.id === menu.hostId) : undefined;
  const menuItems: PaneActionItem[] = menuHost ? [
    {
      key: 'mute',
      label: menuHost.muted ? t('pcRail.unmute') : t('pcRail.mute'),
      icon: <IconBell size={13} />,
      active: menuHost.muted,
      onSelect: () => useStore.getState().setPcMuted(menuHost.id, !menuHost.muted),
    },
    {
      key: 'remote-page',
      label: t('pcRail.openRemotePage'),
      icon: <IconServer size={13} />,
      onSelect: () => useStore.getState().setAppRoute('remote'),
    },
    {
      key: 'pair-again',
      label: t('pcRail.pairAgain'),
      icon: <IconComputer size={13} />,
      onSelect: () => useStore.getState().requestRemoteRepair(menuHost.id),
    },
  ] : [];

  // Roving tab stop: the selected icon, or this computer when the selection
  // is not in the column.
  const tabStop = active === LOCAL_PC_ID || hosts.some((h) => h.id === active) ? active : LOCAL_PC_ID;
  const localSelected = tabStop === LOCAL_PC_ID;
  // This computer's badge is needs-you only (Fleet's count); its finished
  // turns are the sidebar's done dots. Selected, its rows are on screen.
  const localBadge = pcBadge({ needsYou: localNeeds, finished: 0 }, localSelected);
  const localLines = [t('pcRail.thisComputer'), ...(localBadge.kind === 'needs-you' ? [t('pcRail.needsYouCount', { count: localNeeds })] : [])];

  return (
    <nav
      ref={navRef}
      // Scrolls (no visible bar) once the computers outgrow the window; the
      // top inset keeps the first badge inside the scroll box's clip.
      className="wmux-rail wmux-pc-rail flex flex-col shrink-0 h-full min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-width:none]"
      style={{ width: PC_RAIL_WIDTH, paddingTop: 4 }}
      aria-label={t('pcRail.label')}
      onKeyDown={onKeyDown}
      data-pc-rail
    >
      <button
        type="button"
        className={`wmux-nav-button ${FOCUS_RING}`}
        data-pc-id={LOCAL_PC_ID}
        tabIndex={tabStop === LOCAL_PC_ID ? 0 : -1}
        aria-current={localSelected ? 'true' : undefined}
        aria-label={localLines.join(', ')}
        title={localLines.join('\n')}
        style={localSelected ? { background: 'var(--selection)', color: 'var(--text-main)' } : undefined}
        onClick={() => select(LOCAL_PC_ID)}
      >
        <IconComputer size={19} />
        <Badge badge={localBadge} />
      </button>
      {hosts.map((host) => {
        const selected = tabStop === host.id;
        const state = pcIconState(host);
        const dim = state !== 'online';
        // A selected host keeps its badge until its rows are shown (the
        // scoped sidebar is a later change); hiding it now would hide the
        // only rendition.
        const badge = pcBadge(host.attention, selected && HOST_ROWS_SHOWN);
        const lines = hostSummary(host, feeds[host.id], t);
        return (
          <button
            key={host.id}
            type="button"
            className={`wmux-nav-button ${FOCUS_RING}`}
            data-pc-id={host.id}
            data-pc-state={state}
            tabIndex={selected ? 0 : -1}
            aria-current={selected ? 'true' : undefined}
            aria-haspopup="menu"
            aria-label={lines.join(', ')}
            title={lines.join('\n')}
            style={selected ? { background: 'var(--selection)', color: 'var(--text-main)' } : undefined}
            onClick={() => select(host.id)}
            onContextMenu={(e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); openMenu(host.id, e.currentTarget); }}
          >
            <span
              className="text-[12px] font-semibold leading-none tracking-tight"
              style={{ color: dim ? 'var(--text-muted)' : undefined, opacity: dim ? 0.6 : undefined }}
              aria-hidden="true"
            >
              {monogram(host.label)}
            </span>
            {state === 'needs-repair' && (
              <span className="absolute" style={{ right: 4, bottom: 4, color: 'var(--accent-red)' }} data-pc-repair aria-hidden="true">
                <IconX size={9} />
              </span>
            )}
            <Badge badge={badge} />
          </button>
        );
      })}
      {menu && menuHost && (
        <PaneActionsMenu
          anchor={menu.anchor}
          triggerRef={menuTriggerRef}
          items={menuItems}
          onClose={closeMenu}
          footer={<span className="block whitespace-normal" data-pc-access>{accessLines(menuHost, t).map((line) => <span key={line} className="block">{line}</span>)}</span>}
        />
      )}
    </nav>
  );
}
