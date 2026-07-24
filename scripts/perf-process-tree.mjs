// Pure process-tree collection for the A1 RAM scenario (perf-bench.mjs
// measureRam). Split into its own module — with NO shebang — so it can be
// imported by both perf-bench.mjs and a vitest test
// (scripts/__tests__/perfProcessTree.test.mjs). A leading shebang makes the
// Windows-CI vitest loader throw a SyntaxError (known repo gotcha — see the
// same note atop perf-compare.mjs), so this file must stay shebang-free.
//
// WHY THIS EXISTS (issue #570)
// ---------------------------------------------------------------------------
// measureRam() used to walk `ParentProcessId` links from the app + daemon pids
// and trust every edge. Windows does NOT reparent orphans and does NOT clear a
// dead process's ParentProcessId, so a process whose real parent exited keeps
// pointing at that stale pid forever. Once the OS recycles that pid onto one of
// OUR processes, the orphan (and its entire subtree) starts looking like our
// descendant, and the walk sums a foreign subtree into wmux's RAM total.
//
// This is not theoretical: the CI run that tripped the Perf gate on PR #569
// collected 157 processes instead of the usual ~25, and the extra 136 processes
// contributed 3.7 GB of working set while wmux's own buckets (main 114M /
// renderer 178M / gpu 120M / utility 43M / daemon 126M) were indistinguishable
// from a passing run. Working set and commit both scaled by the same ~2.4x, so
// the metric choice was never the problem — the tree membership was. A snapshot
// of an idle developer desktop (356 processes) still showed 4 such phantom
// edges live at that moment, so the failure mode is always armed and CI, which
// churns through thousands of short-lived processes, just hits it more often.
//
// THE INVARIANT WE ENFORCE
// ---------------------------------------------------------------------------
// A real child is always created AFTER (or in the same millisecond as) its
// parent — spawning requires a live parent. So an edge P → C where C's
// CreationDate predates P's cannot be a real parent/child link; it is a stale
// pid pointing at a recycled slot. Rejecting those edges (and, with them, the
// subtree hanging off them) removes the contamination deterministically instead
// of statistically. Win32_Process.CreationDate is readable for every row —
// unlike CommandLine, it is not access-gated — so the check is never a coin
// flip: all 356 rows of the desktop snapshot above carried a timestamp.

/** Sample caps for the forensic fields — enough to diagnose, small in JSON. */
const REJECTED_SAMPLE_CAP = 10;

/**
 * Parse a Win32_Process CreationDate into epoch milliseconds.
 *
 * PowerShell 5.1's `ConvertTo-Json` serializes a CIM DATETIME as the legacy
 * ASP.NET form `/Date(1784777530054)/`. Other shapes are accepted defensively
 * (a raw epoch number, a Date, an ISO string) so a future switch to
 * `pwsh -OutputFormat json` or `Get-Process` cannot silently break the guard —
 * an unparseable value returns null, and callers treat null as "cannot
 * validate", which is a rejection rather than a free pass.
 *
 * @param {unknown} value
 * @returns {number|null} epoch ms, or null when it cannot be parsed.
 */
