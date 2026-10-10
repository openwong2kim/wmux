import { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconBell, IconChevron, IconComputer, IconServer } from '../icons';
import PaneActionsMenu, { PANE_ACTIONS_MENU_WIDTH, type PaneActionItem } from '../Pane/PaneActionsMenu';
import { selectFleetSectionCounts } from '../../stores/selectors/fleet';
import { selectActivePcId, selectPcRailHosts, selectPcRailVisible } from '../../stores/selectors/pcRail';
import { LOCAL_PC_ID, isShadowWorkspaceId, type PcRailHost } from '../../../shared/pcRail';
import type { Workspace } from '../../../shared/types';
import type { StoreState } from '../../stores';
import { accessLines, badgeText, hostSummary, monogram, pcIconState } from '../PcRail/pcRailModel';

type Anchor = { top: number; left: number; right: number; bottom: number };

// This computer's needs-you: Fleet's count over local workspaces only. A
// shadow workspace's tabs are another computer's, already in its host count.
// The filtered list is kept per source array so Fleet's own memo still hits.
let localMemo: { src: Workspace[]; out: Workspace[] } | null = null;
function localWorkspaces(all: Workspace[]): Workspace[] {
  if (localMemo?.src === all) return localMemo.out;
  const out = all.some((w) => isShadowWorkspaceId(w.id)) ? all.filter((w) => !isShadowWorkspaceId(w.id)) : all;
  localMemo = { src: all, out };
  return out;
}
const selectLocalNeedsYou = (s: StoreState): number =>
  selectFleetSectionCounts({ ...s, workspaces: localWorkspaces(s.workspaces) }).needsYou;
type MenuState = { kind: 'main' } | { kind: 'host'; hostId: string };

/**
 * PC switcher state, shared by the sidebar title and the collapsed rail's one
 * item. Hosts carry their credential kind from main's roster rows.
 */
function usePcSwitcher() {
  const visible = useStore(selectPcRailVisible);
  const railHosts = useStore(selectPcRailHosts);
  const roster = useStore((s) => s.pcRailHosts);
  const hosts = useMemo(() => railHosts.map((h) => {
    const tokenKind = roster.find((r) => r.id === h.id)?.tokenKind;
    return tokenKind ? { ...h, tokenKind } : h;
  }), [railHosts, roster]);
  const storedActive = useStore(selectActivePcId);
  // An id that is no longer paired reads as this computer.
  const active = hosts.some((h) => h.id === storedActive) ? storedActive : LOCAL_PC_ID;
  const localNeeds = useStore(selectLocalNeedsYou);
  // The selected computer's rows are on screen, so only the others count.
  const othersNeedYou = (active === LOCAL_PC_ID ? 0 : localNeeds)
    + hosts.reduce((sum, h) => sum + (h.id === active ? 0 : h.attention.needsYou), 0);
  return { visible, hosts, active, localNeeds, othersNeedYou };
}

/**
 * The dropdown: this computer, then each web-paired computer with its state
 * and needs-you count; under a divider, one "<name> settings ›" per host for
 * Mute, Remote page, Pair again and the access lines.
 */
function PcSwitcherMenu({ anchor, triggerRef, onDone }: { anchor: Anchor; triggerRef: React.RefObject<HTMLElement | null>; onDone: () => void }) {
  const t = useT();
  const { hosts, active, localNeeds } = usePcSwitcher();
  const feeds = useStore((s) => s.pcRailFeeds);
  const [menu, setMenuState] = useState<MenuState>({ kind: 'main' });
  // Selecting an item closes the menu right after onSelect; a submenu opener
  // must survive that close, so the close reads the kind set a moment ago.
  const nextRef = useRef<MenuState>({ kind: 'main' });
  const setMenu = (next: MenuState) => {
    nextRef.current = next;
    setMenuState(next);
  };
  // Closes unless a submenu for a still-paired host was just opened.
  const closeMain = () => {
    const next = nextRef.current;
    if (next.kind === 'host' && hosts.some((h) => h.id === next.hostId)) return;
    onDone();
  };
  const select = (id: string) => useStore.getState().setActivePc(id);
  const hostLine = (host: PcRailHost) => {
    const [, state] = hostSummary(host, feeds[host.id], t);
    return host.attention.needsYou > 0 ? `${state} · ${t('pcRail.needsYouCount', { count: host.attention.needsYou })}` : state;
  };

  const mainItems: PaneActionItem[] = [
    {
      key: `pc-${LOCAL_PC_ID}`,
      label: t('pcRail.thisComputer'),
      ...(localNeeds > 0 ? { detail: t('pcRail.needsYouCount', { count: localNeeds }) } : {}),
      icon: <IconComputer size={14} />,
      active: active === LOCAL_PC_ID,
      onSelect: () => select(LOCAL_PC_ID),
    },
    ...hosts.map((host): PaneActionItem => ({
      key: `pc-${host.id}`,
      label: host.label,
      detail: hostLine(host),
      title: hostSummary(host, feeds[host.id], t).join('\n'),
      icon: (
        <span
          className="text-[10px] font-semibold leading-none tracking-tight"
          style={pcIconState(host) === 'online' ? undefined : { color: 'var(--text-muted)' }}
        >
          {monogram(host.label)}
        </span>
      ),
      active: active === host.id,
      onSelect: () => select(host.id),
    })),
    ...hosts.map((host, i): PaneActionItem => ({
      key: `pc-manage-${host.id}`,
      label: t('pcSwitcher.manage', { name: host.label }),
      hasPopup: true,
      separatorBefore: i === 0,
      onSelect: () => setMenu({ kind: 'host', hostId: host.id }),
    })),
  ];

  // A host removed while its submenu is open falls back to the main list.
  const menuHost = menu.kind === 'host' ? hosts.find((h) => h.id === menu.hostId) : undefined;
  const hostItems: PaneActionItem[] = menuHost ? [
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

  return (
    <PaneActionsMenu
      key={menuHost ? menuHost.id : 'main'}
      anchor={anchor}
      triggerRef={triggerRef}
      items={menuHost ? hostItems : mainItems}
      onClose={menuHost ? onDone : closeMain}
      onEscape={menuHost ? () => setMenu({ kind: 'main' }) : undefined}
      initialFocusKey={menuHost ? undefined : `pc-${active}`}
      restoreFocusTo={triggerRef}
      footer={menuHost
        ? <span className="block whitespace-normal" data-pc-access>{accessLines(menuHost, t).map((line) => <span key={line} className="block">{line}</span>)}</span>
        : undefined}
    />
  );
}

/** The needs-you count of the computers not on screen, next to the title. */
function OthersBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="wmux-pc-switcher-badge" data-pc-switcher-badge title={label} aria-label={label}>
      {badgeText(count)}
    </span>
  );
}

