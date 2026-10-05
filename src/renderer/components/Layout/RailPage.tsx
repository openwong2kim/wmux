import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { ErrorBoundary } from '../ErrorBoundary';
import FleetView from '../FleetView/FleetView';
import SchedulesView from '../Schedules/SchedulesView';
import RemotePage from '../Remote/RemotePage';
import GitPage from '../Git/GitPage';
import { PAGES_BESIDE_DOCK } from './pagesBesideDock';

const SettingsPanel = lazy(() => import('../Settings/SettingsPanel'));


/**
 * How far a page beside the dock stays off each edge of the sheet so the dock
 * shows next to it: the whole dock side, from the dock's inner edge to the
 * sheet's edge (a file tree past the dock stays uncovered, and inert). No dock,
 * or a dock outside the sheet: no inset. Pure.
 */
export function insetBesideDock(sheet: Pick<DOMRect, 'left' | 'right'>, dock: Pick<DOMRect, 'left' | 'right' | 'width'> | null): { left: number; right: number } {
  if (!dock || dock.width <= 0 || dock.right <= sheet.left || dock.left >= sheet.right) return { left: 0, right: 0 };
  const mid = (sheet.left + sheet.right) / 2;
  return dock.left + dock.width / 2 >= mid
    ? { left: 0, right: Math.max(0, Math.round(sheet.right - dock.left)) }
    : { left: Math.max(0, Math.round(dock.right - sheet.left)), right: 0 };
}

/** The page's inset beside the dock, kept up to date while it shows (the dock
 *  opens, closes or the window resizes). Measured, so the page never asks the
 *  sheet's flex row to reflow: nothing under it, terminals included, resizes. */
function useInsetBesideDock(enabled: boolean, page: React.RefObject<HTMLDivElement | null>) {
  const [inset, setInset] = useState({ left: 0, right: 0 });
  useLayoutEffect(() => {
    if (!enabled) {
      setInset({ left: 0, right: 0 });
      return;
    }
    const measure = () => {
      const sheet = page.current?.parentElement ?? null;
      if (!sheet) return;
      const dock = document.querySelector<HTMLElement>('[data-dock-region] .wmux-dock');
      // The page's left/right offsets start inside the sheet's border, so
      // measure from there: from the border box, a 1px sliver of the panes
      // under it showed between the page and an overlay dock.
      const rect = sheet.getBoundingClientRect();
      const cs = getComputedStyle(sheet);
      const inner = { left: rect.left + (parseFloat(cs.borderLeftWidth) || 0), right: rect.right - (parseFloat(cs.borderRightWidth) || 0) };
      const next = insetBesideDock(inner, dock ? dock.getBoundingClientRect() : null);
      setInset((cur) => (cur.left === next.left && cur.right === next.right ? cur : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    const sheet = page.current?.parentElement;
    if (sheet) ro.observe(sheet);
    const region = document.querySelector('[data-dock-region]');
    // The dock mounts and unmounts as it opens and closes: watch the region's
    // own children only (its root is one), never the subtree, or every
    // streamed message would re-measure and force a layout.
    const mo = new MutationObserver(() => {
      measure();
      const dock = document.querySelector('[data-dock-region] .wmux-dock');
      if (dock) ro.observe(dock);
    });
    if (region) mo.observe(region, { childList: true });
    const dock = document.querySelector('[data-dock-region] .wmux-dock');
    if (dock) ro.observe(dock);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [enabled, page]);
  return inset;
}

/**
 * The page the rail has swapped into the sheet, drawn over the Workspaces
 * page (sidebar, panes, dock) that stays mounted and inert underneath — so
 * PTYs, scrollback, the WebGL atlas and IME state survive the round trip and
 * no terminal is ever resized. Every page but Settings covers only the sidebar
 * and the panes: the dock stays in view and in reach beside it, inline or as
 * the narrow-window overlay. Settings covers the whole sheet; it also stays
 * mounted while inspect mode is picking colours, when it shrinks to its
 * floating bar.
 */
export default function RailPage() {
  const route = useStore((s) => s.appRoute);
  const inspectModeActive = useStore((s) => s.inspectModeActive);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const besideDock = PAGES_BESIDE_DOCK.has(route) && !inspectModeActive;
  const inset = useInsetBesideDock(besideDock, pageRef);
  // Keys must not reach a terminal hidden under the page: drop focus left
  // behind in the (now inert) Workspaces page, or in the dock when this page
  // covers it too. The page then takes focus.
  useEffect(() => {
    if (route === 'workspaces' || inspectModeActive) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active.closest('[data-workspaces-page]') || (!PAGES_BESIDE_DOCK.has(route) && active.closest('[data-dock-region]'))) active.blur();
  }, [route, inspectModeActive]);
  if (route === 'settings' || inspectModeActive) {
    return (
      <ErrorBoundary name="SettingsPanel">
        <Suspense fallback={null}><SettingsPanel /></Suspense>
      </ErrorBoundary>
    );
  }
  if (route === 'workspaces') return null;
  return (
    <div
      ref={pageRef}
      className="wmux-page"
      data-rail-page={route}
      data-beside-dock={besideDock && (inset.left > 0 || inset.right > 0) ? 'true' : undefined}
      style={besideDock ? { left: inset.left, right: inset.right } : undefined}
    >
      {route === 'fleet' && <ErrorBoundary name="FleetView"><FleetView /></ErrorBoundary>}
      {route === 'schedules' && <ErrorBoundary name="SchedulesView"><SchedulesView /></ErrorBoundary>}
      {route === 'remote' && <ErrorBoundary name="RemotePage"><RemotePage /></ErrorBoundary>}
      {route === 'git' && <ErrorBoundary name="GitPage"><GitPage /></ErrorBoundary>}
    </div>
  );
}
