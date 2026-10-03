import * as fs from 'fs';
import { findRecentJsonlFiles } from './transcripts/fileUtils';
import type { TranscriptScanDeps } from './transcripts/types';

/** One rate-limit window as Codex records it in a session's `token_count` event. */
export interface RolloutLimitWindow {
  usedPercent: number;
  windowMinutes: number | null;
  /** Epoch ms. */
  resetsAtMs: number | null;
}

export interface RolloutLimits {
  /** When Codex wrote the event (epoch ms): the reading is only as fresh as this. */
  capturedAtMs: number;
  limitId: string | null;
  primary: RolloutLimitWindow | null;
  secondary: RolloutLimitWindow | null;
}

export interface RolloutLimitsDeps extends TranscriptScanDeps {
  /** The last `bytes` of a file, as text. Injected by tests. */
  readTail?: (filePath: string, bytes: number) => Promise<string>;
}

const TAIL_BYTES = 256 * 1024;
const DEFAULT_BUDGET_MS = 1500;
/** Newest files to look in: the latest turn of any session carries the account-wide limits. */
const MAX_FILES_READ = 6;

async function readTailFromDisk(filePath: string, bytes: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

function asWindow(raw: unknown): RolloutLimitWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;
  return {
    usedPercent: w.used_percent,
    windowMinutes: typeof w.window_minutes === 'number' ? w.window_minutes : null,
    resetsAtMs: typeof w.resets_at === 'number' && w.resets_at > 0 ? w.resets_at * 1000 : null,
  };
}

/** The newest `token_count` event in `text` that carries rate limits, or null. */
export function latestLimitsIn(text: string): RolloutLimits | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    try {
      const evt = JSON.parse(line) as { timestamp?: string; payload?: { type?: string; rate_limits?: unknown } };
      if (evt.payload?.type !== 'token_count') continue;
      const rl = evt.payload.rate_limits as Record<string, unknown> | null | undefined;
      if (!rl || typeof rl !== 'object') continue;
      const primary = asWindow(rl.primary);
      const secondary = asWindow(rl.secondary);
      if (!primary && !secondary) continue;
      const at = evt.timestamp ? Date.parse(evt.timestamp) : NaN;
      if (!Number.isFinite(at)) continue;
      return {
        capturedAtMs: at,
        limitId: typeof rl.limit_id === 'string' ? rl.limit_id : null,
        primary,
        secondary,
      };
    } catch {
      // A line cut by the tail window, or not JSON: keep looking further back.
    }
  }
  return null;
}

/**
 * Codex's own record of the account's rate limits, read from the newest session
 * files under `sessionsDir`. It needs no running app-server, so the quota card
 * still reads when Codex is closed; it is as old as the last Codex turn.
 */
export async function readCodexRolloutLimits(
  sessionsDir: string,
  deps: RolloutLimitsDeps = {},
): Promise<RolloutLimits | null> {
  const nowFn = deps.now ?? Date.now;
  const readTail = deps.readTail ?? readTailFromDisk;
  let files;
  try {
    ({ files } = await findRecentJsonlFiles(sessionsDir, deps, nowFn(), deps.budgetMs ?? deps.budget ?? DEFAULT_BUDGET_MS));
  } catch {
    return null;
  }

  let best: RolloutLimits | null = null;
  for (const file of files.slice(0, MAX_FILES_READ)) {
    try {
      const found = latestLimitsIn(await readTail(file.path, TAIL_BYTES));
      if (found && (!best || found.capturedAtMs > best.capturedAtMs)) best = found;
    } catch {
      // An unreadable file is skipped; the next one may have the reading.
    }
  }
  return best;
}
