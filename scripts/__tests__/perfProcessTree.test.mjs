// Pure-logic tests for the A1 RAM process-tree walk
// (scripts/perf-process-tree.mjs, issue #570). No packaged app, no CIM, no
// pipes — collected by `npm test` via scripts/__tests__/**/*.test.mjs and safe
// on CI. Mirrors the perfProcessClassify.test.mjs convention: import the pure
// module, feed it mock CIM rows, assert what the walk collects and rejects.
import { describe, it, expect } from 'vitest';
import {
  parseCimDate,
  collectProcessTree,
  looksLikeDaemonRow,
} from '../perf-process-tree.mjs';

// Rows are shaped like the `Get-CimInstance Win32_Process | ConvertTo-Json`
// output snapshotProcesses() feeds in: PascalCase fields, CreationDate in the
// legacy `/Date(ms)/` form PowerShell 5.1 emits.
const T0 = 1_784_777_000_000;
function row(pid, ppid, name, createdOffsetMs, extra = {}) {
  return {
    ProcessId: pid,
    ParentProcessId: ppid,
    Name: name,
    CreationDate: `/Date(${T0 + createdOffsetMs})/`,
    ...extra,
  };
}

describe('parseCimDate', () => {
  it('parses the PowerShell 5.1 /Date(ms)/ form', () => {
    expect(parseCimDate('/Date(1784777530054)/')).toBe(1784777530054);
  });

  it('accepts a raw epoch number, a Date, and an ISO string', () => {
    expect(parseCimDate(1784777530054)).toBe(1784777530054);
    expect(parseCimDate(new Date(1784777530054))).toBe(1784777530054);
    expect(parseCimDate('2026-07-23T21:04:55.902Z')).toBe(Date.parse('2026-07-23T21:04:55.902Z'));
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseCimDate(null)).toBeNull();
    expect(parseCimDate(undefined)).toBeNull();
    expect(parseCimDate('not a date')).toBeNull();
    expect(parseCimDate('/Date(abc)/')).toBeNull();
  });
});

describe('collectProcessTree — healthy tree', () => {
  // main → renderer/gpu, main → shell → conhost. Every child is created after
  // its parent, which is what a real spawn chain always looks like.
  const rows = [
    row(100, 8, 'wmux.exe', 0),
    row(101, 100, 'wmux.exe', 10),
    row(102, 100, 'wmux.exe', 20),
    row(103, 100, 'pwsh.exe', 30),
    row(104, 103, 'conhost.exe', 40),
    row(900, 8, 'unrelated.exe', 5),
  ];

  it('collects the whole tree and nothing outside it', () => {
    const t = collectProcessTree(rows, [100]);
    expect([...t.pids].sort((a, b) => a - b)).toEqual([100, 101, 102, 103, 104]);
    expect(t.rejectedEdgeCount).toBe(0);
    expect(t.rejectedEdges).toEqual([]);
    expect(t.unresolvedRoots).toEqual([]);
  });

  it('accepts a child created in the same millisecond as its parent', () => {
    // Spawn latency can round to zero at CIM's millisecond resolution, so the
    // invariant has to be >=, not >.
    const sameMs = [row(200, 8, 'wmux.exe', 0), row(201, 200, 'wmux.exe', 0)];
    const t = collectProcessTree(sameMs, [200]);
    expect(t.pids.has(201)).toBe(true);
    expect(t.rejectedEdgeCount).toBe(0);
  });

  it('merges multiple roots without double counting', () => {
    const t = collectProcessTree(rows, [100, 103]);
    expect(t.pids.size).toBe(5);
  });
});

describe('collectProcessTree — stale-pid contamination (issue #570)', () => {
  // The #569 shape: our app got pid 100, which the OS had recycled from a
  // long-dead process. Process 500 — created BEFORE 100 existed — still points
  // at 100 as its parent, and drags a 2-deep subtree behind it.
  const rows = [
    row(100, 8, 'wmux.exe', 1000),
    row(101, 100, 'wmux.exe', 1010),
    row(500, 100, 'svchost.exe', 5),
    row(501, 500, 'svchost.exe', 6),
    row(502, 501, 'MsMpEng.exe', 7),
  ];

  it('rejects the phantom edge and everything hanging off it', () => {
    const t = collectProcessTree(rows, [100]);
    expect([...t.pids].sort((a, b) => a - b)).toEqual([100, 101]);
    expect(t.pids.has(500)).toBe(false);
    expect(t.pids.has(502)).toBe(false); // the subtree goes with the edge
  });

  it('reports the rejection with enough detail to diagnose', () => {
    const t = collectProcessTree(rows, [100]);
    expect(t.rejectedEdgeCount).toBe(1);
    expect(t.rejectedEdges).toEqual([
      {
        pid: 500,
        name: 'svchost.exe',
        parentPid: 100,
        parentName: 'wmux.exe',
        skewMs: -995,
      },
    ]);
  });

  it('carries no CommandLine into the forensic sample', () => {
    const withCmd = [
      row(100, 8, 'wmux.exe', 1000),
      row(500, 100, 'svchost.exe', 5, { CommandLine: 'C:\\secret\\thing.exe --token=abc' }),
    ];
    const t = collectProcessTree(withCmd, [100]);
    expect(t.rejectedEdges[0]).not.toHaveProperty('commandLine');
    expect(JSON.stringify(t.rejectedEdges)).not.toContain('token');
  });

  it('caps the forensic sample but keeps the full count', () => {
    const many = [row(100, 8, 'wmux.exe', 1000)];
    for (let i = 0; i < 25; i += 1) many.push(row(500 + i, 100, 'svchost.exe', 5));
    const t = collectProcessTree(many, [100]);
    expect(t.rejectedEdgeCount).toBe(25);
    expect(t.rejectedEdges).toHaveLength(10);
  });
});

