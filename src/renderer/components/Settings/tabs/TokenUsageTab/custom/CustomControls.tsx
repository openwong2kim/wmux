import type { SurfaceProviderId } from '../../../../../../shared/tokenUsage/surfaceTypes';
import { useT } from '../../../../../hooks/useT';
import Button from '../../../../ui/Button';
import Checkbox from '../../../../ui/Checkbox';
import Input from '../../../../ui/Input';
import SegmentedControl from '../../../../ui/SegmentedControl';

interface CustomControlsProps {
  provider: SurfaceProviderId;
  onProviderChange: (p: SurfaceProviderId) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onlyChanged: boolean;
  onOnlyChangedChange: (val: boolean) => void;
  onRefresh: () => void;
  loading: boolean;
  providers?: SurfaceProviderId[];
}

const ALL_PROVIDER_OPTIONS: Record<SurfaceProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
};

const ORDERED_PROVIDERS: readonly SurfaceProviderId[] = ['claude', 'codex', 'agy'] as const;

export function CustomControls({
  provider,
  onProviderChange,
  searchQuery,
  onSearchChange,
  onlyChanged,
  onOnlyChangedChange,
  onRefresh,
  loading,
  providers,
}: CustomControlsProps) {
  const t = useT();
  const allowed = providers && providers.length > 0 ? new Set(providers) : new Set(ORDERED_PROVIDERS);
  const providerOptions = ORDERED_PROVIDERS.filter((p) => allowed.has(p)).map((p) => ({
    value: p,
    label: ALL_PROVIDER_OPTIONS[p] ?? p,
  }));

  return (
    <div className="flex flex-col gap-3 my-3" data-testid="token-custom-controls">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <SegmentedControl
          value={provider}
          options={providerOptions}
          onValueChange={onProviderChange}
          ariaLabel={t('settings.tokenUsage.surfaceProviderAria')}
          data-testid="token-custom-provider-tabs"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          data-testid="token-custom-refresh"
        >
          {loading ? t('settings.tokenUsage.refreshing') : t('settings.tokenUsage.refresh')}
        </Button>
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <Input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('settings.tokenUsage.searchPlaceholder')}
            data-testid="token-custom-search"
          />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-[var(--text-main)] cursor-pointer select-none">
          <Checkbox
            checked={onlyChanged}
            onCheckedChange={onOnlyChangedChange}
            data-testid="token-custom-only-changed"
          />
          <span>{t('settings.tokenUsage.onlyChanged')}</span>
        </label>
      </div>
    </div>
  );
}
