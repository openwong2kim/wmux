// Settings → Claude integration card.
//
// Tri-state surface driven by `uiSlice.hookSignalHealth`:
//
//                ┌──────────┐
//                │ Unknown  │  initial; count === 0
//                └────┬─────┘
//                     │ first signal arrives
//                     ▼
//                ┌──────────┐
//        ┌───────│ Detected │◀───── any new signal recordSignal
//        │       └────┬─────┘
//        │            │
//        │            │ no signal for ≥ STALE_THRESHOLD_MS
//        │            ▼
//        │       ┌──────────┐
//        └───────│  Stale   │ (returns to Detected on next signal)
//        new sig └──────────┘
//
// There is no Unknown → Stale transition: stale is only meaningful once at
// least one signal has been seen. Initial-state-after-restart with prior
// signals lost falls back to Unknown again (state is renderer-local, not
// persisted).
//
// The card never derives plugin install state from the signal stream alone
// (Codex P0): "Unknown" intentionally reads as ambiguous between "plugin
// not installed" and "installed but quiet". A real install probe is a
// follow-up — until then the install hint is shown in the Unknown state
// and the user resolves the ambiguity by trying the install command.

import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';

export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// Install command pair. Marketplace name comes from /.claude-plugin/marketplace.json
// (owner=openwong2kim, name=wmux). Plugin name from integrations/claude/.claude-plugin/plugin.json.
// Both commands on one clipboard payload, newline-separated. Exported so unit
// tests can assert the exact payload written to the clipboard.
export const INSTALL_COMMAND =
  '/plugin marketplace add openwong2kim/wmux\n/plugin install wmux-claude-integration@wmux';

/**
 * Format a "time since" string given a millisecond delta. Uses
 * Intl.RelativeTimeFormat for native i18n. Locale comes from store.
 */
function useRelativeTimeFromNow(): (ts: number | null) => string | null {
  const locale = useStore((s) => s.locale);
  return (ts: number | null) => {
    if (ts === null) return null;
    const deltaMs = Date.now() - ts;
    const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const sec = Math.round(deltaMs / 1000);
    if (sec < 60) return fmt.format(-sec, 'second');
    const min = Math.round(sec / 60);
    if (min < 60) return fmt.format(-min, 'minute');
    const hr = Math.round(min / 60);
    if (hr < 24) return fmt.format(-hr, 'hour');
    const day = Math.round(hr / 24);
    return fmt.format(-day, 'day');
  };
}

export type CardState =
  | { kind: 'unknown' }
  | { kind: 'detected'; relTime: string }
  | { kind: 'stale'; relTime: string };

/**
 * Pure derivation: given the live stats + a relative-time formatter + the
 * current clock cursor, decide which of the three card states applies.
 * Exported so unit tests can drive the state machine directly without
 * mounting React.
 */
export function deriveState(
  count: number,
  lastSignalAt: number | null,
  relFormatter: (ts: number | null) => string | null,
  now: number,
): CardState {
  if (count === 0 || lastSignalAt === null) return { kind: 'unknown' };
  const isStale = now - lastSignalAt > STALE_THRESHOLD_MS;
  const relTime = relFormatter(lastSignalAt) ?? '';
  return isStale ? { kind: 'stale', relTime } : { kind: 'detected', relTime };
}

/**
 * Settings → Claude integration tab content. Single card today; the surface
 * is intentionally narrow so future additions (install-probe banner,
 * per-pane token panel) can layer on without restructuring the layout.
 */
export function ClaudeIntegrationSection() {
  const t = useT();
  const health = useStore((s) => s.hookSignalHealth);
  const formatRel = useRelativeTimeFromNow();
  // `now` cursor so the "Xm ago" string and stale gate refresh once a
  // minute without needing a per-signal re-render trigger.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const cardState = deriveState(health.count, health.lastSignalAt, formatRel, now);

  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const onCopyInstall = async () => {
    try {
      await window.clipboardAPI.writeText(INSTALL_COMMAND);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2500);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader title={t('claudeIntegration.signalHealth.title')} />
        {cardState.kind === 'unknown' && (
          <UnknownBody t={t} onCopy={onCopyInstall} copyState={copyState} />
        )}
        {cardState.kind === 'detected' && (
          <DetectedBody t={t} health={health} relTime={cardState.relTime} />
        )}
        {cardState.kind === 'stale' && (
          <StaleBody t={t} relTime={cardState.relTime} onCopy={onCopyInstall} copyState={copyState} />
        )}
      </Card>
      <UsageCard t={t} />
    </div>
  );
}

// ─── Phase 2 — Anthropic 5h/7d usage meter card ─────────────────────────────

const REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 min, matches token-check

function UsageCard({
  t,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const enabled = useStore((s) => s.anthropicUsageEnabled);
  const setEnabled = useStore((s) => s.setAnthropicUsageEnabled);
  const usage = useStore((s) => s.anthropicUsage);
  const [lastRefreshAtMs, setLastRefreshAtMs] = useState<number>(0);
  const now = useNowEverySec();
  const cooldownRemainingMs = Math.max(0, lastRefreshAtMs + REFRESH_COOLDOWN_MS - now);
  const inCooldown = cooldownRemainingMs > 0;

  const onRefresh = () => {
    if (inCooldown) return;
    window.electronAPI.usage.refresh();
    setLastRefreshAtMs(Date.now());
  };

  return (
    <Card>
      <CardHeader title={t('claudeIntegration.usage.title')} />
      <p className="text-xs text-[color:var(--text-muted)] leading-relaxed">
        {t('claudeIntegration.usage.description')}
      </p>
      <div className="flex items-center justify-between">
        <span className="text-xs text-[color:var(--text-main)]">
          {t('claudeIntegration.usage.enableLabel')}
        </span>
        <ToggleSwitch
          checked={enabled}
          onChange={setEnabled}
          ariaLabel={t('claudeIntegration.usage.enableLabel')}
        />
      </div>
      {enabled && <UsageStatusLine t={t} usage={usage} now={now} />}
      {enabled && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={inCooldown}
          className="self-start text-[11px] font-mono px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50"
          style={{
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-main)',
            border: '1px solid var(--bg-overlay)',
          }}
        >
          {inCooldown
            ? t('claudeIntegration.usage.refreshCooldown', {
                seconds: Math.ceil(cooldownRemainingMs / 1000),
              })
            : t('claudeIntegration.usage.refreshButton')}
        </button>
      )}
    </Card>
  );
}

