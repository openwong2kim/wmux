import { useMemo } from 'react';
import { useStore } from '../../stores';
import { createWorkspaceAgentRosterSelector } from '../../stores/selectors/workspaceAgentRoster';
import { useT } from '../../hooks/useT';
import { IconSparkles } from '../icons';

type FanOutVariant = 'start' | 'multi' | 'auto';

interface FanOutTriggerProps {
  workspaceId: string;
  variant: FanOutVariant;
  /** Compact trailing control for the roster header. */
  compact?: boolean;
}

/** Full-width Start agents on an empty selected card. Null once the fleet exists. */
export function EmptyFleetFanOut({ workspaceId }: { workspaceId: string }) {
  const selector = useMemo(() => createWorkspaceAgentRosterSelector(workspaceId), [workspaceId]);
  const roster = useStore(selector);
  if (roster.agentCount > 0) return null;
  return <FanOutTrigger workspaceId={workspaceId} variant="start" />;
}

export default function FanOutTrigger({ workspaceId, variant, compact = false }: FanOutTriggerProps) {
  const t = useT();
  const selector = useMemo(() => createWorkspaceAgentRosterSelector(workspaceId), [workspaceId]);
  const roster = useStore(selector);
  const open = useStore((s) => s.fanOutWorkspaceId === workspaceId);
  const openFanOut = useStore((s) => s.openFanOut);
  const injectEnabled = useStore((s) => s.agentToolbarEnabled);

  if (!injectEnabled) return null;

  const kind = variant === 'auto'
    ? (roster.agentCount === 0 ? 'start' : 'multi')
    : variant;
  const label = kind === 'start' ? t('toolbar.fanOutStartAgents') : t('toolbar.fanOutMultiTask');

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const r = event.currentTarget.getBoundingClientRect();
    openFanOut(workspaceId, { top: r.bottom, left: r.left });
  };

  const className = compact
    ? `shrink-0 rounded-[4px] border border-[var(--bg-overlay)] px-1.5 py-0.5 text-[9px] font-mono text-[var(--text-sub)] hover:text-[var(--text-main)] hover:border-[var(--text-muted)] ${open ? 'border-[var(--accent-blue)] text-[var(--text-main)]' : ''}`
    : `ui-btn ui-btn-secondary w-full mt-1.5 h-7 text-[11px] inline-flex items-center justify-center gap-1.5 ${open ? 'border-[var(--accent-blue)]' : ''}`;

  return (
    <button
      type="button"
      draggable={false}
      data-workspace-fanout
      data-testid="fanout-button"
      data-fanout-kind={kind}
      className={className}
      title={t('fanout.title')}
      aria-label={label}
      onClick={handleClick}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {!compact && <IconSparkles size={12} />}
      <span>{label}</span>
    </button>
  );
}
