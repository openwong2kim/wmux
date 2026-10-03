import { lazy, Suspense, useEffect } from 'react';
import { useStore } from '../../stores';
import { ErrorBoundary } from '../ErrorBoundary';
import FleetView from '../FleetView/FleetView';
import SchedulesView from '../Schedules/SchedulesView';
import RemotePage from '../Remote/RemotePage';

const SettingsPanel = lazy(() => import('../Settings/SettingsPanel'));

/**
 * The page the rail has swapped into the sheet, drawn over the Workspaces
 * page (sidebar, panes, dock) that stays mounted and inert underneath — so
 * PTYs, scrollback, the WebGL atlas and IME state survive the round trip and
 * no terminal is ever resized. Settings also stays mounted while inspect mode
 * is picking colours, when it shrinks to its floating bar.
 */
export default function RailPage() {
  const route = useStore((s) => s.appRoute);
  const inspectModeActive = useStore((s) => s.inspectModeActive);
  // Keys must not reach a terminal hidden under the page: drop focus left
  // behind in the (now inert) Workspaces page. The page then takes focus.
  useEffect(() => {
    if (route === 'workspaces' || inspectModeActive) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-workspaces-page]')) active.blur();
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
    <div className="wmux-page" data-rail-page={route}>
      {route === 'fleet' && <ErrorBoundary name="FleetView"><FleetView /></ErrorBoundary>}
      {route === 'schedules' && <ErrorBoundary name="SchedulesView"><SchedulesView /></ErrorBoundary>}
      {route === 'remote' && <ErrorBoundary name="RemotePage"><RemotePage /></ErrorBoundary>}
    </div>
  );
}
