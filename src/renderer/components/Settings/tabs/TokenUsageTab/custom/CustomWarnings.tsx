import { IconWarning } from '../../../../icons';
import { useT } from '../../../../../hooks/useT';

interface CustomWarningsProps {
  warnings: string[];
}

export function CustomWarnings({ warnings }: CustomWarningsProps) {
  const t = useT();
  if (!warnings || warnings.length === 0) return null;

  return (
    <div
      className="rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 my-3 text-[12px] text-[var(--text-sub)] flex flex-col gap-1.5"
      data-testid="token-custom-warnings"
    >
      <div className="flex items-center gap-2 font-medium text-[var(--text-main)]">
        <IconWarning size={14} />
        <span>{t('settings.tokenUsage.warnings')}</span>
      </div>
      <ul className="list-disc pl-5 m-0 space-y-1">
        {warnings.map((warn, i) => (
          <li key={i}>{warn}</li>
        ))}
      </ul>
    </div>
  );
}
