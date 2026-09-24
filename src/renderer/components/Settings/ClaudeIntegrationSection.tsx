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
import { IconCheck, IconWarning } from '../icons';
import Button from '../ui/Button';
import Field from '../ui/Field';
import Switch from '../ui/Switch';
import { SettingsSection } from './SettingsLayout';

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
    <>
      <SettingsSection id="plugin" title={t('claudeIntegration.signalHealth.title')}>
        {cardState.kind === 'unknown' && (
          <UnknownBody t={t} onCopy={onCopyInstall} copyState={copyState} />
        )}
        {cardState.kind === 'detected' && (
          <DetectedBody t={t} health={health} relTime={cardState.relTime} />
        )}
        {cardState.kind === 'stale' && (
          <StaleBody t={t} relTime={cardState.relTime} onCopy={onCopyInstall} copyState={copyState} />
        )}
      </SettingsSection>
      <UsageCard t={t} />
    </>
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
    <SettingsSection id="usage" title={t('claudeIntegration.usage.title')} description={t('claudeIntegration.usage.description')}>
      <div className="settings-row">
        <Field label={t('claudeIntegration.usage.enableLabel')}>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('claudeIntegration.usage.enableLabel')}
          />
        </Field>
      </div>
      {enabled && (
        <div className="settings-row">
          <div className="flex items-center justify-between gap-4">
            <UsageStatusLine t={t} usage={usage} now={now} />
            <Button
              variant="secondary"
              size="md"
              className="shrink-0 ml-auto"
              onClick={onRefresh}
              disabled={inCooldown}
            >
              {inCooldown
                ? t('claudeIntegration.usage.refreshCooldown', {
                    seconds: Math.ceil(cooldownRemainingMs / 1000),
                  })
                : t('claudeIntegration.usage.refreshButton')}
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
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
      <div className="flex flex-col gap-0.5">
        <span className="ui-field-label tabular-nums">
          5h {usage.snapshot.sessionPct}% {'·'} 7d {usage.snapshot.weeklyPct}%
        </span>
        {usage.subscriptionType && (
          <span className="ui-field-description">
            {t('claudeIntegration.usage.subscription', { tier: usage.subscriptionType })}
          </span>
        )}
        <span className="ui-field-description">
          {t('claudeIntegration.usage.lastFetched', {
            ago: formatAgo(usage.snapshot.fetchedAtMs, now, t),
          })}
        </span>
      </div>
    );
  }
  // Error states — surface the human-readable code + optional detail.
  return (
    <div className="flex flex-col gap-0.5">
      <span className="ui-field-label" style={{ color: 'var(--accent-red)' }}>
        {t(`claudeIntegration.usage.status.${usage.status}` as never)}
      </span>
      {/* The raw error is machine evidence: mono. */}
      {usage.lastError && (
        <span className="ui-field-description font-mono">{usage.lastError}</span>
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

// ─── Subcomponents ──────────────────────────────────────────────────────────

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
    <div className="ui-row">
      <span className="ui-row-icon" aria-hidden="true"><span className="wmux-welcome-todo" /></span>
      <div className="ui-row-text">
        <p className="ui-row-detail">{t('claudeIntegration.signalHealth.unknownBody')}</p>
      </div>
      <div className="ui-row-action">
        <CopyInstallButton t={t} onCopy={onCopy} state={copyState} />
      </div>
    </div>
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
    <div className="ui-row">
      <span className="ui-row-icon wmux-welcome-glyph-ok" aria-hidden="true"><IconCheck size={14} /></span>
      <div className="ui-row-text">
      <p className="ui-row-title">
        {t('claudeIntegration.signalHealth.detectedLastReceived', { rel: relTime })}
      </p>
      <p className="ui-row-detail tabular-nums">
        {t('claudeIntegration.signalHealth.detectedLatencyFormat', {
          p50: Math.round(p50),
          p95: Math.round(p95),
          count: health.count,
        })}
      </p>
      <p className="ui-row-detail tabular-nums">
        {t('claudeIntegration.signalHealth.workspaceMatchFormat', {
          matched,
          total: totalAttempts,
        })}
      </p>
      </div>
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
    <div className="ui-row">
      <span className="ui-row-icon wmux-welcome-glyph-warn" aria-hidden="true"><IconWarning size={14} /></span>
      <div className="ui-row-text">
        <p className="ui-row-detail">{t('claudeIntegration.signalHealth.staleBody', { rel: relTime })}</p>
      </div>
      <div className="ui-row-action">
        <CopyInstallButton t={t} onCopy={onCopy} state={copyState} />
      </div>
    </div>
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
    <Button variant="secondary" size="md" onClick={onCopy}>
      {label}
    </Button>
  );
}
