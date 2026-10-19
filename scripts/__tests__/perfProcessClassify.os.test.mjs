// Pure-logic tests for the A1 RAM-attribution classifier
// (scripts/perf-process-classify.mjs, PR D). No packaged app, no CIM, no
// pipes — collected by `npm test` via scripts/__tests__/**/*.test.mjs and safe
// on CI. Mirrors the perfCompare.test.mjs convention: import the pure module,
// feed it mock rows, assert the bucketing.
import { describe, it, expect } from 'vitest';
import {
  classifyProcess,
  accumulateBreakdown,
  RAM_CATEGORIES,
} from '../perf-process-classify.mjs';

// Realistic command-line shapes Electron/Chromium produce on Windows. The
// classifier reads the --type= token, not the whole string, so the noisy
// flag tails are deliberately preserved here.
const MAIN_CMD = '"C:\\path\\out\\wmux-win32-x64\\wmux.exe"';
const RENDERER_CMD = '"C:\\path\\wmux.exe" --type=renderer --user-data-dir="C:\\u" --lang=en-US';
const GPU_CMD = '"C:\\path\\wmux.exe" --type=gpu-process --gpu-preferences=xyz';
const UTILITY_CMD = '"C:\\path\\wmux.exe" --type=utility --utility-sub-type=network.mojom.NetworkService';
const QUOTED_GPU_CMD = '"C:\\path\\wmux.exe" --type="gpu-process"';

describe('classifyProcess — Electron child types', () => {
  it('buckets a typeless wmux.exe as main', () => {
    expect(classifyProcess({ name: 'wmux.exe', commandLine: MAIN_CMD })).toBe('main');
  });

  it('buckets --type=renderer as renderer', () => {
    expect(classifyProcess({ name: 'wmux.exe', commandLine: RENDERER_CMD })).toBe('renderer');
  });

  it('buckets --type=gpu-process as gpu', () => {
    expect(classifyProcess({ name: 'wmux.exe', commandLine: GPU_CMD })).toBe('gpu');
  });

  it('buckets --type=utility as utility', () => {
    expect(classifyProcess({ name: 'wmux.exe', commandLine: UTILITY_CMD })).toBe('utility');
  });

  it('tolerates a quoted --type value', () => {
    expect(classifyProcess({ name: 'wmux.exe', commandLine: QUOTED_GPU_CMD })).toBe('gpu');
  });

  it('does NOT mis-bucket a path that merely contains "renderer"', () => {
    // No --type flag → still main, even though the path has the word renderer.
    const cmd = '"C:\\renderer-tools\\wmux.exe"';
    expect(classifyProcess({ name: 'wmux.exe', commandLine: cmd })).toBe('main');
  });
});

describe('classifyProcess — daemon vs main (shared wmux.exe image)', () => {
  it('buckets the daemon by authoritative pid match, not by name', () => {
    // Same image + no --type as the main process; only the pid distinguishes.
    expect(
      classifyProcess(
        { name: 'wmux.exe', commandLine: MAIN_CMD },
        { pid: 4242, mainPid: 1000, daemonPid: 4242 },
      ),
    ).toBe('daemon');
  });

  it('still buckets the main process as main when the daemon pid differs', () => {
    expect(
      classifyProcess(
        { name: 'wmux.exe', commandLine: MAIN_CMD },
        { pid: 1000, mainPid: 1000, daemonPid: 4242 },
      ),
    ).toBe('main');
  });

  it('daemon pid match wins even over a --type flag (defensive ordering)', () => {
    // A daemon should never carry --type, but if a recycled pid ever did, the
    // pid-file identity must still win.
    expect(
      classifyProcess(
        { name: 'wmux.exe', commandLine: RENDERER_CMD },
        { pid: 4242, daemonPid: 4242 },
      ),
    ).toBe('daemon');
  });
});

