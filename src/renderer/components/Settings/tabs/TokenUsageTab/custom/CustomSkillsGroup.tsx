import type { SurfaceItem } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Badge from '../../../../ui/Badge';
import Switch from '../../../../ui/Switch';

export interface CustomSkillsGroupProps {
  skills: SurfaceItem[];
  onToggle?: (itemId: string) => void;
  stagedChanges?: Map<string, boolean>;
  rejectedFlags?: Map<string, string>;
}

export function CustomSkillsGroup({
  skills,
  onToggle,
  stagedChanges,
  rejectedFlags,
}: CustomSkillsGroupProps) {
  const t = useT();
  if (skills.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 my-4" data-testid="token-custom-skills-group">
      <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-sub)]">
        {t('settings.tokenUsage.skillsHeader', { count: skills.length })}
      </span>
      <div className="rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] overflow-hidden divide-y divide-[var(--border-hairline)]">
        {skills.map((skill) => {
          const isStaged = stagedChanges?.has(skill.id) ?? false;
          const isEnabled = isStaged
            ? stagedChanges!.get(skill.id)!
            : skill.enabled !== false;
          const rejectionReason = rejectedFlags?.get(skill.id);

          return (
            <div
              key={skill.id}
              className="flex items-center justify-between px-3 py-2 text-[13px]"
              data-testid={`skill-${skill.name}`}
              data-staged={isStaged ? 'true' : undefined}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-[var(--text-main)]">{skill.name}</span>
                <Badge tone="neutral">{skill.source}</Badge>
                {skill.descriptionChars !== null && (
                  <span className="text-[11px] text-[var(--text-sub)]">
                    {t('settings.tokenUsage.charsCount', { count: skill.descriptionChars })}
                  </span>
                )}
                {isStaged && <Badge tone="warning">{t('settings.tokenUsage.staged')}</Badge>}
                {rejectionReason && (
                  <Badge tone="danger">{rejectionReason}</Badge>
                )}
                {skill.readOnlyReason && (
                  <span className="text-[11px] text-[var(--text-sub)]">({skill.readOnlyReason})</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {skill.toggleable && onToggle ? (
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={() => onToggle(skill.id)}
                    aria-label={t('settings.tokenUsage.toggleAria', { name: skill.name })}
                    data-testid={`toggle-skill-${skill.name}`}
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