describe('collectProcessTree — undatable and degenerate rows', () => {
  it('fails closed on an edge it cannot date', () => {
    // Trusting an undatable edge is exactly the behaviour that let the foreign
    // subtree in, so a missing timestamp must reject, not wave through.
    const rows = [
      row(100, 8, 'wmux.exe', 0),
      { ProcessId: 101, ParentProcessId: 100, Name: 'mystery.exe', CreationDate: null },
      row(102, 100, 'wmux.exe', 10),
    ];
    const t = collectProcessTree(rows, [100]);
    expect(t.pids.has(101)).toBe(false);
    expect(t.pids.has(102)).toBe(true);
    expect(t.rejectedEdgeCount).toBe(1);
    expect(t.rejectedEdges[0].skewMs).toBeNull();
  });

  it('rejects children of a parent whose own timestamp is unreadable', () => {
    const rows = [
      { ProcessId: 100, ParentProcessId: 8, Name: 'wmux.exe', CreationDate: 'garbage' },
      row(101, 100, 'wmux.exe', 10),
    ];
    const t = collectProcessTree(rows, [100]);
    expect([...t.pids]).toEqual([100]); // the root itself still counts
    expect(t.rejectedEdgeCount).toBe(1);
  });

  it('does not loop on a self-parented row', () => {
    const rows = [{ ProcessId: 0, ParentProcessId: 0, Name: 'System Idle Process', CreationDate: `/Date(${T0})/` }];
    const t = collectProcessTree(rows, [0]);
    expect([...t.pids]).toEqual([0]);
    expect(t.rejectedEdgeCount).toBe(0); // a self-edge is not a contamination signal
  });

  it('survives a parent/child cycle without hanging', () => {
    const rows = [row(100, 101, 'a.exe', 0), row(101, 100, 'b.exe', 10)];
    const t = collectProcessTree(rows, [100]);
    expect(t.pids.size).toBe(2);
  });

  it('reports roots that are absent from the snapshot', () => {
    const rows = [row(100, 8, 'wmux.exe', 0)];
    const t = collectProcessTree(rows, [100, 777]);
    expect(t.unresolvedRoots).toEqual([777]);
    expect(t.pids.has(100)).toBe(true);
  });

  it('collects nothing when no root resolves', () => {
    const t = collectProcessTree([row(100, 8, 'wmux.exe', 0)], [777]);
    expect(t.pids.size).toBe(0);
    expect(t.unresolvedRoots).toEqual([777]);
  });
});

describe('looksLikeDaemonRow', () => {
  const main = { ProcessId: 100, Name: 'wmux.exe' };

  it('accepts a daemon sharing the packaged app image', () => {
    expect(looksLikeDaemonRow({ Name: 'wmux.exe', CommandLine: null }, main)).toBe(true);
  });

  it('accepts a dev-shape node daemon by its command line', () => {
    expect(looksLikeDaemonRow(
      { Name: 'node.exe', CommandLine: 'node C:\\wmux\\out\\daemon\\index.js' },
      main,
    )).toBe(true);
  });

  it('rejects a recycled pid that landed on a system process', () => {
    expect(looksLikeDaemonRow({ Name: 'svchost.exe', CommandLine: null }, main)).toBe(false);
    expect(looksLikeDaemonRow({ Name: 'node.exe', CommandLine: 'node build.js' }, main)).toBe(false);
  });

  it('rejects a missing or nameless row', () => {
    expect(looksLikeDaemonRow(undefined, main)).toBe(false);
    expect(looksLikeDaemonRow({ Name: '' }, main)).toBe(false);
  });

  it('still matches a wmux image when the main row is unavailable', () => {
    expect(looksLikeDaemonRow({ Name: 'wmux.exe' }, undefined)).toBe(true);
  });
});
