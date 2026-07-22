/**
 * TASK-6 — Per-pane agent resource attribution (Fleet View chips).
 *
 * The agent process tier (claude.exe / node.exe children of a pane's shell) is
 * the majority of private RAM yet was invisible in the cockpit. This module
 * attributes RAM back to the pane that owns it so a Fleet card can read
 * "Claude: 370 MB".
 *
 * Binding decisions (execution plan D5, 2026-07-23):
 *   - Data source: ONE `Get-CimInstance Win32_Process` snapshot per tick — the
 *     whole process table (ProcessId, ParentProcessId, WorkingSetSize, Name) in
 *     a single call. `tasklist` is forbidden (no PPID, no machine-readable RSS).
 *   - Polling is Fleet-View-gated in the renderer; this module is only invoked
 *     while the cockpit is visible. It does no polling of its own.
 *   - RAM only. `Win32_Process` exposes cumulative CPU time, not a percentage
 *     (% needs two samples) — CPU is a later pass.
 *   - Non-Windows: fail soft (empty snapshot → no chips), never throw.
 */

/** One row of the process-table snapshot. */
export interface ProcSnapshotEntry {
  ppid: number;
  /** Working-set size in bytes (Win32_Process.WorkingSetSize). */
  rss: number;
  /** Image name, e.g. "claude.exe" / "node.exe". */
  name: string;
}

/** PID → snapshot row. The single source the tree-walk consumes. */
export type ProcSnapshot = Map<number, ProcSnapshotEntry>;

/** Attributed resources for one pane. */
export interface PaneResources {
  /** Summed working-set of the shell PID + its whole descendant tree, in bytes. */
  rss: number;
  /**
   * Image name of the single heaviest descendant process (by its own RSS,
   * excluding the shell itself) — the "who is heavy" label (e.g. "claude.exe").
   * Undefined when the shell has no descendants.
   */
  image?: string;
}

/**
 * Pure aggregation core (unit-tested). For each pane root PID, BFS over the
 * child map and sum every descendant's RSS (plus the root's own). Also records
 * the dominant descendant image — the heaviest single non-root process in the
 * tree, which is what the chip labels.
 *
 * Cycle-safe: a `visited` set guards against a PID map that (through PID reuse
 * or a corrupt snapshot) points a child back at an ancestor. Orphan-safe: a
 * root PID absent from the snapshot yields `{ rss: 0 }` — the pane simply shows
 * no chip rather than crashing the tick.
 *
 * @param snapshot   PID → { ppid, rss, name } for the whole machine.
 * @param paneRoots  ptyId → shell PID (the pane's own PTY process).
 */
export function aggregatePaneResources(
  snapshot: ProcSnapshot,
  paneRoots: Map<string, number>,
): Record<string, PaneResources> {
  // Build a child adjacency list once (ppid → child pids). O(N) over the table,
  // reused across every pane so N panes cost O(N + table), not O(N × table).
  const childrenOf = new Map<number, number[]>();
  for (const [pid, entry] of snapshot) {
    const siblings = childrenOf.get(entry.ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(entry.ppid, [pid]);
  }

  const out: Record<string, PaneResources> = {};
  for (const [ptyId, rootPid] of paneRoots) {
    let totalRss = 0;
    // Dominant DESCENDANT (exclude the shell root itself — we want the agent,
    // not the shell, on the chip).
    let heaviestRss = -1;
    let heaviestImage: string | undefined;

    const visited = new Set<number>();
    const queue: number[] = [rootPid];
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue; // cycle / diamond guard
      visited.add(pid);
      const entry = snapshot.get(pid);
      if (entry) {
        totalRss += entry.rss;
        if (pid !== rootPid && entry.rss > heaviestRss) {
          heaviestRss = entry.rss;
          heaviestImage = entry.name;
        }
      }
      const kids = childrenOf.get(pid);
      if (kids) {
        for (const kid of kids) {
          if (!visited.has(kid)) queue.push(kid);
        }
      }
    }

    out[ptyId] = heaviestImage ? { rss: totalRss, image: heaviestImage } : { rss: totalRss };
  }
  return out;
}