export function parseCimDate(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const s = String(value);
  const legacy = /^\/Date\((-?\d+)/.exec(s);
  if (legacy) {
    const n = Number(legacy[1]);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Collect the process tree reachable from `roots`, rejecting parent/child edges
 * that violate the creation-time invariant described at the top of this file.
 *
 * Rows are raw CIM records exactly as `snapshotProcesses()` returns them
 * (ProcessId / ParentProcessId / Name / CreationDate, plus whatever else the
 * caller selected) — the `/Date(...)/` parsing lives here so the bench does not
 * have to pre-normalize.
 *
 * @param {Array<object>} rows      Win32_Process snapshot rows.
 * @param {number[]} roots          Pids to start from (app main exe, daemon).
 * @returns {{
 *   pids: Set<number>,
 *   rejectedEdgeCount: number,
 *   rejectedEdges: Array<{pid:number,name:string,parentPid:number,
 *                         parentName:string,skewMs:number|null}>,
 *   unresolvedRoots: number[],
 * }}
 *   pids               — the validated tree (always includes the resolved roots).
 *   rejectedEdgeCount  — how many edges the invariant threw out (0 on a clean
 *                        run; a nonzero count is the contamination signal).
 *   rejectedEdges      — a capped sample of them, for the artifact JSON. Names
 *                        only — CommandLine is deliberately NOT carried here,
 *                        since it can hold paths and tokens.
 *   unresolvedRoots    — roots absent from the snapshot (already exited, or a
 *                        stale pid file).
 */
export function collectProcessTree(rows, roots) {
  const byPid = new Map();
  const byParent = new Map();
  for (const p of rows) {
    byPid.set(p.ProcessId, p);
    if (!byParent.has(p.ParentProcessId)) byParent.set(p.ParentProcessId, []);
    byParent.get(p.ParentProcessId).push(p);
  }

  const pids = new Set();
  const queue = [];
  const unresolvedRoots = [];
  for (const pid of roots) {
    if (byPid.has(pid)) queue.push(pid);
    else unresolvedRoots.push(pid);
  }

  const rejectedEdges = [];
  let rejectedEdgeCount = 0;
  while (queue.length) {
    const pid = queue.shift();
    if (pids.has(pid)) continue;
    pids.add(pid);
    const parent = byPid.get(pid);
    const parentCreated = parseCimDate(parent.CreationDate);
    for (const child of byParent.get(pid) ?? []) {
      // Self-parented rows exist (pid 0 lists itself as its own parent); the
      // `pids` guard already covers re-entry, but skipping early keeps such a
      // row from being logged as a rejected edge against itself.
      if (child.ProcessId === pid) continue;
      if (pids.has(child.ProcessId)) continue;
      const childCreated = parseCimDate(child.CreationDate);
      // Fail CLOSED: an edge we cannot date is an edge we cannot trust. Letting
      // it through is exactly the behaviour that produced the #569 false red.
      const trusted =
        parentCreated != null && childCreated != null && childCreated >= parentCreated;
      if (!trusted) {
        rejectedEdgeCount += 1;
        if (rejectedEdges.length < REJECTED_SAMPLE_CAP) {
          rejectedEdges.push({
            pid: child.ProcessId,
            name: String(child.Name ?? ''),
            parentPid: pid,
            parentName: String(parent.Name ?? ''),
            skewMs:
              parentCreated != null && childCreated != null
                ? childCreated - parentCreated
                : null,
          });
        }
        continue; // and, with it, the whole subtree hanging off this edge
      }
      queue.push(child.ProcessId);
    }
  }

  return { pids, rejectedEdgeCount, rejectedEdges, unresolvedRoots };
}

/**
 * Is this snapshot row plausibly OUR daemon?
 *
 * The daemon pid comes from a pid file in the bench's isolated temp home, and
 * measureRam() feeds it in as a SECOND tree root — so a stale pid file that now
 * points at a recycled slot would graft an arbitrary foreign subtree onto the
 * measurement before the per-edge guard ever gets a say (the guard validates
 * edges, not roots). perf-bench already runs an equivalent identity check
 * before the fallback SIGKILL (`pidLooksLikeWmuxDaemon`); this is the same idea
 * on the measurement path, answered from the snapshot we already have instead
 * of spawning another PowerShell.
 *
 * Matching is by image name only. The daemon shares the packaged app's image
 * (wmux.exe) and, per the classifier's notes, frequently reports a null
 * CommandLine — so requiring a "daemon" token on the command line would reject
 * the real daemon. A node.exe daemon (dev shape) is accepted when its command
 * line does name a daemon entry.
 *
 * @param {object|undefined} row      Snapshot row for the candidate pid.
 * @param {object|undefined} mainRow  Snapshot row for the app's main exe.
 * @returns {boolean}
 */
export function looksLikeDaemonRow(row, mainRow) {
  if (!row) return false;
  const name = String(row.Name ?? '').toLowerCase();
  if (!name) return false;
  const mainName = String(mainRow?.Name ?? '').toLowerCase();
  if (mainName && name === mainName) return true; // packaged: daemon shares wmux.exe
  if (name.includes('wmux')) return true;
  const cmd = String(row.CommandLine ?? '').toLowerCase();
  return name === 'node.exe' && cmd.includes('daemon');
}
