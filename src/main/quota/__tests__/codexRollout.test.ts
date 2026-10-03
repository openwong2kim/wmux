import { describe, expect, it } from 'vitest';
import type * as fs from 'fs';
import { latestLimitsIn, readCodexRolloutLimits } from '../codexRollout';

const NOW = Date.parse('2026-10-01T12:30:00Z');

function tokenCount(timestamp: string, primaryPct: number, secondaryPct: number, resetsAt = NOW / 1000 + 3600): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 10 } },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: primaryPct, window_minutes: 300, resets_at: resetsAt },
        secondary: { used_percent: secondaryPct, window_minutes: 10080, resets_at: resetsAt + 86400 },
      },
    },
  });
}

describe('latestLimitsIn', () => {
  it('returns the newest token_count that carries rate limits', () => {
    const text = [
      tokenCount('2026-10-01T12:00:00Z', 1, 10),
      JSON.stringify({ timestamp: '2026-10-01T12:05:00Z', payload: { type: 'agent_message' } }),
      tokenCount('2026-10-01T12:10:00Z', 3, 12),
    ].join('\n');
    const found = latestLimitsIn(text);
    expect(found?.primary?.usedPercent).toBe(3);
    expect(found?.secondary?.usedPercent).toBe(12);
    expect(found?.capturedAtMs).toBe(Date.parse('2026-10-01T12:10:00Z'));
    expect(found?.primary?.windowMinutes).toBe(300);
  });

  it('skips a first line cut by the tail window and lines that are not JSON', () => {
    const text = ['{"timestamp":"2026-10-01T12:00:00Z","payload":{"type":"token_count","rate_limits":{"prim', 'garbage "rate_limits"', tokenCount('2026-10-01T12:10:00Z', 5, 6)].join('\n');
    expect(latestLimitsIn(text)?.primary?.usedPercent).toBe(5);
  });

  it('returns null when no event has a usable window', () => {
    const empty = JSON.stringify({ timestamp: '2026-10-01T12:00:00Z', payload: { type: 'token_count', rate_limits: { primary: null, secondary: null } } });
    expect(latestLimitsIn(empty)).toBeNull();
    expect(latestLimitsIn('')).toBeNull();
  });
});

describe('readCodexRolloutLimits', () => {
  const file = (name: string, mtimeMs: number) => ({
    name,
    mtimeMs,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  });

  it('takes the newest reading across the newest session files', async () => {
    const files: Record<string, { mtimeMs: number; text: string }> = {
      '/s/a.jsonl': { mtimeMs: NOW - 60_000, text: tokenCount('2026-10-01T12:20:00Z', 2, 11) },
      '/s/b.jsonl': { mtimeMs: NOW - 120_000, text: tokenCount('2026-10-01T12:25:00Z', 4, 13) },
    };
    const found = await readCodexRolloutLimits('/s', {
      now: () => NOW,
      readdir: async () => Object.keys(files).map((p) => ({ name: p.split('/').pop()!, isSymbolicLink: () => false })) as unknown as fs.Dirent[],
      lstat: async (p: string) => {
        const f = files[p.replace(/\\/g, '/')];
        return f ? file(p, f.mtimeMs) : { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
      },
      readTail: async (p: string) => files[p.replace(/\\/g, '/')].text,
    });
    expect(found?.primary?.usedPercent).toBe(4);
  });

  it('is null when the sessions directory is missing or unreadable', async () => {
    const found = await readCodexRolloutLimits('/nope', {
      now: () => NOW,
      readdir: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(found).toBeNull();
  });
});
