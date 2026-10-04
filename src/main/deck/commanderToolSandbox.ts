// ─── Command Deck — commander tool permission sandbox (M1b) ──────────────────
//
// The orchestrator brain now holds exactly ONE built-in hand: Write. Every rule
// governing that grant lives here, deliberately SDK-free, so it can be unit
// tested without a live model or subprocess. The adapter installs this as the
// SDK's `options.canUseTool` permission callback, which fires for every tool
// that is NOT auto-allowed via `allowedTools`. Because `allowedTools` BYPASSES
// this callback, Write is kept OUT of the allow-list on purpose — the only path
// Write can reach the disk is through this evaluator, and this evaluator is
// fail-closed by construction.
//
// Policy in one sentence: Write is permitted IFF it targets a `.md` file that
// resolves STRICTLY inside the brain's own memory partitions — the shared
// `<memoryRoot>/_global/` or its own `<memoryRoot>/<workspaceId>/` — and every
// other tool that reaches the callback is denied. That preserves the previous
// fail-closed behaviour for anything that used to need a permission prompt
// (Bash, Edit, WebFetch, …): none of them are available.
//
// Traversal defence: the candidate path is `path.resolve`d (collapsing any
// `../` segments) and required to sit under the partition dir plus a trailing
// separator, so neither the partition dir itself nor a sibling that merely
// shares the textual prefix (`<dir>-evil`) can match. On win32 the comparison
// is case-insensitive (the filesystem is), and that mode is injectable so the
// win32 branch stays testable on any host.

import * as fs from 'fs';
import * as path from 'path';

/** The subset of the SDK's PermissionResult this evaluator ever returns. A deny
 *  always carries a message (the SDK requires one). */
export type ToolPermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

// A workspaceId is consumed as a SINGLE path segment, so it must not traverse
// (`../evil`), name the parent (`.`/`..`), or nest (`a/b`). This mirrors
// commanderMemory's SAFE_WORKSPACE_ID EXACTLY: the two must agree, or the brain
// could read from a partition it cannot write, or vice versa. Anything outside
// the whitelist collapses to _global-only (never a path traversal, never a
// throw).
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9._-]{1,80}$/;

function sanitizeWorkspaceId(id: string | undefined): string | null {
  if (!id || !SAFE_WORKSPACE_ID.test(id) || id === '.' || id === '..') return null;
  return id;
}

export interface CommanderToolPermissionOptions {
  /** Root of the memory store (holds `_global/` and the per-workspace
   *  partitions) — the same dir commanderMemory.getMemoryRootDir() returns. */
  memoryRoot: string;
  /** The one workspace this brain serves; gates access to the per-workspace
   *  partition. Absent/invalid → only `_global/` is writable. */
  workspaceId?: string;
  /** Path-comparison mode. Defaults to the running platform (win32 = case
   *  insensitive). Injectable purely so the win32 branch is coverable on a
   *  case-sensitive CI host and vice versa. */
  caseInsensitive?: boolean;
}

/**
 * Whether `candidate` resolves STRICTLY inside `dir`: not `dir` itself, and not
 * a sibling that shares the textual prefix. `..` segments are collapsed by
 * path.resolve before the comparison, so traversal cannot escape.
 */
function isStrictlyInside(candidate: string, dir: string, caseInsensitive: boolean): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedCandidate = path.resolve(candidate);
  // Require the separator in the prefix so `<dir>` and `<dir>-sibling` fail; a
  // file placed directly in `<dir>` still matches (`<dir>/x.md`).
  const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
  const cand = caseInsensitive ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const pre = caseInsensitive ? prefix.toLowerCase() : prefix;
  return cand.startsWith(pre);
}

/**
 * The commander brain's sole permission gate. Returns `allow` only for a Write
 * into an own memory partition (`.md`, no escape); denies everything else with
 * a short message. Never throws — any internal error degrades to a deny, so a
 * broken evaluator can neither open the disk nor kill the turn.
 */
