// ---------------------------------------------------------------------------
// Line-level snapshot diff for browser_snapshot's auto-diff mode.
//
// Snapshots are one-line-per-node text (both the a11y serializer and the DOM
// listing), so a plain line LCS is sufficient — no dependency needed. Ref
// numbers are embedded in the line text, which is what makes diffing over
// renumber-prone refs sound: any renumbering surfaces as changed lines, and a
// small diff means the surviving refs are byte-identical and resolve the same.
// ---------------------------------------------------------------------------

// Bail out of the O(n·m) DP beyond this many lines per side (after common
// prefix/suffix trimming) — the caller then returns the full snapshot.
const MAX_DIFF_LINES = 2000;
// A diff at least this fraction of the full snapshot's size stops being a
// savings and starts being a harder-to-read full snapshot.
const DIFF_WORTHWHILE_RATIO = 0.5;

interface LineDiff {
  text: string;
  changedLines: number;
}

/**
 * Unified-style diff of two line-oriented texts, 1 context line per hunk.
 * Returns null when either side (after trimming the common prefix/suffix)
 * exceeds MAX_DIFF_LINES — the caller falls back to the full snapshot.
 */
export function diffSnapshotLines(prevText: string, nextText: string): LineDiff | null {
  const prev = prevText.split('\n');
  const next = nextText.split('\n');

  // Trim common prefix/suffix before the DP — typical act→verify snapshots
  // share almost everything, so this collapses the quadratic core to the
  // changed region.
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endP = prev.length;
  let endN = next.length;
  while (endP > start && endN > start && prev[endP - 1] === next[endN - 1]) {
    endP--;
    endN--;
  }

  const a = prev.slice(start, endP);
  const b = next.slice(start, endN);
  if (a.length === 0 && b.length === 0) {
    return { text: '(no changes since previous snapshot)', changedLines: 0 };
  }
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;

  // LCS DP over the trimmed middle.
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  // Walk the table into (-, +, ' ') ops over the trimmed region.
  type Op = { kind: '-' | '+' | ' '; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ kind: '-', line: a[i] });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] });
  while (j < m) ops.push({ kind: '+', line: b[j++] });

  // Group into hunks with 1 context line on each side. `start` offsets hunk
  // positions back into full-text line numbers (1-based, next-side).
  const out: string[] = [];
  let changedLines = 0;
  let k = 0;
  // Position in the NEXT text of the op at index k (advances on '+'/' ').
  let nextLine = start;
  while (k < ops.length) {
    if (ops[k].kind === ' ') {
      nextLine++;
      k++;
      continue;
    }
    // Hunk starts at the change; include one preceding context line if present.
    const hunkStartIdx = k > 0 && ops[k - 1].kind === ' ' ? k - 1 : k;
    const hunkHeaderLine = nextLine - (hunkStartIdx === k - 1 ? 1 : 0) + 1;
    const hunk: string[] = [];
    if (hunkStartIdx === k - 1) hunk.push(`  ${ops[k - 1].line}`);
    // Consume until we see 2 consecutive context lines (1 kept as trailing
    // context, the rest ends the hunk).
    while (k < ops.length) {
      const op = ops[k];
      if (op.kind === ' ') {
        const nextIsChange = ops[k + 1] && ops[k + 1].kind !== ' ';
        if (!nextIsChange) {
          hunk.push(`  ${op.line}`);
          nextLine++;
          k++;
          break;
        }
        hunk.push(`  ${op.line}`);
        nextLine++;
        k++;
        continue;
      }
      hunk.push(`${op.kind} ${op.line}`);
      changedLines++;
      if (op.kind !== '-') nextLine++;
      k++;
    }
    out.push(`@ line ${hunkHeaderLine}`);
    out.push(...hunk);
  }

  return { text: out.join('\n'), changedLines };
}

export interface FormattedSnapshot {
  text: string;
  usedDiff: boolean;
}

/**
 * Render a snapshot result: a diff against the baseline when one exists and
 * the diff is genuinely smaller (< DIFF_WORTHWHILE_RATIO of the full text),
 * else the full snapshot. The first line always declares which was returned.
 */
export function formatSnapshotResult(baseline: string | null, nextText: string): FormattedSnapshot {
  const full = { text: `[snapshot: full]\n${nextText}`, usedDiff: false };
  if (baseline === null || baseline === '') return full;
  const diff = diffSnapshotLines(baseline, nextText);
  if (!diff) return full;
  if (diff.changedLines > 0 && diff.text.length >= nextText.length * DIFF_WORTHWHILE_RATIO) {
    return full;
  }
  return {
    text:
      `[snapshot: diff vs previous — unchanged lines omitted; pass full:true for the complete tree]\n` +
      diff.text,
    usedDiff: true,
  };
}
