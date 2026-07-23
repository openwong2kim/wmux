// J2 — diff/hunk adoption: verbatim-preserving parser (spec §3)
//
// Design contract (pitfalls to avoid — spec §3·§7·§10 R1/R11):
//   - Preserve file header blocks (diff --git / index / mode / --- / +++) and hunk
//     bodies as "byte-for-byte originals". No lossy reconstruction.
//   - When reassembling selected hunks: reattach the original file header verbatim,
//     and recalculate only the hunk header line counts (@@ -a,b +c,d @@).
//   - `\ No newline at end of file` markers and CRLF pass through automatically via
//     body verbatim preservation.
//   - This parser does not trust itself — reserialization is verified with actual
//     `git apply` (round-trip oracle tests, R11). No parser self-consensus.
//
// v1 adoption scope: plain-text modify/add/delete only.
//   rename·copy·mode change·binary are display-only (file-level adoption unavailable label).

// diff total and per-file caps (spec §2). Excess → display-only label.
export const DIFF_TOTAL_CAP_BYTES = 2 * 1024 * 1024; // 2MB
export const DIFF_FILE_CAP_BYTES = 512 * 1024; // 512KB

// Parsed single hunk. body preserves the verbatim body after the hunk header (@@ line).
export interface DiffHunk {
  // Full original hunk header line (e.g. "@@ -1,3 +1,4 @@ func foo()"). No newline.
  readonly header: string;
  // Coordinates parsed from the header (for recalculation/validation).
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  // Trailing text after the hunk header (function context, etc.). Part after "@@ ... @@".
  readonly section: string;
  // Verbatim hunk body (each line prefixed with ' '/'+'/'-'/'\').
  // Each array element is a line without newline. Rejoined with '\n' on reserialization.
  readonly bodyLines: readonly string[];
}

// File-level adoptability classification.
export type FileChangeKind =
  | 'modify'
  | 'add'
  | 'delete'
  | 'rename'
  | 'copy'
  | 'mode'
  | 'binary';

// Parsed single-file diff.
export interface DiffFile {
  // Display/matching path (b/ side preferred; a/ side for delete).
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly kind: FileChangeKind;
  // Whether hunk-select adoption is allowed. true only for plain modify/add/delete.
  readonly hunkSelectable: boolean;
  // Verbatim file header block (diff --git through +++ lines, before first hunk header). Includes newlines.
  readonly headerBlock: string;
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly DiffFile[];
}

// ── diff:read / diff:applyHunks RPC contract (main↔renderer shared, spec §2·§3) ──

// Target repo snapshot (for drift gate, §2). applyHunks receives this back for revalidation.
export interface DiffTargetSnapshot {
  readonly targetRepoPath: string;
  readonly targetBranch: string;
  readonly targetHeadOid: string;
  readonly targetDirtyFiles: readonly string[];
}

// diff:read response. files is the parsed diff; snapshot is drift-gate material.
export interface DiffReadResult {
  readonly ok: true;
  readonly files: readonly DiffFile[];
  readonly numstat: readonly DiffNumstat[];
  readonly snapshot: DiffTargetSnapshot;
  // File paths that are display-only due to cap overflow, binary, etc. (user guidance).
  readonly truncated: readonly string[];
  // F3: non-regular files (symlink·FIFO, etc.) — cannot synthesize or adopt ("unsupported" label).
  //   Excluded from synthesis entirely to block out-of-repo exposure (symlink target readFile).
  readonly unsupported: readonly string[];
}

export interface DiffReadError {
  readonly ok: false;
  readonly error: string;
  readonly code?: string;
}

// One numstat line (for file tree display). binary → additions/deletions = null.
export interface DiffNumstat {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

// diff:applyHunks request. Snapshot is echoed back for drift revalidation (§3).
export interface DiffApplyRequest {
  readonly taskId: string;
  readonly snapshot: DiffTargetSnapshot;
  readonly selections: ReadonlyArray<{
    readonly path: string; // display path (repo-relative).
    readonly hunkIndices: readonly number[];
  }>;
}

// Per-hunk probe result (§3). applied is a --reverse --check best-effort badge.
export interface HunkProbe {
  readonly path: string;
  readonly hunkIndex: number;
  readonly applicable: boolean; // git apply --check succeeded
  readonly alreadyApplied: boolean; // git apply --reverse --check succeeded (best-effort)
}

export type DiffApplyResult =
  | { readonly ok: true; readonly appliedFiles: readonly string[] }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code:
        | 'drift' // target HEAD/branch moved
        | 'dirty' // target file dirty
        | 'probe' // per-hunk probe failed (see failedProbes)
        | 'apply' // final apply failed
        | 'path' // path validation failed (.. etc.)
        | 'unsupported'; // rename·binary etc. — adoption unavailable
      readonly failedProbes?: readonly HunkProbe[];
    };