export function evaluateCommanderToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  opts: CommanderToolPermissionOptions,
): ToolPermissionResult {
  try {
    if (toolName !== 'Write') {
      // Fail closed for every other prompt-needing tool — matches the old
      // "unlisted tool is auto-denied" behaviour now that the callback exists.
      return { behavior: 'deny', message: `${toolName} is not available to the orchestrator.` };
    }
    const filePath = (input as { file_path?: unknown } | null)?.file_path;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { behavior: 'deny', message: 'Write requires a string file_path.' };
    }
    // `.md` only — memory is a set of small markdown facts, never arbitrary
    // files. Case-insensitive so `.MD` is not a bypass.
    if (!filePath.toLowerCase().endsWith('.md')) {
      return { behavior: 'deny', message: 'The orchestrator may only write .md memory files.' };
    }
    const caseInsensitive = opts.caseInsensitive ?? process.platform === 'win32';
    // The shared global partition is always writable; the workspace partition
    // only when a valid workspaceId is bound (own partition, never another's).
    const allowedDirs: string[] = [path.join(opts.memoryRoot, '_global')];
    const wsId = sanitizeWorkspaceId(opts.workspaceId);
    if (wsId) allowedDirs.push(path.join(opts.memoryRoot, wsId));
    for (const dir of allowedDirs) {
      if (isStrictlyInside(filePath, dir, caseInsensitive)) {
        return { behavior: 'allow' };
      }
    }
    return {
      behavior: 'deny',
      message:
        'The orchestrator can only write memory files inside its _global or workspace folder.',
    };
  } catch {
    // Defence in depth: the adapter also wraps this call, but a fail-closed
    // deny here guarantees a thrown path helper never becomes an accidental
    // allow (or an unhandled rejection that ends the turn).
    return { behavior: 'deny', message: 'Write permission check failed.' };
  }
}

// ─── Moa proposal gate (P3) ───────────────────────────────────────────────────
//
// The terminal (pty) HQ brain has no canUseTool callback, so its one write
// grant is enforced by a PreToolUse hook script instead: Write and Edit pass
// ONLY for a `.md` file placed directly inside `<memoryRoot>/_proposals/`.
// Same rules as evaluateCommanderToolPermission above (resolve, then a
// separator-anchored comparison, case-insensitive on win32), plus what a
// filesystem hook can see and the SDK path never needed: no subfolders, no
// symlinked folder or file, no hard link, and a size cap.
//
// The check is kept as SOURCE TEXT so the hook script and main run the exact
// same bytes. A hook script cannot import main's bundle, and a function's
// toString() after bundling may reference helpers the script does not have.
// It is plain ES2020 with no outside references: everything it uses arrives
// as a parameter. It returns null to allow, or the reason to deny.

export const PROPOSAL_WRITE_CHECK_SOURCE = String.raw`function checkProposalWrite(toolName, toolInput, proposalsDir, caseInsensitive, maxBytes, path, fs) {
  if (toolName !== 'Write' && toolName !== 'Edit') return toolName + ' is not available to Moa.';
  var input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  var filePath = input.file_path;
  if (typeof filePath !== 'string' || filePath.length === 0) return 'A proposal needs a file_path.';
  if (!path.isAbsolute(filePath)) return 'Use the absolute path of a file directly inside ' + proposalsDir + '.';
  var dir = path.resolve(proposalsDir);
  var resolved = path.resolve(filePath);
  var parent = path.dirname(resolved);
  if ((caseInsensitive ? parent.toLowerCase() : parent) !== (caseInsensitive ? dir.toLowerCase() : dir)) {
    return 'Moa can only write proposal files directly inside ' + dir + ' (no subfolders).';
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md$/.test(path.basename(resolved))) {
    return 'A proposal is one .md file with a plain name (letters, digits, dot, dash, underscore).';
  }
  var dirStat;
  try { dirStat = fs.lstatSync(dir); } catch (e) { return 'The proposals folder does not exist.'; }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return 'The proposals folder is not a plain folder.';
  var existing = 0;
  try {
    var st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) return 'A proposal file may not be a link.';
    if (!st.isFile()) return 'A proposal must be a regular file.';
    if (st.nlink > 1) return 'A proposal file may not be a hard link.';
    existing = st.size;
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return 'The proposal file could not be checked.';
  }
  var text = toolName === 'Write' ? input.content : input.new_string;
  if (typeof text !== 'string') return toolName === 'Write' ? 'Write needs string content.' : 'Edit needs a string new_string.';
  var bytes = Buffer.byteLength(text, 'utf8') + (toolName === 'Edit' ? existing : 0);
  if (bytes > maxBytes) return 'A proposal is at most ' + maxBytes + ' bytes.';
  return null;
}`;