/**
 * The Workspaces title. With no paired computer it is the plain title, as
 * before. Otherwise it reads "Workspaces ▾" (this computer) or
 * "Workspaces · <name> ▾" and opens the PC dropdown; a badge beside it sums
 * the needs-you of the computers not selected.
 */
export function PcSwitcherTitle({ title }: { title: string }) {
  const t = useT();
  const { visible, hosts, active, othersNeedYou } = usePcSwitcher();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  if (!visible) return <span className="min-w-0 truncate">{title}</span>;
  const name = active === LOCAL_PC_ID ? null : hosts.find((h) => h.id === active)?.label ?? null;
  const toggle = () => {
    if (anchor) return close();
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    // placePopover right-aligns to anchor.right: hang the menu from the title's left edge.
    setAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.left + PANE_ACTIONS_MENU_WIDTH });
  };
  return (
    <span className="min-w-0 flex items-center gap-1.5">
      <button
        ref={buttonRef}
        type="button"
        className={`wmux-pc-switcher min-w-0 flex items-center gap-1 rounded-md ${FOCUS_RING}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title={t('pcSwitcher.open')}
        onClick={toggle}
        data-pc-switcher
      >
        <span className="min-w-0 truncate">{title}</span>
        {name && <span className="min-w-0 truncate wmux-pc-switcher-name" data-pc-switcher-name>· {name}</span>}
        <span className="shrink-0 rotate-90 opacity-70" aria-hidden="true"><IconChevron size={12} /></span>
      </button>
      <OthersBadge count={othersNeedYou} label={t('pcSwitcher.othersNeedYou', { count: othersNeedYou })} />
      {anchor && <PcSwitcherMenu anchor={anchor} triggerRef={buttonRef} onDone={close} />}
    </span>
  );
}

/**
 * The collapsed sidebar's one entry point: the selected computer's mark (the
 * computer glyph for this one, a monogram for a host) at the top of the rail's
 * workspace list, opening the same dropdown beside the rail. Nothing without a
 * paired computer.
 */
export function PcSwitcherRailItem() {
  const t = useT();
  const { visible, hosts, active, othersNeedYou } = usePcSwitcher();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  if (!visible) return null;
  const host = hosts.find((h) => h.id === active);
  const name = host?.label ?? t('pcRail.thisComputer');
  const toggle = () => {
    if (anchor) return close();
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = sidebarPosition === 'right' ? r.left - 4 - PANE_ACTIONS_MENU_WIDTH : r.right + 4;
    setAnchor({ top: r.top, bottom: r.top, left, right: left + PANE_ACTIONS_MENU_WIDTH });
  };
  const label = [name, ...(othersNeedYou > 0 ? [t('pcSwitcher.othersNeedYou', { count: othersNeedYou })] : [])].join(', ');
  return (
    <div className="flex justify-center pb-1" data-pc-switcher-rail-slot>
      <button
        ref={buttonRef}
        type="button"
        className={`wmux-nav-button ${FOCUS_RING}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`${t('pcSwitcher.open')}: ${label}`}
        title={label}
        onClick={toggle}
        data-pc-switcher-rail
      >
        {host
          ? <span className="text-[12px] font-semibold leading-none tracking-tight" aria-hidden="true">{monogram(host.label)}</span>
          : <IconComputer size={18} />}
        {othersNeedYou > 0 && <span className="wmux-nav-count wmux-nav-badge" aria-hidden="true">{badgeText(othersNeedYou)}</span>}
      </button>
      {anchor && <PcSwitcherMenu anchor={anchor} triggerRef={buttonRef} onDone={close} />}
    </div>
  );
}
