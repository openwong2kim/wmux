import * as path from 'path';
import type { ProviderQuota, QuotaWindow } from '../../shared/tokenUsage/quotaTypes';
import { loadClaudeCredential, type LoadResult } from '../claude/claudeCredential';
import { fetchUsage, UsageApiException, type UsageSnapshot } from '../claude/UsageApi';
import { scanClaudeTranscripts, type TranscriptScanDeps, type TranscriptScanResult } from './transcripts';

export interface ClaudeAdapterDeps {
  now?: () => number;
  configDir?: string;
  homeDir?: string;
  projectsDir?: string;
  scanTranscripts?: (dir: string, deps?: TranscriptScanDeps) => Promise<TranscriptScanResult>;
  transcriptScanDeps?: TranscriptScanDeps;
  loadCredential?: (configDir?: string) => Promise<LoadResult>;
  fetchClaude?: (token: string) => Promise<UsageSnapshot>;
}

export async function readClaudeQuota(deps: ClaudeAdapterDeps = {}): Promise<ProviderQuota> {
  const now = deps.now ?? Date.now;
  const loadCred = deps.loadCredential ?? loadClaudeCredential;
  const fetchApi = deps.fetchClaude ?? fetchUsage;

  let avgTokensPerMessage: number | null = null;
  let scanDetails: { sampleSize?: number; partial?: boolean } | undefined;
  try {
    const home = deps.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
    const projectsDir = deps.projectsDir ?? path.join(home, '.claude', 'projects');
    const scanFn = deps.scanTranscripts ?? scanClaudeTranscripts;
    const scanResult = await scanFn(projectsDir, deps.transcriptScanDeps);
    if (scanResult && scanResult.sampleSize > 0 && scanResult.average !== null) {
      avgTokensPerMessage = Math.round(scanResult.average);
      scanDetails = { sampleSize: scanResult.sampleSize, partial: scanResult.partial };
    }
  } catch {
    avgTokensPerMessage = null;
  }

  const base: Omit<ProviderQuota, 'status' | 'windows' | 'planLabel' | 'message'> = {
    provider: 'claude',
    creditsLabel: null,
    capturedAtMs: null,
    fetchedAtMs: now(),
    contextUsage: null,
    avgTokensPerMessage,
  };

  let loadResult: LoadResult;
  try {
    loadResult = await loadCred(deps.configDir);
  } catch {
    return {
      ...base,
      status: 'error',
      windows: [],
      planLabel: null,
      message: 'Failed to read Claude credentials.',
    };
  }

  if (!loadResult.ok) {
    if (loadResult.reason === 'not-found') {
      return {
        ...base,
        status: 'unauthorized',
        windows: [],
        planLabel: null,
        message: 'Claude credentials not found.',
      };
    }
    if (loadResult.reason === 'unsupported-platform') {
      return {
        ...base,
        status: 'unavailable',
        windows: [],
        planLabel: null,
        message: 'Claude is not supported on this platform.',
      };
    }
    return {
      ...base,
      status: 'error',
      windows: [],
      planLabel: null,
      message: 'Failed to read Claude credentials.',
    };
  }

  const { credential } = loadResult;
  const planLabel = credential.subscriptionType ?? credential.rateLimitTier ?? null;

  try {
    const snapshot = await fetchApi(credential.accessToken);
    const resetAtMs = (sec: number | undefined) => (sec !== undefined && sec > 0 ? sec * 1000 : null);
    const windows: QuotaWindow[] = [];
    if (snapshot.sessionPct !== undefined) {
      windows.push({
        id: 'five_hour',
        label: '5h',
        usedPct: snapshot.sessionPct,
        resetAtMs: resetAtMs(snapshot.sessionResetEpochSec),
        windowMins: 300,
      });
    }
    if (snapshot.weeklyPct !== undefined) {
      windows.push({
        id: 'weekly',
        label: 'weekly',
        usedPct: snapshot.weeklyPct,
        resetAtMs: resetAtMs(snapshot.weeklyResetEpochSec),
        windowMins: 10080,
      });
    }

    if (Array.isArray(snapshot.scoped)) {
      for (const item of snapshot.scoped) {
        const scopeKey = item.scope ? `scoped-${item.scope}` : `scoped-${item.group}`;
        windows.push({
          id: scopeKey,
          label: item.scope ? `${item.scope} (weekly)` : `${item.group} (weekly)`,
          usedPct: item.pct,
          resetAtMs: item.resetEpochSec && item.resetEpochSec > 0 ? item.resetEpochSec * 1000 : null,
          windowMins: 10080,
        });
      }
    }

    const result: ProviderQuota = {
      ...base,
      status: 'ok',
      windows,
      planLabel,
      fetchedAtMs: snapshot.fetchedAtMs || base.fetchedAtMs,
      message: null,
    };
    if (scanDetails) {
      Object.assign(result, scanDetails);
    }
    return result;
  } catch (err) {
    if (err instanceof UsageApiException) {
      if (err.detail.kind === 'unauthorized') {
        return {
          ...base,
          status: 'unauthorized',
          windows: [],
          planLabel,
          message: 'Claude authentication expired or revoked.',
        };
      }
      if (err.detail.kind === 'rate-limited') {
        return {
          ...base,
          status: 'error',
          windows: [],
          planLabel,
          message: 'Claude usage rate limited.',
        };
      }
      if (err.detail.kind === 'http') {
        return {
          ...base,
          status: 'error',
          windows: [],
          planLabel,
          message: err.detail.statusText || 'Claude usage HTTP error.',
        };
      }
      if (err.detail.kind === 'network') {
        return {
          ...base,
          status: 'error',
          windows: [],
          planLabel,
          message: 'Network error fetching Claude usage.',
        };
      }
      if (err.detail.kind === 'malformed') {
        return {
          ...base,
          status: 'error',
          windows: [],
          planLabel,
          message: 'Malformed response from Claude usage API.',
        };
      }
    }
    return {
      ...base,
      status: 'error',
      windows: [],
      planLabel,
      message: 'Failed to fetch Claude usage.',
    };
  }
}
