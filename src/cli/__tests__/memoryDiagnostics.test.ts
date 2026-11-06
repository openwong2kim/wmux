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

  it('shows the Chrome debugging pipe when one ran, and rejects malformed pipe counters', async () => {
    const cdpPipe = { frames: 1200, bytes: 3 * 1024 * 1024, parseMsTotal: 2.5, parseMsMax: 0.84, largestFrameBytes: 1024 * 1024, dropped: { 'unknown-session': 2, 'root-event': 5 }, refused: 1 };
    const memory = { mainPid: 1, processes: [{ pid: 1, type: 'Browser', workingSetBytes: 1024 }], cdpPipe };
    const section = await fetchPerformanceSection(async () => ({ id: 'test', ok: true, result: { retention: { last: null, last5m: {}, sinceBoot: {} }, memory } }));
    expect(section.memory?.cdpPipe).toEqual(cdpPipe);
    const text = renderMemoryDiagnostics(memory, undefined, { available: false, reason: 'n/a' });
    expect(text).toContain('Chrome debugging pipe: 1200 frames, 3.0 MiB; parse 2.5 ms in all, slowest frame 0.8 ms, largest 1.0 MiB; 7 dropped (root-event 5, unknown-session 2), 1 commands refused');
    expect(renderMemoryDiagnostics({ mainPid: 1, processes: [] }, undefined, { available: false, reason: 'n/a' })).not.toContain('debugging pipe');
    for (const bad of [{ ...cdpPipe, frames: -1 }, { ...cdpPipe, dropped: null }, { ...cdpPipe, dropped: { x: 'y' } }, { ...cdpPipe, refused: undefined }]) {
      expect(isAppMemoryDiagnostics({ mainPid: 1, processes: [], cdpPipe: bad })).toBe(false);
    }
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

  it('shows what screen reads cost, the snapshot queue and the event loop', () => {
    const daemon = {
      pid: 2, rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, arrayBuffersBytes: 0, sessions: [],
      screenReads: { screen: { hits: 30, joins: 2, misses: 8 } },
      screenParses: { screen: { parses: 8, msTotal: 480, msMax: 200, bytes: 8 * 1024 * 1024 } },
      snapshotQueue: { jobs: 10, waitMsTotal: 100, waitMsMax: 40, runMsTotal: 600, runMsMax: 200 },
      eventLoop: { activeMs: 42, idleMs: 958 },
    };
    expect(isDaemonMemoryDiagnostics(daemon)).toBe(true);
    const text = renderMemoryDiagnostics(undefined, daemon, { available: false, reason: 'n/a' });
    expect(text).toContain('screen reads: screen 8 missed, 32 reused');
    expect(text).toContain('screen parses: 8 (avg 60 ms, max 200 ms, 8.0 MiB replayed)');
    expect(text).toContain('snapshot queue: 10 jobs, wait avg 10 ms (max 40 ms), run avg 60 ms (max 200 ms)');
    expect(text).toContain('event loop: 4.2% busy since the daemon started');
  });

  it('rejects malformed read counters from a mixed-version daemon', () => {
    const base = { pid: 2, rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, arrayBuffersBytes: 0, sessions: [] };
    for (const bad of [{ screenReads: { screen: null } }, { screenParses: { pane: { parses: 1 } } },
      { snapshotQueue: { jobs: 1 } }, { eventLoop: { activeMs: -1, idleMs: 0 } }]) {
      expect(isDaemonMemoryDiagnostics({ ...base, ...bad })).toBe(false);
    }
    const session = { id: 's', state: 'running', ringStoredBytes: 0, ringAllocatedBytes: 0, ringCapacityBytes: 0, socketQueuedBytes: 0, socketPeakQueuedBytes: 0, resyncQueuedBytes: 0 };
    expect(isDaemonMemoryDiagnostics({ ...base, sessions: [session] })).toBe(true);
    expect(isDaemonMemoryDiagnostics({ ...base, sessions: [{ ...session, ringLifetimeBytes: 12 }] })).toBe(true);
    for (const ringLifetimeBytes of ['unknown', -1]) {
      expect(isDaemonMemoryDiagnostics({ ...base, sessions: [{ ...session, ringLifetimeBytes }] })).toBe(false);
    }
  });

  it('shows tail reads by site: served, fallbacks by reason, what they cost and what the check found', () => {
    const fleet = {
      reads: 10, served: 6, whole: 1, fallbacks: { 'unknown-visible': 2, margins: 1 },
      tailMsTotal: 30, tailMsMax: 8, fallbackMsTotal: 270, fallbackMsMax: 100,
      ringCopyMsTotal: 12, ringCopyMsMax: 3, scanMsTotal: 4, scanMsMax: 2, scanBytes: 4096,
      checks: 2, mismatches: { viewport: 1, 'running:full-only': 1, any: 1 },
    };
    const daemon = { pid: 2, rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, arrayBuffersBytes: 0, sessions: [], tailReads: { fleet } };
    expect(isDaemonMemoryDiagnostics(daemon)).toBe(true);
    const text = renderMemoryDiagnostics(undefined, daemon, { available: false, reason: 'n/a' });
    expect(text).toContain('fleet tail reads: 6 served, 1 whole ring fit, 3 fell back (unknown-visible 2, margins 1); ' +
      'tail avg 3.0 ms (ring copy 1.2 ms, scan 0.4 ms), fallback avg 90 ms (max 100 ms)');
    expect(text).toContain('checked against the whole ring: 2, 1 differed (viewport 1, running:full-only 1)');
    for (const tailReads of [null, { fleet: null }, { fleet: { ...fleet, served: -1 } }, { fleet: { ...fleet, fallbacks: { margins: 'x' } } },
      { fleet: { ...fleet, mismatches: null } }]) {
      expect(isDaemonMemoryDiagnostics({ ...daemon, tailReads })).toBe(false);
    }
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
