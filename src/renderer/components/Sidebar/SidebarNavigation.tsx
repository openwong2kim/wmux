import { Fragment, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isHandoffDrag } from '../Git/handoffDrag';

/** How long a held drag waits over Workspaces before it opens. */
export const SPRING_LOAD_MS = 500;
import WebToggle from '../StatusBar/WebToggle';
import { isMoaHqWorkspace } from '../../stores/slices/moaSlice';
import { useStore } from '../../stores';
import { selectFleetSectionCounts } from '../../stores/selectors/fleet';
import { selectScheduleNavSummary } from '../../stores/selectors/schedules';
import { formatNextShort } from '../Schedules/format';
import { useT } from '../../hooks/useT';
import { Icon, IconClock, IconGitBranch, IconGrid, IconRemoteDevices, IconUsers } from '../icons';
import { selectGitRailSignal } from '../Git/gitSignal';
import type { AppRoute } from '../../stores/slices/uiSlice';
import { FOCUS_RING } from '../focusRing';

/** Global destinations stay separate from workspace rows and their PTY state. */
export default function SidebarNavigation({ compact = false, home = false }: {
  compact?: boolean;
  /** The rail: pages only, each swapped into the sheet — Workspaces (home),
   *  Fleet, Schedules and Remote. Search & commands is a palette, reached from
   *  the titlebar pill (CommandPill) and ⌘K, so it is not on the rail. */
  home?: boolean;
}) {
  const t = useT();
  const paletteOpen = useStore((s) => s.commandPaletteVisible);
  const route = useStore((s) => s.appRoute);
  const fleetOpen = route === 'fleet';
  // The Fleet board's own Needs you / Running sections, counted.
  const fleetCounts = useStore(useShallow(selectFleetSectionCounts));
  const needsText = fleetCounts.needsYou > 0 ? t('sidebar.fleetNeedsYou', { count: fleetCounts.needsYou }) : '';
  const runningText = fleetCounts.running > 0 ? t('sidebar.fleetRunning', { count: fleetCounts.running }) : '';
  // Built from the visible strings, so the spoken name contains what is shown.
  const fleetName = [t('fleet.title'), needsText, runningText].filter(Boolean).join(', ');
  // Scheduled runs: shown once a daemon answers automation.list. Needs you =
  // runs awaiting a response + schedules whose last run failed; otherwise the
  // next run time, muted. Scheduled runs never appear in Fleet itself.
  const schedulesAvailable = useStore((s) => s.schedulesAvailable);
  const schedulesOpen = route === 'schedules';
  const schedules = useStore(useShallow(selectScheduleNavSummary));
  // A next-run time that has passed (the daemon advances it after the run)
  // must not linger: re-read the clock each minute while one is shown.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (schedules.nextRunAt === null) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [schedules.nextRunAt]);
  const upcoming = schedules.nextRunAt !== null && schedules.nextRunAt > now ? schedules.nextRunAt : null;
  const schedulesNeedsText = schedules.needs > 0 ? t('sidebar.fleetNeedsYou', { count: schedules.needs }) : '';
  // Muted trailing text: failures first (they want a look), else the next run.
  const schedulesFailedText = schedules.failed > 0 ? t('schedules.navFailed', { count: schedules.failed }) : '';
  const schedulesNextText = schedules.needs === 0 && upcoming !== null ? formatNextShort(upcoming) : '';
  const schedulesMutedText = schedulesFailedText || schedulesNextText;
  const schedulesName = [
    t('schedules.title'),
    schedulesNeedsText,
    schedulesFailedText || (schedulesNextText ? t('schedules.navNext', { time: schedulesNextText }) : ''),
  ].filter(Boolean).join(', ');
  // Git: a red dot while some workspace's PR fails its checks or conflicts
  // (pushed PR status only). The spoken name says why.
  const gitSignal = useStore(selectGitRailSignal);
  const gitName = gitSignal ? `${t('git.title')}, ${t('git.railSignal')}` : t('git.title');
  // Moa: the app-owned HQ workspace, reached only from here (it is not in the
  // workspace list). Shown while Moa is on and its workspace exists. It is a
  // workspace, not a page: it opens on Workspaces, and it is the current
  // place (instead of Workspaces) while it is the active workspace there.
  const moaShown = useStore((s) => !!s.moa?.config.enabled && s.moa.hq.state === 'ok' && !!s.moa.hq.workspaceId);
  const moaActive = useStore((s) => route === 'workspaces' && !s.activeRemoteKey
    && !!s.moa?.hq.workspaceId && s.activeWorkspaceId === s.moa.hq.workspaceId);
  // The rail navigates (a page stays put when clicked again); the in-sheet
  // list keeps its toggles.
  const go = (page: AppRoute, toggle: () => void) => () => {
    if (home) useStore.getState().setAppRoute(page);
    else toggle();
  };
  const search = {
    id: 'search', label: t('sidebar.search'), name: t('sidebar.search'), active: paletteOpen,
    icon: <Icon size={16}><circle cx="6" cy="6" r="3.75" /><path d="m9 9 3.5 3.5" /></Icon>,
    onClick: () => useStore.getState().toggleCommandPalette(),
  };
  const entries = [
    ...(home ? [{
      id: 'home', label: t('sidebar.workspaces'), name: t('sidebar.workspaces'), active: route === 'workspaces' && !(home && moaShown && moaActive),
      icon: <IconGrid size={16} />,
      onClick: () => {
        const st = useStore.getState();
        // From Moa's workspace, Workspaces means "back to my workspaces": the
        // HQ is not in the list, so show the first listed one.
        if (moaActive) {
          const back = st.workspaces.find((w) => !isMoaHqWorkspace(st, w.id));
          if (back) st.setActiveWorkspace(back.id);
        }
        st.setAppRoute('workspaces');
      },
    }] : [search]),
    {
      id: 'fleet', label: t('fleet.title'), name: fleetName, active: fleetOpen,
      icon: <IconUsers size={16} />,
      onClick: go('fleet', () => useStore.getState().toggleFleetView()),
    },
    ...(schedulesAvailable ? [{
      id: 'schedules', label: t('schedules.title'), name: schedulesName, active: schedulesOpen,
      icon: <IconClock size={16} />,
      onClick: go('schedules', () => useStore.getState().toggleSchedulesView()),
    }] : []),
    ...(home ? [{
      id: 'remote', label: t('sidebar.remote'), name: t('sidebar.remote'), active: route === 'remote',
      icon: <IconRemoteDevices size={16} />,
      onClick: () => useStore.getState().setAppRoute('remote'),
    }, {
      id: 'git', label: t('git.title'), name: gitName, active: route === 'git',
      icon: <IconGitBranch size={16} />,
      onClick: () => useStore.getState().setAppRoute('git'),
    }] : []),
    ...(home && moaShown ? [{
      id: 'moa', label: t('moa.rail.title'), name: t('moa.rail.title'), active: moaActive,
      // A monogram, not a logo: the M of Moa in the rail's stroke style.
      icon: <Icon size={16}><path d="M3.5 10.5v-7L7 7.5l3.5-4v7" /></Icon>,
      onClick: () => {
        const st = useStore.getState();
        st.openMoaHq();
        st.setAppRoute('workspaces');
      },
    }] : []),
  ];

  const springTimer = useRef<number | null>(null);
  const cancelSpring = () => {
    if (springTimer.current !== null) window.clearTimeout(springTimer.current);
    springTimer.current = null;
  };
  useEffect(() => cancelSpring, []);
  const springLoad = {
    onDragOver: (e: React.DragEvent<HTMLButtonElement>) => {
      if (!isHandoffDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
      if (springTimer.current !== null || useStore.getState().appRoute === 'workspaces') return;
      springTimer.current = window.setTimeout(() => {
        springTimer.current = null;
        useStore.getState().setAppRoute('workspaces');
      }, SPRING_LOAD_MS);
    },
    onDragLeave: cancelSpring,
    onDrop: cancelSpring,
  };
  return (
    <nav className={`wmux-sidebar-nav${compact ? ' wmux-sidebar-nav-compact' : ''}`} aria-label={t('sidebar.navigation')}>
      {entries.map(({ id, label, name, active, icon, onClick }) => {
        return (
          <Fragment key={id}><button
            type="button"
            data-sidebar-nav={id}
            className={`wmux-nav-button ${FOCUS_RING}`}
            aria-label={name}
            // Rail items are pages (the current one is aria-current); the
            // in-sheet list's items are toggles.
            aria-current={home && active ? 'page' : undefined}
            aria-pressed={home ? undefined : active}
            title={compact ? name : undefined}
            onClick={onClick}
            // Spring-loaded: an issue / PR dragged from the Git page and held
            // over Workspaces opens it, so the drop can land on a pane or a row.
            {...(id === 'home' ? springLoad : {})}
          >
            <span className="wmux-nav-icon" aria-hidden="true">{icon}</span>
            {!compact && <span className="wmux-nav-label min-w-0 flex-1 truncate text-left">{label}</span>}
            {id === 'fleet' && <FleetCounts compact={compact} badge needsYou={fleetCounts.needsYou} needsText={needsText} runningText={runningText} />}
            {id === 'schedules' && <FleetCounts compact={compact} needsYou={schedules.needs} needsText={schedulesNeedsText} runningText={schedulesMutedText} />}
            {id === 'git' && gitSignal && <span className="wmux-nav-count wmux-nav-alert" data-git-nav-signal aria-hidden="true" />}
          </button>{id === 'search' && <WebToggle variant="sidebar" compact={compact} />}</Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Trailing counts on the Fleet shortcut. Only Needs you is amber (the attention
 * signal); Running stays muted. The label never gives way to them: when the
 * row is too narrow, Running drops out first and then Needs you shrinks to its
 * number (ui.css). The compact rail has no room for numbers, so it keeps a
 * single amber dot while anything needs you. The accessible name carries the
 * full text in every variant.
 */
function FleetCounts({ compact, badge = false, needsYou, needsText, runningText }: {
  compact: boolean; badge?: boolean; needsYou: number; needsText: string; runningText: string;
}) {
  if (compact) {
    // Fleet carries the needs-you count as a number badge; any other
    // destination keeps the single dot.
    if (needsYou <= 0) return null;
    return badge
      ? <span className="wmux-nav-count wmux-nav-badge" data-fleet-nav-count="needsYou" aria-hidden="true">{needsYou > 99 ? '99+' : needsYou}</span>
      : <span className="wmux-nav-count" data-fleet-nav-count="needsYou" aria-hidden="true" />;
  }
  if (!needsText && !runningText) return null;
  return (
    <span className="wmux-nav-count" aria-hidden="true">
      {needsText && (
        <span className="wmux-nav-count-needs" data-fleet-nav-count="needsYou">
          <span className="wmux-nav-count-full">{needsText}</span>
          <span className="wmux-nav-count-short">{needsYou}</span>
        </span>
      )}
      {runningText && (
        <span className="wmux-nav-count-running" data-fleet-nav-count="running">
          {needsText && <span className="wmux-nav-count-sep">·</span>}
          {runningText}
        </span>
      )}
    </span>
  );
}
