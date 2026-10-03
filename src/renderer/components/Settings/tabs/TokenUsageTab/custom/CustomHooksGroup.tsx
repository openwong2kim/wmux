import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Badge from '../../../../ui/Badge';
import Switch from '../../../../ui/Switch';

export interface CustomHooksGroupProps {
  hooks: SurfaceItem[];
  onToggle?: (itemId: string) => void;
  stagedChanges?: Map<string, boolean>;
  rejectedFlags?: Map<string, string>;
}

export function CustomHooksGroup({
  hooks,
  onToggle,
  stagedChanges,
  rejectedFlags,
}: CustomHooksGroupProps) {
  const t = useT();
  if (hooks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 my-4" data-testid="token-custom-hooks-group">
      <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-sub)]">
        {t('settings.tokenUsage.hooksHeader', { count: hooks.length })}
      </span>
      <div className="rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] overflow-hidden divide-y divide-[var(--border-hairline)]">
        {hooks.map((hook) => {
          const isStaged = stagedChanges?.has(hook.id) ?? false;
          const isEnabled = isStaged
            ? stagedChanges!.get(hook.id)!
            : hook.enabled !== false;
          const costTone =
            hook.hookCost === 'calls-model' || hook.hookCost === 'injects-context'
              ? 'warning'
              : 'neutral';
          const isWmux = hook.wmuxRequired || hook.source === 'wmux';
          const rejectionReason = rejectedFlags?.get(hook.id);

          return (
            <div
              key={hook.id}
              className="flex items-center justify-between px-3 py-2 text-[13px]"
              data-testid={`hook-${hook.name}`}
              data-staged={isStaged ? 'true' : undefined}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-[var(--text-main)]">{hook.name}</span>
                <Badge tone="neutral">{hook.source}</Badge>
                {hook.hookEvent && (
                  <span className="text-[11px] ui-code text-[var(--text-sub)]">{hook.hookEvent}</span>
                )}
                {hook.hookCost && (
                  <Badge tone={costTone}>{hook.hookCost}</Badge>
                )}
                {isWmux && (
                  <Badge tone="warning">{t('settings.tokenUsage.neededByWmux')}</Badge>
                )}
                {isStaged && <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>}
                {rejectionReason && (
                  <Badge tone="danger">{rejectionReason}</Badge>
                )}
                {hook.readOnlyReason && (
                  <span className="text-[11px] text-[var(--text-sub)]">({hook.readOnlyReason})</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {hook.toggleable && onToggle ? (
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={() => onToggle(hook.id)}
                    aria-label={t('settings.tokenUsage.toggleAria', { name: hook.name })}
                    data-testid={`toggle-hook-${hook.name}`}
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
