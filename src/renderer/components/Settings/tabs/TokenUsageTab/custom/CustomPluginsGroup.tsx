import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Badge from '../../../../ui/Badge';
import Switch from '../../../../ui/Switch';

export interface CustomPluginsGroupProps {
  plugins: SurfaceItem[];
  onToggle?: (itemId: string) => void;
  stagedChanges?: Map<string, boolean>;
  rejectedFlags?: Map<string, string>;
}

export function CustomPluginsGroup({
  plugins,
  onToggle,
  stagedChanges,
  rejectedFlags,
}: CustomPluginsGroupProps) {
  const t = useT();
  if (plugins.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 my-4" data-testid="token-custom-plugins-group">
      <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-sub)]">
        {t('settings.tokenUsage.pluginsHeader', { count: plugins.length })}
      </span>
      <div className="rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] overflow-hidden divide-y divide-[var(--border-hairline)]">
        {plugins.map((plugin) => {
          const isStaged = stagedChanges?.has(plugin.id) ?? false;
          const isEnabled = isStaged
            ? stagedChanges!.get(plugin.id)!
            : plugin.enabled !== false;
          const rejectionReason = rejectedFlags?.get(plugin.id);

          return (
            <div
              key={plugin.id}
              className="flex items-center justify-between px-3 py-2 text-[13px]"
              data-testid={`plugin-${plugin.name}`}
              data-staged={isStaged ? 'true' : undefined}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-[var(--text-main)]">{plugin.name}</span>
                <Badge tone="neutral">{plugin.source}</Badge>
                {isStaged && <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>}
                {rejectionReason && (
                  <Badge tone="danger">{rejectionReason}</Badge>
                )}
                {plugin.readOnlyReason && (
                  <span className="text-[11px] text-[var(--text-sub)]">({plugin.readOnlyReason})</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {plugin.toggleable && onToggle ? (
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={() => onToggle(plugin.id)}
                    aria-label={t('settings.tokenUsage.toggleAria', { name: plugin.name })}
                    data-testid={`toggle-plugin-${plugin.name}`}
                  />
                ) : (
                  <Badge tone={isEnabled ? 'success' : 'neutral'}>
                    {isEnabled ? t('settings.tokenUsage.enabled') : t('settings.tokenUsage.disabled')}
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