function useNowEverySec(): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function UsageStatusLine({
  t,
  usage,
  now,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  usage: ReturnType<typeof useStore.getState>['anthropicUsage'];
  now: number;
}) {
  if (usage.status === 'idle') return null;
  if (usage.status === 'ok' && usage.snapshot) {
    return (
      <div className="flex flex-col gap-1 text-xs font-mono">
        <span className="text-[color:var(--text-main)]">
          5h {usage.snapshot.sessionPct}% {'·'} 7d {usage.snapshot.weeklyPct}%
        </span>
        {usage.subscriptionType && (
          <span className="text-[color:var(--text-muted)]">
            {t('claudeIntegration.usage.subscription', { tier: usage.subscriptionType })}
          </span>
        )}
        <span className="text-[color:var(--text-muted)]">
          {t('claudeIntegration.usage.lastFetched', {
            ago: formatAgo(usage.snapshot.fetchedAtMs, now, t),
          })}
        </span>
      </div>
    );
  }
  // Error states — surface the human-readable code + optional detail.
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-[var(--accent-red)] font-mono">
        {t(`claudeIntegration.usage.status.${usage.status}` as never)}
      </span>
      {usage.lastError && (
        <span className="text-[color:var(--text-muted)] font-mono">{usage.lastError}</span>
      )}
    </div>
  );
}

function formatAgo(
  thenMs: number,
  nowMs: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const ageMin = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (ageMin <= 0) return t('claudeIntegration.usage.justNow');
  if (ageMin < 60) return t('claudeIntegration.usage.minutesAgo', { n: ageMin });
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return t('claudeIntegration.usage.hoursAgo', { n: ageHr });
  return t('claudeIntegration.usage.daysAgo', { n: Math.floor(ageHr / 24) });
}

function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none shrink-0"
      style={{ backgroundColor: checked ? 'var(--accent-blue)' : 'var(--bg-overlay)' }}
    >
      <span
        className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }}
      />
    </button>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-3"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
    >
      {children}
    </div>
  );
}

function CardHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm font-semibold text-[color:var(--text-main)] font-mono">{title}</span>
    </div>
  );
}

function UnknownBody({
  t,
  onCopy,
  copyState,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  onCopy: () => void;
  copyState: 'idle' | 'copied' | 'error';
}) {
  return (
    <>
      <p className="text-xs text-[color:var(--text-muted)] leading-relaxed">
        {t('claudeIntegration.signalHealth.unknownBody')}
      </p>
      <CopyInstallButton t={t} onCopy={onCopy} state={copyState} />
    </>
  );
}

function DetectedBody({
  t,
  health,
  relTime,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  health: ReturnType<typeof useStore.getState>['hookSignalHealth'];
  relTime: string;
}) {
  const p50 = health.p50 ?? 0;
  const p95 = health.p95 ?? 0;
  const matched = health.workspaceMatchRate.matched;
  const missed = health.workspaceMatchRate.missed;
  const totalAttempts = matched + missed;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p className="text-[color:var(--text-main)]">
        {t('claudeIntegration.signalHealth.detectedLastReceived', { rel: relTime })}
      </p>
      <p className="text-[color:var(--text-muted)] font-mono">
        {t('claudeIntegration.signalHealth.detectedLatencyFormat', {
          p50: Math.round(p50),
          p95: Math.round(p95),
          count: health.count,
        })}
      </p>
      <p className="text-[color:var(--text-muted)] font-mono">
        {t('claudeIntegration.signalHealth.workspaceMatchFormat', {
          matched,
          total: totalAttempts,
        })}
      </p>
    </div>
  );
}

function StaleBody({
  t,
  relTime,
  onCopy,
  copyState,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  relTime: string;
  onCopy: () => void;
  copyState: 'idle' | 'copied' | 'error';
}) {
  return (
    <>
      <p className="text-xs text-[color:var(--text-muted)] leading-relaxed">
        {t('claudeIntegration.signalHealth.staleBody', { rel: relTime })}
      </p>
      <CopyInstallButton t={t} onCopy={onCopy} state={copyState} />
    </>
  );
}

function CopyInstallButton({
  t,
  onCopy,
  state,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  onCopy: () => void;
  state: 'idle' | 'copied' | 'error';
}) {
  const label =
    state === 'copied'
      ? t('claudeIntegration.signalHealth.copySuccess')
      : state === 'error'
        ? t('claudeIntegration.signalHealth.copyError')
        : t('claudeIntegration.signalHealth.copyInstallCommand');
  return (
    <button
      type="button"
      onClick={onCopy}
      className="self-start text-[11px] font-mono px-2.5 py-1.5 rounded-md transition-colors"
      style={{
        backgroundColor: 'var(--bg-surface)',
        color: 'var(--text-main)',
        border: '1px solid var(--bg-overlay)',
      }}
    >
      {label}
    </button>
  );
}
