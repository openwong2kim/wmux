import { Fragment } from 'react';
import WebToggle from '../StatusBar/WebToggle';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { Icon, IconUsers } from '../icons';
import { FOCUS_RING } from '../focusRing';

/** Global destinations stay separate from workspace rows and their PTY state. */
export default function SidebarNavigation({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const paletteOpen = useStore((s) => s.commandPaletteVisible);
  const fleetOpen = useStore((s) => s.fleetViewVisible);
  const entries = [
    {
      id: 'search', label: t('sidebar.search'), active: paletteOpen,
      icon: <Icon size={16}><circle cx="6" cy="6" r="3.75" /><path d="m9 9 3.5 3.5" /></Icon>,
      onClick: () => useStore.getState().toggleCommandPalette(),
    },
    {
      id: 'fleet', label: t('fleet.title'), active: fleetOpen,
      icon: <IconUsers size={16} />,
      onClick: () => useStore.getState().toggleFleetView(),
    },
  ];

  return (
    <nav className={`wmux-sidebar-nav${compact ? ' wmux-sidebar-nav-compact' : ''}`} aria-label={t('sidebar.navigation')}>
      {entries.map(({ id, label, active, icon, onClick }) => {
        const name = label;
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
          </button>{id === 'search' && <WebToggle variant="sidebar" compact={compact} />}</Fragment>
        );
      })}
    </nav>
  );
}