/** Largest proposal file, in bytes (the gate and the card both enforce it). */
export const PROPOSAL_MAX_BYTES = 16 * 1024;

type ProposalWriteCheck = (
  toolName: string,
  toolInput: unknown,
  proposalsDir: string,
  caseInsensitive: boolean,
  maxBytes: number,
  pathMod: typeof path,
  fsMod: Pick<typeof fs, 'lstatSync'>,
) => string | null;

// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
const compiledProposalCheck = new Function(`${PROPOSAL_WRITE_CHECK_SOURCE}\nreturn checkProposalWrite;`)() as ProposalWriteCheck;

/**
 * Main's copy of the hook's check (same source). Allows only a Write/Edit of a
 * `.md` file directly inside `proposalsDir`; anything else, and any thrown
 * error, is a deny. Never throws.
 */
export function evaluateProposalWrite(
  toolName: string,
  toolInput: unknown,
  opts: { proposalsDir: string; caseInsensitive?: boolean; maxBytes?: number },
): ToolPermissionResult {
  try {
    const reason = compiledProposalCheck(
      toolName,
      toolInput,
      opts.proposalsDir,
      opts.caseInsensitive ?? process.platform === 'win32',
      opts.maxBytes ?? PROPOSAL_MAX_BYTES,
      path,
      fs,
    );
    return reason === null ? { behavior: 'allow' } : { behavior: 'deny', message: String(reason) };
  } catch {
    return { behavior: 'deny', message: 'The proposal check failed.' };
  }
}

/**
 * The generated PreToolUse hook for the HQ brain's Write/Edit: reads the hook
 * JSON on stdin, runs the check, and either prints Claude Code's
 * `permissionDecision: "allow"` (the brain's TUI has nobody to answer a
 * prompt) or exits 2 with the reason on stderr. Fail-closed: bad input, a
 * thrown check, or anything but an explicit null is a deny.
 */
export function buildProposalGateScript(opts: {
  proposalsDir: string;
  caseInsensitive?: boolean;
  maxBytes?: number;
}): string {
  const caseInsensitive = opts.caseInsensitive ?? process.platform === 'win32';
  return [
    '// Generated by wmux (Moa proposal gate). Regenerated on every brain spawn',
    '// and unlinked on dispose; edits here are lost.',
    "'use strict';",
    "const path = require('path');",
    "const fs = require('fs');",
    PROPOSAL_WRITE_CHECK_SOURCE,
    `const PROPOSALS_DIR = ${JSON.stringify(opts.proposalsDir)};`,
    `const CASE_INSENSITIVE = ${caseInsensitive ? 'true' : 'false'};`,
    `const MAX_BYTES = ${Math.max(0, Math.floor(opts.maxBytes ?? PROPOSAL_MAX_BYTES))};`,
    'function deny(reason) {',
    '  // Exit 2 + stderr is Claude Code\'s "block this call and tell the model why".',
    "  process.stderr.write(String(reason) + '\\n');",
    '  process.exit(2);',
    '}',
    "let raw = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('error', () => deny('The proposal check could not read its input.'));",
    "process.stdin.on('data', (chunk) => {",
    '  raw += chunk;',
    "  if (raw.length > MAX_BYTES * 8 + 65536) deny('The proposal is too large.');",
    '});',
    "process.stdin.on('end', () => {",
    '  let reason;',
    '  try {',
    '    const payload = JSON.parse(raw);',
    '    reason = checkProposalWrite(payload.tool_name, payload.tool_input, PROPOSALS_DIR, CASE_INSENSITIVE, MAX_BYTES, path, fs);',
    '  } catch (e) {',
    "    reason = 'The proposal check failed.';",
    '  }',
    '  if (reason !== null) deny(reason);',
    '  process.stdout.write(JSON.stringify({',
    '    hookSpecificOutput: {',
    "      hookEventName: 'PreToolUse',",
    "      permissionDecision: 'allow',",
    "      permissionDecisionReason: 'A Moa proposal file. The operator decides whether to keep it.',",
    '    },',
    "  }) + '\\n');",
    '  process.exit(0);',
    '});',
    '',
  ].join('\n');
}
