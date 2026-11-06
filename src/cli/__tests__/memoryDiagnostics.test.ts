import { describe, expect, it } from 'vitest';
import { groupProcessMemory, parseProcessMemory, renderMemoryDiagnostics } from '../memoryDiagnostics';
import { isAppMemoryDiagnostics, isDaemonMemoryDiagnostics } from '../../shared/memoryDiagnostics';
import { fetchPerformanceSection } from '../commands/doctor';

describe('memory diagnostics', () => {
  it('counts each PID once across nested daemon, agent, Electron and browser trees', () => {
    const rows = parseProcessMemory([
      '100 1 10 /Applications/wmux.app/wmux',
      '101 100 20 wmux Helper (Renderer)',
      '102 100 30 daemon',
      '103 102 40 shell',
      '104 103 50 claude',
      '105 104 60 python-mcp',
      '106 100 70 Google Chrome',
      '107 106 80 helper',
      '108 100 90 other-tool',
      '109 103 100 wmux-doctor',
      '110 109 110 ps',
      '200 1 120 unrelated Chrome',
      '201 1 130 reparented-agent',
      'garbage',
    ].join('\n'));
    expect(groupProcessMemory(rows, 100, 102, new Set([100, 101]), 109)).toEqual({
      app: { processes: 2, rssBytes: 30 * 1024 },
      daemon: { processes: 1, rssBytes: 30 * 1024 },
      workloads: { processes: 3, rssBytes: 150 * 1024 },
      browser: { processes: 2, rssBytes: 150 * 1024 },
      appChildren: { processes: 1, rssBytes: 90 * 1024 },
    });
  });

  it('handles a detached daemon, missing ancestors, and malformed cycles', () => {
    const rows = parseProcessMemory('2 1 12 daemon\n3 2 13 agent\n4 5 14 cycle\n5 4 15 cycle');
    const groups = groupProcessMemory(rows, undefined, 2, new Set(), 999);
    expect(groups.daemon).toEqual({ processes: 1, rssBytes: 12 * 1024 });
    expect(groups.workloads).toEqual({ processes: 1, rssBytes: 13 * 1024 });
  });

  it('ignores absent or malformed new diagnostics from older/mixed builds', async () => {
    const retention = { last: null, last5m: {}, sinceBoot: {} };
    for (const memory of [undefined, null, [], { mainPid: 1, processes: [{ pid: 2, type: 'GPU', workingSetBytes: -1 }] }]) {
      const section = await fetchPerformanceSection(async () => ({ id: 'test', ok: true, result: { retention, memory } }));
      expect(section).toEqual({ available: true, retention });
    }
    expect(isDaemonMemoryDiagnostics({ sessions: null })).toBe(false);
    expect(isAppMemoryDiagnostics({ mainPid: 1, processes: [{ pid: 2, type: 'GPU', workingSetBytes: Infinity }] })).toBe(false);
  });

  it('preserves Electron process breakdown and labels unavailable metrics honestly', async () => {
    const memory = { mainPid: 1, processes: [{ pid: 1, type: 'Browser', workingSetBytes: 1024 }] };
    const section = await fetchPerformanceSection(async () => ({ id: 'test', ok: true, result: {
      retention: { last: null, last5m: {}, sinceBoot: {} }, memory,
    } }));
    expect(section.memory).toEqual(memory);
    const text = renderMemoryDiagnostics(memory, undefined, { available: false, reason: 'sampling unavailable' });
    expect(text).toContain('daemon memory unavailable');
    expect(text).toContain('sampling unavailable');
    expect(text).toContain('not swap attribution');
    expect(text).toContain('Do not add them to RSS');
  });

  it('shows native snapshot use with its fallback reasons, most frequent first', () => {
    const counters = (native: number, fallbacks: number, reasons: Record<string, number>) =>
      ({ native, fallbacks, skipped: 0, circuitOpen: false, reasons });
    const daemon = {
      pid: 2, rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, arrayBuffersBytes: 0, sessions: [],
      snapshots: { ansi: counters(40, 3, { 'unsupported-state': 1, 'unsupported-history-limit': 2 }), text: counters(9, 0, {}) },
    };
    const text = renderMemoryDiagnostics(undefined, daemon, { available: false, reason: 'n/a' });
    expect(text).toContain('native ansi snapshots: 40 native, 3 not served natively, 0 skipped (unsupported-history-limit 2, unsupported-state 1)');
    expect(text).toContain('native text snapshots: 9 native, 0 not served natively, 0 skipped\n');
  });

  it('rejects malformed snapshot counters from a mixed-version daemon, and accepts their absence', () => {
    const base = { pid: 2, rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, arrayBuffersBytes: 0, sessions: [] };
    const ok = { native: 1, fallbacks: 0, skipped: 0, circuitOpen: false, reasons: { budget: 1 } };
    expect(isDaemonMemoryDiagnostics(base)).toBe(true);
    expect(isDaemonMemoryDiagnostics({ ...base, snapshots: { ansi: ok, text: ok } })).toBe(true);
    for (const snapshots of [null, { ansi: null, text: ok }, { ansi: ok }, { ansi: ok, text: { ...ok, reasons: { budget: -1 } } },
      { ansi: ok, text: { ...ok, circuitOpen: 'no' } }, { ansi: ok, text: ok, extra: {} }]) {
      expect(isDaemonMemoryDiagnostics({ ...base, snapshots })).toBe(false);
    }
  });
});