describe('classifyProcess — conhost and fallback', () => {
  it('buckets conhost.exe as conhost (ConPTY host)', () => {
    expect(classifyProcess({ name: 'conhost.exe', commandLine: null })).toBe('conhost');
  });

  it('buckets a user shell as other', () => {
    expect(classifyProcess({ name: 'powershell.exe', commandLine: 'powershell.exe -NoLogo' })).toBe('other');
  });

  it('buckets an unknown process with a null command line as other', () => {
    expect(classifyProcess({ name: 'crashpad_handler.exe', commandLine: null })).toBe('other');
  });

  it('treats a typeless electron.exe (dev build) as main', () => {
    expect(classifyProcess({ name: 'electron.exe', commandLine: '"C:\\electron.exe"' })).toBe('main');
  });

  it('handles a missing/empty row without throwing', () => {
    expect(classifyProcess({})).toBe('other');
    expect(classifyProcess({ name: undefined, commandLine: undefined })).toBe('other');
  });
});

describe('accumulateBreakdown — folding rows into category totals', () => {
  const rows = [
    { pid: 1000, name: 'wmux.exe', commandLine: MAIN_CMD, workingSetBytes: 100, commitBytes: 50 },
    { pid: 1001, name: 'wmux.exe', commandLine: RENDERER_CMD, workingSetBytes: 200, commitBytes: 80 },
    { pid: 1002, name: 'wmux.exe', commandLine: RENDERER_CMD, workingSetBytes: 210, commitBytes: 90 },
    { pid: 1003, name: 'wmux.exe', commandLine: GPU_CMD, workingSetBytes: 300, commitBytes: 120 },
    { pid: 1004, name: 'wmux.exe', commandLine: UTILITY_CMD, workingSetBytes: 40, commitBytes: 20 },
    { pid: 4242, name: 'wmux.exe', commandLine: MAIN_CMD, workingSetBytes: 60, commitBytes: 30 },
    { pid: 5000, name: 'conhost.exe', commandLine: null, workingSetBytes: 25, commitBytes: 10 },
    { pid: 6000, name: 'powershell.exe', commandLine: 'powershell.exe', workingSetBytes: 70, commitBytes: 35 },
  ];

  it('produces every category key (zeroed when empty) for a stable JSON shape', () => {
    const b = accumulateBreakdown([], {});
    for (const cat of RAM_CATEGORIES) {
      expect(b[cat]).toEqual({ workingSetBytes: 0, commitBytes: 0, processCount: 0 });
    }
  });

  it('attributes working set + commit + count per category', () => {
    const b = accumulateBreakdown(rows, { mainPid: 1000, daemonPid: 4242 });
    expect(b.main).toEqual({ workingSetBytes: 100, commitBytes: 50, processCount: 1 });
    expect(b.renderer).toEqual({ workingSetBytes: 410, commitBytes: 170, processCount: 2 });
    expect(b.gpu).toEqual({ workingSetBytes: 300, commitBytes: 120, processCount: 1 });
    expect(b.utility).toEqual({ workingSetBytes: 40, commitBytes: 20, processCount: 1 });
    expect(b.daemon).toEqual({ workingSetBytes: 60, commitBytes: 30, processCount: 1 });
    expect(b.conhost).toEqual({ workingSetBytes: 25, commitBytes: 10, processCount: 1 });
    expect(b.other).toEqual({ workingSetBytes: 70, commitBytes: 35, processCount: 1 });
  });

  it('reconciles exactly to the flat working-set / commit totals', () => {
    const b = accumulateBreakdown(rows, { mainPid: 1000, daemonPid: 4242 });
    const flatWs = rows.reduce((a, r) => a + r.workingSetBytes, 0);
    const flatCommit = rows.reduce((a, r) => a + r.commitBytes, 0);
    const sumWs = RAM_CATEGORIES.reduce((a, c) => a + b[c].workingSetBytes, 0);
    const sumCommit = RAM_CATEGORIES.reduce((a, c) => a + b[c].commitBytes, 0);
    expect(sumWs).toBe(flatWs);
    expect(sumCommit).toBe(flatCommit);
  });
});