// Hunk header parsing regex. "@@ -a,b +c,d @@" or "@@ -a +c @@" (single line).
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Parse unified diff text into file·hunk units. Verbatim preservation.
export function parseUnifiedDiff(text: string): ParsedDiff {
  // Split on '\n' to preserve input newlines. Each line's '\n' is restored on reserialization.
  // CRLF remains in line content as '\r' for verbatim preservation.
  const lines = text.length === 0 ? [] : text.split('\n');
  const files: DiffFile[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('diff --git')) {
      i += 1;
      continue;
    }

    // Collect file header block: from "diff --git" until first "@@" hunk header or next
    // "diff --git".
    const headerStart = i;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let kind: FileChangeKind = 'modify';
    let isBinary = false;
    let isRename = false;
    let isCopy = false;
    let isModeOnly = true; // mode-only candidate until hunk or ---/+++ is seen

    i += 1;
    while (i < lines.length) {
      const h = lines[i];
      if (h.startsWith('diff --git') || h.startsWith('@@ ')) break;
      if (h.startsWith('--- ')) {
        oldPath = parseHeaderPath(h.slice(4));
        isModeOnly = false;
      } else if (h.startsWith('+++ ')) {
        newPath = parseHeaderPath(h.slice(4));
        isModeOnly = false;
      } else if (h.startsWith('new file mode')) {
        kind = 'add';
      } else if (h.startsWith('deleted file mode')) {
        kind = 'delete';
      } else if (h.startsWith('rename from') || h.startsWith('rename to')) {
        isRename = true;
      } else if (h.startsWith('copy from') || h.startsWith('copy to')) {
        isCopy = true;
      } else if (h.startsWith('Binary files') || h.startsWith('GIT binary patch')) {
        isBinary = true;
        isModeOnly = false;
      } else if (h.startsWith('old mode') || h.startsWith('new mode')) {
        // mode change — keep isModeOnly candidate
      }
      i += 1;
    }
    const headerEnd = i; // first hunk or next file start

    // Collect hunks.
    const hunks: DiffHunk[] = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const hres = HUNK_HEADER_RE.exec(lines[i]);
      const headerLine = lines[i];
      i += 1;
      const bodyLines: string[] = [];
      // Hunk body: until next hunk("@@ ") or next file("diff --git").
      // Only ' '/'+'/'-'/'\' prefixed lines are body. Other lines (including empty) judged below.
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('@@ ') || b.startsWith('diff --git')) break;
        const c = b.charAt(0);
        if (c === ' ' || c === '+' || c === '-' || c === '\\') {
          bodyLines.push(b);
          i += 1;
        } else if (b === '') {
          // git diff empty context lines use ' ' (single space); a fully empty string is
          // split('\n')'s trailing element. F9: terminate only "when last element" —
          // terminating early on a mid-stream empty string (e.g. separator before next file header)
          // can drop following body lines, so skip and continue unless last.
          if (i === lines.length - 1) break;
          i += 1;
        } else {
          // Unknown line (next section) — end hunk.
          break;
        }
      }

      const parsed = hres
        ? {
            oldStart: num(hres[1]),
            oldLines: hres[2] === undefined ? 1 : num(hres[2]),
            newStart: num(hres[3]),
            newLines: hres[4] === undefined ? 1 : num(hres[4]),
            section: hres[5] ?? '',
          }
        : { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, section: '' };

      hunks.push({
        header: headerLine,
        oldStart: parsed.oldStart,
        oldLines: parsed.oldLines,
        newStart: parsed.newStart,
        newLines: parsed.newLines,
        section: parsed.section,
        bodyLines,
      });
    }

    // Reconstruct verbatim file header block (original lines + newline).
    const headerBlock = lines.slice(headerStart, headerEnd).join('\n') + '\n';

    // Adoptability classification.
    if (isBinary) kind = 'binary';
    else if (isRename) kind = 'rename';
    else if (isCopy) kind = 'copy';
    else if (kind === 'modify' && isModeOnly && hunks.length === 0) kind = 'mode';

    const hunkSelectable =
      (kind === 'modify' || kind === 'add' || kind === 'delete') && hunks.length > 0;

    // Display path: strip a/ b/ prefix (raw oldPath/newPath keep prefix).
    // F4: delete has newPath `/dev/null`; using it as-is misaligns dirty gate·numstat
    //   matching with real paths (dirtySet.has('/dev/null') is always false → delete
    //   files dirty on target cannot be rejected). When newPath is /dev/null, use oldPath
    //   for identity/display so the real path is included in dirty checks.
    const rawDisplay =
      newPath && newPath !== '/dev/null' ? newPath : (oldPath ?? newPath ?? '(unknown)');
    const displayPath = stripDiffPrefix(rawDisplay);
    files.push({
      path: displayPath,
      oldPath,
      newPath,
      kind,
      hunkSelectable,
      headerBlock,
      hunks,
    });
  }

  return { files };
}

