import { Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';
import WebToggle from '../StatusBar/WebToggle';
import { useStore } from '../../stores';
import { selectFleetSectionCounts } from '../../stores/selectors/fleet';
import { useT } from '../../hooks/useT';
import { Icon, IconUsers } from '../icons';
import { FOCUS_RING } from '../focusRing';

/** Global destinations stay separate from workspace rows and their PTY state. */
export default function SidebarNavigation({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const paletteOpen = useStore((s) => s.commandPaletteVisible);
  const fleetOpen = useStore((s) => s.fleetViewVisible);
  // The Fleet board's own Needs you / Running sections, counted.
  const fleetCounts = useStore(useShallow(selectFleetSectionCounts));
  const fleetName = [
    t('fleet.title'),
    ...(fleetCounts.needsYou > 0 ? [t('strip.needsYou', { count: fleetCounts.needsYou })] : []),
    ...(fleetCounts.running > 0 ? [t('strip.running', { count: fleetCounts.running })] : []),
  ].join(', ');
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
            {!compact && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
            {id === 'fleet' && <FleetCounts compact={compact} {...fleetCounts} />}
          </button>{id === 'search' && <WebToggle variant="sidebar" compact={compact} />}</Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Trailing counts on the Fleet shortcut. Only Needs you is amber (the attention
 * signal); Running stays muted. The compact rail has no room for numbers, so it
 * keeps a single amber dot while anything needs you. The accessible name
 * carries the numbers in both variants.
 */
function FleetCounts({ compact, needsYou, running }: { compact: boolean; needsYou: number; running: number }) {
  const t = useT();
  if (compact) {
    return needsYou > 0 ? <span className="wmux-nav-count" data-fleet-nav-count="needsYou" aria-hidden="true" /> : null;
  }
  if (needsYou === 0 && running === 0) return null;
  return (
    <span className="wmux-nav-count" aria-hidden="true">
      {needsYou > 0 && <span className="wmux-nav-count-needs" data-fleet-nav-count="needsYou">{t('sidebar.fleetNeedsYou', { count: needsYou })}</span>}
      {needsYou > 0 && running > 0 && <span>·</span>}
      {running > 0 && <span data-fleet-nav-count="running">{t('sidebar.fleetRunning', { count: running })}</span>}
    </span>
  );
}
