// ─── HQ brain context line — which workspace the human is looking at ─────────
//
// With an HQ designated, the right panel's chat is always the HQ brain, so a
// message like "tell iOS about this" or "merge this PR when it is green" does
// not say what "this" is. The terminal brain has no composer the renderer could
// prefix, so the pointer rides Claude Code's own UserPromptSubmit hook as
// `additionalContext` (see brainPtyHookBus and the bridge's `--context` mode).
//
// The line carries names, ids, the branch and the cwd — never terminal text.
// The input type below has no field that could carry any: it is built from the
// renderer-pushed workspace mirror (entries + the viewed workspace/pane), not
// from a hook payload or a fleet snapshot.

import type { WorkspaceListEntry } from '../../shared/workspaceMirror';

export interface ViewedPointer {
  workspaceId: string;
  paneId: string | null;
}

export interface ViewContextInput {
  /** The workspace whose brain received the prompt. */
  brainWorkspaceId: string;
  /** The designated HQ, or null when none is designated. */
  hqWorkspaceId: string | null;
  moaEnabled: boolean;
  /** What the human is viewing, or null when unknown. */
  viewed: ViewedPointer | null;
  /** The mirrored workspace entries (names, cwd, branch), or null when unknown. */
  entries: readonly WorkspaceListEntry[] | null;
}

/** Printed in place of a value that is not known, so the format never shifts. */
const UNKNOWN = '-';
const MAX_NAME = 80;
const MAX_BRANCH = 120;
const MAX_CWD = 240;

/**
 * One value made safe for a single fixed-format line: control characters and
 * line breaks become spaces, runs of whitespace collapse, quotes are dropped
 * (the name is quoted), and the result is capped. A workspace name can come
 * from a fan-out task title, so without this a name could forge a second line.
 */
export function sanitizeContextValue(value: string | null | undefined, max: number): string {
  if (typeof value !== 'string') return UNKNOWN;
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return UNKNOWN;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The fixed-format line. Every slot is always present. */
export function formatViewContextLine(v: {
  name: string | null | undefined;
  workspaceId: string;
  paneId: string | null | undefined;
  branch: string | null | undefined;
  cwd: string | null | undefined;
}): string {
  return (
    `[wmux context] viewing workspace "${sanitizeContextValue(v.name, MAX_NAME)}" ` +
    `(${sanitizeContextValue(v.workspaceId, MAX_NAME)}), ` +
    `pane ${sanitizeContextValue(v.paneId, MAX_NAME)}, ` +
    `branch ${sanitizeContextValue(v.branch, MAX_BRANCH)}, ` +
    `cwd ${sanitizeContextValue(v.cwd, MAX_CWD)}`
  );
}

/**
 * The context line for a prompt the human typed into a brain, or null for no
 * line. Null unless Moa is on, an HQ is designated, the prompt went to the HQ's
 * own brain, and the human is viewing some OTHER workspace that the mirror
 * knows (viewing the HQ itself adds nothing).
 */
export function resolveViewContext(input: ViewContextInput): string | null {
  const { brainWorkspaceId, hqWorkspaceId, moaEnabled, viewed, entries } = input;
  if (!moaEnabled || hqWorkspaceId === null || brainWorkspaceId !== hqWorkspaceId) return null;
  if (!viewed || viewed.workspaceId === hqWorkspaceId) return null;
  const entry = entries?.find((e) => e.id === viewed.workspaceId);
  if (!entry) return null;
  return formatViewContextLine({
    name: entry.name,
    workspaceId: entry.id,
    paneId: viewed.paneId,
    branch: entry.metadata?.gitBranch,
    cwd: entry.metadata?.cwd,
  });
}
