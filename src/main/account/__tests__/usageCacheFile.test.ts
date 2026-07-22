import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageCacheFileWriter, usageCacheFilePath, type UsageCacheFileEntry } from '../usageCacheFile';

function entry(overrides: Partial<UsageCacheFileEntry> = {}): UsageCacheFileEntry {
  return {
    accountId: 'acc-1',
    name: 'work',
    configDir: 'C:/users/x/.wmux/accounts/claude-1',
    status: 'ok',
    snapshot: {
      sessionPct: 23,
      sessionResetEpochSec: 1_800_000_000,
      weeklyPct: 8,
      weeklyResetEpochSec: 1_800_500_000,
      fetchedAtMs: 1_000,
    },
    fetchedAtMs: 1_000,
    ...overrides,
  };
}

describe('UsageCacheFileWriter', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-usage-cache-'));
    filePath = usageCacheFilePath(tmpDir);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readFile(): { version: number; updatedAtMs: number; entries: UsageCacheFileEntry[] } {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  it('writes the collected entries on flush, creating parent dirs', () => {
    const writer = new UsageCacheFileWriter(filePath, () => [entry()], 300, () => 42);
    writer.flush();
    const data = readFile();
    expect(data.version).toBe(1);
    expect(data.updatedAtMs).toBe(42);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].name).toBe('work');
    expect(data.entries[0].snapshot?.sessionPct).toBe(23);
  });

  it('debounces a burst of schedule() calls into one write with FRESH data', () => {
    const collect = vi.fn(() => [entry()]);
    const writer = new UsageCacheFileWriter(filePath, collect, 300);
    writer.schedule();
    writer.schedule();
    writer.schedule();
    expect(collect).not.toHaveBeenCalled(); // nothing until the window closes
    vi.advanceTimersByTime(300);
    expect(collect).toHaveBeenCalledTimes(1); // collect at flush time, once
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('schedules again after a flush (not a one-shot)', () => {
    const collect = vi.fn(() => [entry()]);
    const writer = new UsageCacheFileWriter(filePath, collect, 300);
    writer.schedule();
    vi.advanceTimersByTime(300);
    writer.schedule();
    vi.advanceTimersByTime(300);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('dispose() flushes a pending write and blocks future schedules', () => {
    const collect = vi.fn(() => [entry()]);
    const writer = new UsageCacheFileWriter(filePath, collect, 300);
    writer.schedule();
    writer.dispose(); // pending timer → immediate flush
    expect(collect).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(filePath)).toBe(true);
    writer.schedule();
    vi.advanceTimersByTime(1000);
    expect(collect).toHaveBeenCalledTimes(1); // disposed — no more writes
  });

  it('never throws when collect() fails (usage feature must survive)', () => {
    const writer = new UsageCacheFileWriter(filePath, () => {
      throw new Error('boom');
    }, 300);
    expect(() => writer.flush()).not.toThrow();
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
