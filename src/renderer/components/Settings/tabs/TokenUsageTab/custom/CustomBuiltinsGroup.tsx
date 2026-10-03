import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Badge from '../../../../ui/Badge';
import Switch from '../../../../ui/Switch';

export interface CustomBuiltinsGroupProps {
  items: SurfaceItem[];
  onToggle?: (itemId: string) => void;
  stagedChanges?: Map<string, boolean>;
  rejectedFlags?: Map<string, string>;
}

export function CustomBuiltinsGroup({
  items,
  onToggle,
  stagedChanges,
  rejectedFlags,
}: CustomBuiltinsGroupProps) {
  const t = useT();
  if (items.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 my-4" data-testid="token-custom-builtins-group">
      <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-sub)]">
        {t('settings.tokenUsage.builtinsHeader', { count: items.length })}
      </span>
      <div className="rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] overflow-hidden divide-y divide-[var(--border-hairline)]">
        {items.map((item) => {
          const isStaged = stagedChanges?.has(item.id) ?? false;
          const isEnabled = isStaged
            ? stagedChanges!.get(item.id)!
            : item.enabled !== false;
          const rejectionReason = rejectedFlags?.get(item.id);

          return (
            <div
              key={item.id}
              className="flex items-center justify-between px-3 py-2 text-[13px]"
              data-testid={`builtin-${item.name}`}
              data-staged={isStaged ? 'true' : undefined}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-[var(--text-main)]">{item.name}</span>
                <Badge tone="neutral">{item.kind === 'builtin-tool' ? t('settings.tokenUsage.builtinTool') : t('settings.tokenUsage.context')}</Badge>
                {isStaged && <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>}
                {rejectionReason && (
                  <Badge tone="danger">{rejectionReason}</Badge>
                )}
                {item.readOnlyReason && (
                  <span className="text-[11px] text-[var(--text-sub)]">({item.readOnlyReason})</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {item.toggleable && onToggle ? (
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={() => onToggle(item.id)}
                    aria-label={t('settings.tokenUsage.toggleAria', { name: item.name })}
                    data-testid={`toggle-builtin-${item.name}`}
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
