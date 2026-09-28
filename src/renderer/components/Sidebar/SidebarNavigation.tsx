import { Fragment, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import WebToggle from '../StatusBar/WebToggle';
import { useStore } from '../../stores';
import { selectFleetSectionCounts } from '../../stores/selectors/fleet';
import { selectScheduleNavSummary } from '../../stores/selectors/schedules';
import { formatNextShort } from '../Schedules/format';
import { useT } from '../../hooks/useT';
import { Icon, IconClock, IconUsers } from '../icons';
import { FOCUS_RING } from '../focusRing';

/** Global destinations stay separate from workspace rows and their PTY state. */
export default function SidebarNavigation({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const paletteOpen = useStore((s) => s.commandPaletteVisible);
  const fleetOpen = useStore((s) => s.fleetViewVisible);
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
  const schedulesOpen = useStore((s) => s.schedulesViewOpen);
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
  const entries = [
    {
      id: 'search', label: t('sidebar.search'), name: t('sidebar.search'), active: paletteOpen,
      icon: <Icon size={16}><circle cx="6" cy="6" r="3.75" /><path d="m9 9 3.5 3.5" /></Icon>,
      onClick: () => useStore.getState().toggleCommandPalette(),
    },
    {
      id: 'fleet', label: t('fleet.title'), name: fleetName, active: fleetOpen,
      icon: <IconUsers size={16} />,
      onClick: () => useStore.getState().toggleFleetView(),
    },
    ...(schedulesAvailable ? [{
      id: 'schedules', label: t('schedules.title'), name: schedulesName, active: schedulesOpen,
      icon: <IconClock size={16} />,
      onClick: () => useStore.getState().toggleSchedulesView(),
    }] : []),
  ];

  return (
    <nav className={`wmux-sidebar-nav${compact ? ' wmux-sidebar-nav-compact' : ''}`} aria-label={t('sidebar.navigation')}>
      {entries.map(({ id, label, name, active, icon, onClick }) => {
        return (
          <Fragment key={id}><button
            type="button"
            data-sidebar-nav={id}
            className={`wmux-nav-button ${FOCUS_RING}`}
            aria-label={name}
            aria-pressed={active}
            title={compact ? name : undefined}
            onClick={onClick}
          >
            <span className="wmux-nav-icon" aria-hidden="true">{icon}</span>
            {!compact && <span className="wmux-nav-label min-w-0 flex-1 truncate text-left">{label}</span>}
            {id === 'fleet' && <FleetCounts compact={compact} needsYou={fleetCounts.needsYou} needsText={needsText} runningText={runningText} />}
            {id === 'schedules' && <FleetCounts compact={compact} needsYou={schedules.needs} needsText={schedulesNeedsText} runningText={schedulesMutedText} />}
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
function FleetCounts({ compact, needsYou, needsText, runningText }: {
  compact: boolean; needsYou: number; needsText: string; runningText: string;
}) {
  if (compact) {
    return needsYou > 0 ? <span className="wmux-nav-count" data-fleet-nav-count="needsYou" aria-hidden="true" /> : null;
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
