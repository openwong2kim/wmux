import { useT } from '../../hooks/useT';

/**
 * A tab body the browser build (wmux web `/app`) cannot show: a non-terminal
 * tab, or a terminal slot whose session it does not list. Static on purpose —
 * it owns no PTY, so nothing here can create or write one.
 */
export default function SurfacePlaceholder({ title, isActive, surfaceId }: { title: string; isActive: boolean; surfaceId: string }) {
  const t = useT();
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[var(--bg-base)] text-sm"
      style={{ display: isActive ? 'flex' : 'none', color: 'var(--text-sub2)' }}
      data-surface-id={surfaceId}
      data-surface-placeholder
    >
      <span className="truncate max-w-[80%]" style={{ color: 'var(--text-sub)' }}>{title}</span>
      <span className="text-xs">{t('web.surfacePlaceholder')}</span>
    </div>
  );
}