// Reassemble a single file's patch from selected hunks.
//   - Reattach the original file header block verbatim.
//   - Each selected hunk body is preserved verbatim.
//   - Recalculate only hunk header line counts (oldStart keeps original coordinates —
//     unified diff old coordinates are relative to the original file, independent of other hunk application, §3).
//   - newStart is adjusted by cumulative (added-deleted) delta from prior selected hunks.
//
// Returns: patch text for this file (header + selected hunks). Empty string if none selected.
export function reassembleFile(file: DiffFile, selectedHunkIndices: readonly number[]): string {
  const selected = [...selectedHunkIndices].sort((a, b) => a - b);
  if (selected.length === 0) return '';

  let out = file.headerBlock;
  let newLineDelta = 0; // cumulative net line delta from prior selected hunks.

  for (const idx of selected) {
    const hunk = file.hunks[idx];
    if (!hunk) continue;

    // Recalculate actual old/new line counts from body (verbatim preservation check).
    let oldCount = 0;
    let newCount = 0;
    for (const bl of hunk.bodyLines) {
      const c = bl.charAt(0);
      if (c === ' ') {
        oldCount += 1;
        newCount += 1;
      } else if (c === '-') {
        oldCount += 1;
      } else if (c === '+') {
        newCount += 1;
      }
      // '\' (No newline) lines are not counted.
    }

    // old coordinates are immutable relative to the original file. new coordinates adjusted by prior selection delta.
    const oldStart = hunk.oldStart;
    const newStart = hunk.oldStart + newLineDelta;

    const rebuiltHeader = formatHunkHeader(
      oldStart,
      oldCount,
      newStart,
      newCount,
      hunk.section,
    );

    out += rebuiltHeader + '\n';
    if (hunk.bodyLines.length > 0) {
      out += hunk.bodyLines.join('\n') + '\n';
    }

    newLineDelta += newCount - oldCount;
  }

  return out;
}

// Merge selections from multiple files into one patch (single git apply, §3 all-or-nothing).
export function reassemblePatch(
  selections: ReadonlyArray<{ file: DiffFile; hunkIndices: readonly number[] }>,
): string {
  let patch = '';
  for (const sel of selections) {
    patch += reassembleFile(sel.file, sel.hunkIndices);
  }
  return patch;
}

// Hunk header formatting. git convention may omit ",1" when line count is 1, but
// git apply accepts explicit counts, so always specify for safety.
// When oldCount/newCount is 0 (pure add/delete hunk), use "start,0" format.
function formatHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  section: string,
): string {
  const oldPart = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
  const newPart = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
  return `@@ -${oldPart} +${newPart} @@${section}`;
}

// Extract path from "--- a/path" / "+++ b/path" lines. Truncate at tab (timestamp).
// Keep a/ b/ prefix (verbatim preservation). /dev/null unchanged.
function parseHeaderPath(rest: string): string {
  const tab = rest.indexOf('\t');
  const p = tab >= 0 ? rest.slice(0, tab) : rest;
  return p;
}

// Strip a/ or b/ prefix for repo-relative display path. /dev/null unchanged.
function stripDiffPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function num(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

// Synthesize untracked file as formal new-file diff header (spec §2·R4).
// Format accepted by git apply: diff --git + new file mode + index + --- /dev/null + +++ b/path.
// content is file verbatim (bytes). File-level all-or-nothing.
export function synthesizeNewFileDiff(
  repoRelPath: string,
  content: string,
  mode = '100644',
): string {
  const lines = content.length === 0 ? [] : content.split('\n');
  // If content ends with trailing newline, split's last element is empty string → not a real line.
  const endsWithNewline = content.endsWith('\n');
  const bodyLines = endsWithNewline ? lines.slice(0, -1) : lines;
  const lineCount = bodyLines.length;

  let out = '';
  out += `diff --git a/${repoRelPath} b/${repoRelPath}\n`;
  out += `new file mode ${mode}\n`;
  out += `index 0000000..0000000\n`;
  // Empty file: header only (git apply rejects 0-line hunks as corrupt).
  if (lineCount === 0) {
    return out;
  }
  out += `--- /dev/null\n`;
  out += `+++ b/${repoRelPath}\n`;
  out += `@@ -0,0 +1,${lineCount} @@\n`;
  for (const bl of bodyLines) {
    out += `+${bl}\n`;
  }
  if (!endsWithNewline) {
    out += `\\ No newline at end of file\n`;
  }
  return out;
}