describe('accumulateBreakdown — commandLineNullCount (P2-1 skew signal)', () => {
  // All command lines readable: main + two renderers + a conhost.
  const readableRows = [
    { pid: 1000, name: 'wmux.exe', commandLine: MAIN_CMD, workingSetBytes: 100, commitBytes: 50 },
    { pid: 1001, name: 'wmux.exe', commandLine: RENDERER_CMD, workingSetBytes: 200, commitBytes: 80 },
    { pid: 1002, name: 'wmux.exe', commandLine: RENDERER_CMD, workingSetBytes: 210, commitBytes: 90 },
    { pid: 5000, name: 'conhost.exe', commandLine: null, workingSetBytes: 25, commitBytes: 10 },
  ];

  it('exposes the field as 0 for an all-readable tree', () => {
    const b = accumulateBreakdown(readableRows, { mainPid: 1000, daemonPid: 4242 });
    expect(b.commandLineNullCount).toBe(0);
  });

  it('exposes the field as 0 on an empty tree (stable JSON shape)', () => {
    expect(accumulateBreakdown([], {}).commandLineNullCount).toBe(0);
  });

  it('counts a typeless wmux.exe child whose CommandLine CIM could not read', () => {
    // CIM null CommandLine → no --type token → silently folded into `main`.
    // The count surfaces that the main attribution may be inflated.
    const skewed = [
      { pid: 1000, name: 'wmux.exe', commandLine: MAIN_CMD, workingSetBytes: 100, commitBytes: 50 },
      { pid: 2000, name: 'wmux.exe', commandLine: null, workingSetBytes: 180, commitBytes: 70 },
      { pid: 2001, name: 'wmux.exe', commandLine: undefined, workingSetBytes: 150, commitBytes: 60 },
      { pid: 2002, name: 'wmux.exe', commandLine: '   ', workingSetBytes: 90, commitBytes: 40 },
    ];
    const b = accumulateBreakdown(skewed, { mainPid: 1000 });
    // All three unreadable rows fall into `main` alongside the genuine main.
    expect(b.main.processCount).toBe(4);
    expect(b.commandLineNullCount).toBe(3);
  });

  it('does NOT count the daemon — its null command line is pinned by pid', () => {
    // The daemon shares the wmux.exe image with a null/typeless command line,
    // but it is bucketed authoritatively by pid, so it is not a skew risk.
    const withDaemon = [
      { pid: 1000, name: 'wmux.exe', commandLine: MAIN_CMD, workingSetBytes: 100, commitBytes: 50 },
      { pid: 4242, name: 'wmux.exe', commandLine: null, workingSetBytes: 60, commitBytes: 30 },
    ];
    const b = accumulateBreakdown(withDaemon, { mainPid: 1000, daemonPid: 4242 });
    expect(b.daemon.processCount).toBe(1);
    expect(b.commandLineNullCount).toBe(0);
  });

  it('does NOT count a non-wmux process with a null command line', () => {
    // A null command line on conhost/crashpad is bucketed by name, not skew.
    const b = accumulateBreakdown(
      [{ pid: 5000, name: 'conhost.exe', commandLine: null, workingSetBytes: 25, commitBytes: 10 }],
      {},
    );
    expect(b.commandLineNullCount).toBe(0);
  });

  it('keeps the bucket-sum invariant intact even with the additive count present', () => {
    // commandLineNullCount must not participate in the working-set/commit sums.
    const skewed = [
      { pid: 1000, name: 'wmux.exe', commandLine: MAIN_CMD, workingSetBytes: 100, commitBytes: 50 },
      { pid: 2000, name: 'wmux.exe', commandLine: null, workingSetBytes: 180, commitBytes: 70 },
      { pid: 5000, name: 'conhost.exe', commandLine: null, workingSetBytes: 25, commitBytes: 10 },
    ];
    const b = accumulateBreakdown(skewed, { mainPid: 1000 });
    const flatWs = skewed.reduce((a, r) => a + r.workingSetBytes, 0);
    const flatCommit = skewed.reduce((a, r) => a + r.commitBytes, 0);
    const sumWs = RAM_CATEGORIES.reduce((a, c) => a + b[c].workingSetBytes, 0);
    const sumCommit = RAM_CATEGORIES.reduce((a, c) => a + b[c].commitBytes, 0);
    expect(sumWs).toBe(flatWs);
    expect(sumCommit).toBe(flatCommit);
    expect(b.commandLineNullCount).toBe(1);
  });
});