/**
 * Parse the CSV emitted by `ConvertTo-Csv -NoTypeInformation` for the four
 * projected columns into a {@link ProcSnapshot}. Pure so it can be unit-tested
 * against a captured fixture without spawning PowerShell.
 *
 * Header row order is honored by name (not position) so a PowerShell property
 * reorder can't silently misparse. Rows with an unparseable ProcessId are
 * skipped (defensive — a truncated snapshot degrades to fewer panes attributed,
 * never a crash).
 */
export function parseCimCsv(csv: string): ProcSnapshot {
  const snapshot: ProcSnapshot = new Map();
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return snapshot;

  const header = splitCsvLine(lines[0]).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const idxPid = header.indexOf('processid');
  const idxPpid = header.indexOf('parentprocessid');
  const idxRss = header.indexOf('workingsetsize');
  const idxName = header.indexOf('name');
  if (idxPid < 0 || idxPpid < 0 || idxRss < 0 || idxName < 0) return snapshot;

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const pid = parseInt(cols[idxPid], 10);
    if (isNaN(pid)) continue;
    const ppid = parseInt(cols[idxPpid], 10);
    const rss = parseInt(cols[idxRss], 10);
    const name = (cols[idxName] ?? '').trim();
    snapshot.set(pid, {
      ppid: isNaN(ppid) ? 0 : ppid,
      rss: isNaN(rss) ? 0 : rss,
      name,
    });
  }
  return snapshot;
}

/**
 * Minimal CSV field splitter for `ConvertTo-Csv` output: comma-separated,
 * double-quoted fields, `""` escaping an inner quote. Process names can contain
 * commas in theory, so a naive `split(',')` is unsafe.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// How many snapshots have been taken this process lifetime — surfaced in the
// debug log so a QA run can assert ZERO snapshots fired while Fleet View was
// closed (the plan's polling-gate acceptance criterion).
let snapshotCount = 0;

/** Test-only reset for the snapshot counter. */
export function __resetSnapshotCountForTest(): void {
  snapshotCount = 0;
}

/**
 * Take ONE `Win32_Process` snapshot of the whole machine via async execFile of
 * powershell.exe (mirrors getParentPid's style: -NoProfile, windowsHide,
 * timeout, async not sync). Returns an empty snapshot on non-Windows or on any
 * failure — the caller then renders no chips (fail-soft).
 */
export async function snapshotProcesses(): Promise<ProcSnapshot> {
  if (process.platform !== 'win32') return new Map();
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const path = await import('path');
    const execFileAsync = promisify(execFile);
    const ps = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    // ONE call returns the whole process table. ConvertTo-Csv gives a stable,
    // locale-independent, machine-readable projection (WorkingSetSize is raw
    // bytes, unlike tasklist's locale-formatted MEM column).
    const command =
      'Get-CimInstance Win32_Process | ' +
      'Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ' +
      'ConvertTo-Csv -NoTypeInformation';
    const { stdout } = await execFileAsync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      // The whole process table on a busy machine can exceed the default 1 MB
      // stdout cap; give it room so a large table isn't truncated mid-row.
      maxBuffer: 16 * 1024 * 1024,
    });
    snapshotCount++;
    // eslint-disable-next-line no-console
    console.debug(`[perf] pane-resources CIM snapshot #${snapshotCount} taken`);
    return parseCimCsv(stdout);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[perf] pane-resources snapshot failed:', err instanceof Error ? err.message : err);
    return new Map();
  }
}

/**
 * End-to-end: take one snapshot and attribute RAM to each pane root. This is the
 * function the IPC handler calls per tick (Fleet-View-gated by the renderer).
 *
 * @param paneRoots ptyId → shell PID.
 */
export async function collectPaneResources(
  paneRoots: Map<string, number>,
): Promise<Record<string, PaneResources>> {
  if (paneRoots.size === 0) return {};
  const snapshot = await snapshotProcesses();
  if (snapshot.size === 0) return {};
  return aggregatePaneResources(snapshot, paneRoots);
}
