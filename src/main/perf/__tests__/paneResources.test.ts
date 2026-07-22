import { describe, it, expect } from 'vitest';
import {
  aggregatePaneResources,
  parseCimCsv,
  type ProcSnapshot,
} from '../paneResources';

const MB = 1024 * 1024;

function snap(rows: Array<[number, number, number, string]>): ProcSnapshot {
  const m: ProcSnapshot = new Map();
  for (const [pid, ppid, rss, name] of rows) m.set(pid, { ppid, rss, name });
  return m;
}

describe('aggregatePaneResources', () => {
  it('sums the shell PID plus its whole descendant tree', () => {
    // 100 = pwsh shell, 200 = claude (child), 300 = node (grandchild via claude)
    const snapshot = snap([
      [100, 1, 10 * MB, 'pwsh.exe'],
      [200, 100, 300 * MB, 'claude.exe'],
      [300, 200, 60 * MB, 'node.exe'],
      // Unrelated process — must NOT be attributed to the pane.
      [999, 1, 500 * MB, 'chrome.exe'],
    ]);
    const out = aggregatePaneResources(snapshot, new Map([['pty-a', 100]]));
    expect(out['pty-a'].rss).toBe((10 + 300 + 60) * MB);
    // Dominant DESCENDANT (not the shell) is claude.exe.
    expect(out['pty-a'].image).toBe('claude.exe');
  });

  it('picks the single heaviest descendant as the label, excluding the shell', () => {
    // Shell itself is huge, but the chip should name the heaviest CHILD.
    const snapshot = snap([
      [100, 1, 900 * MB, 'pwsh.exe'],
      [200, 100, 120 * MB, 'node.exe'],
      [300, 100, 370 * MB, 'claude.exe'],
    ]);
    const out = aggregatePaneResources(snapshot, new Map([['pty-a', 100]]));
    expect(out['pty-a'].rss).toBe((900 + 120 + 370) * MB);
    expect(out['pty-a'].image).toBe('claude.exe');
  });

  it('is cycle-safe: a PID whose parent points back at a descendant terminates', () => {
    // 100 -> 200 -> 300 -> (300's child claims to be 200 again = cycle)
    const snapshot = snap([
      [100, 1, 10 * MB, 'pwsh.exe'],
      [200, 100, 20 * MB, 'claude.exe'],
      [300, 200, 30 * MB, 'node.exe'],
      // 400 is a child of 300 but its own ppid ALSO makes 200 look like 400's
      // child via a corrupt back-edge; the visited-set must stop the walk.
      [400, 300, 40 * MB, 'python.exe'],
    ]);
    // Inject a real cycle: make 200 also a "child" of 400 by adding a phantom
    // adjacency — simulate by pointing 200's ppid consideration. We model the
    // cycle directly: 500 <-> 600.
    snapshot.set(500, { ppid: 600, rss: 5 * MB, name: 'a.exe' });
    snapshot.set(600, { ppid: 500, rss: 6 * MB, name: 'b.exe' });

    const out = aggregatePaneResources(
      snapshot,
      new Map([
        ['pty-a', 100],
        ['pty-cycle', 500],
      ]),
    );
    // Linear tree still fully summed.
    expect(out['pty-a'].rss).toBe((10 + 20 + 30 + 40) * MB);
    // Cycle walk terminates and sums each node exactly once (500 + 600).
    expect(out['pty-cycle'].rss).toBe((5 + 6) * MB);
    expect(out['pty-cycle'].image).toBe('b.exe'); // heaviest descendant of 500
  });

  it('orphan case: a root PID absent from the snapshot yields rss 0 and no image', () => {
    const snapshot = snap([[100, 1, 10 * MB, 'pwsh.exe']]);
    const out = aggregatePaneResources(snapshot, new Map([['pty-gone', 4242]]));
    expect(out['pty-gone']).toEqual({ rss: 0 });
    expect(out['pty-gone'].image).toBeUndefined();
  });

  it('shell with no descendants: rss is the shell only, no image', () => {
    const snapshot = snap([[100, 1, 12 * MB, 'pwsh.exe']]);
    const out = aggregatePaneResources(snapshot, new Map([['pty-a', 100]]));
    expect(out['pty-a']).toEqual({ rss: 12 * MB });
  });

  it('attributes multiple panes independently from one snapshot', () => {
    const snapshot = snap([
      [100, 1, 10 * MB, 'pwsh.exe'],
      [200, 100, 300 * MB, 'claude.exe'],
      [101, 1, 10 * MB, 'bash.exe'],
      [201, 101, 80 * MB, 'node.exe'],
    ]);
    const out = aggregatePaneResources(
      snapshot,
      new Map([
        ['pty-a', 100],
        ['pty-b', 101],
      ]),
    );
    expect(out['pty-a'].rss).toBe((10 + 300) * MB);
    expect(out['pty-a'].image).toBe('claude.exe');
    expect(out['pty-b'].rss).toBe((10 + 80) * MB);
    expect(out['pty-b'].image).toBe('node.exe');
  });
});

describe('parseCimCsv', () => {
  it('parses the ConvertTo-Csv projection into a PID map (by header name)', () => {
    const csv = [
      '"ProcessId","ParentProcessId","WorkingSetSize","Name"',
      '"100","4","10485760","pwsh.exe"',
      '"200","100","314572800","claude.exe"',
    ].join('\r\n');
    const m = parseCimCsv(csv);
    expect(m.size).toBe(2);
    expect(m.get(100)).toEqual({ ppid: 4, rss: 10485760, name: 'pwsh.exe' });
    expect(m.get(200)!.name).toBe('claude.exe');
  });

  it('honors column reorder (parses by header name, not position)', () => {
    const csv = [
      '"Name","WorkingSetSize","ProcessId","ParentProcessId"',
      '"claude.exe","314572800","200","100"',
    ].join('\n');
    const m = parseCimCsv(csv);
    expect(m.get(200)).toEqual({ ppid: 100, rss: 314572800, name: 'claude.exe' });
  });

  it('skips rows with an unparseable ProcessId and empty input', () => {
    expect(parseCimCsv('').size).toBe(0);
    const csv = [
      '"ProcessId","ParentProcessId","WorkingSetSize","Name"',
      '"","4","10","x.exe"',
      '"300","4","20","y.exe"',
    ].join('\n');
    const m = parseCimCsv(csv);
    expect(m.size).toBe(1);
    expect(m.has(300)).toBe(true);
  });
});
