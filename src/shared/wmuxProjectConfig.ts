/**
 * Validation + normalization for the per-project `wmux.json` file (X5).
 *
 * A project drops a `wmux.json` at its repo root to declare:
 *   - `commands`: custom commands surfaced in the palette / sidebar
 *   - `layout`:   a default pane arrangement, each leaf optionally running a
 *                 startup command or hosting a browser pane (X3)
 *
 * SECURITY MODEL — this file is CHECKED INTO THE REPO, so its contents are
 * attacker-reachable via a malicious PR. Nothing here may execute until the
 * user trusts the file (main/project/ProjectConfigStore gates on a content
 * hash; any edit demotes trust back to "display only"). This module is only
 * the parse/shape layer; it must stay pure (no fs / Electron / DOM) so both
 * processes and vitest can share it — same contract as workspaceProfile.ts.
 *
 * Normalization philosophy (mirrors normalizeWorkspaceProfile):
 *   - `commands` are forgiving: invalid entries drop item-wise.
 *   - `layout` is all-or-nothing: silently dropping one pane would change the
 *     meaning of the arrangement, so any invalid node rejects the whole tree.
 *   - Returns `undefined` when nothing usable remains, never throws.
 */

import { WORKSPACE_PROFILE_COMMAND_MAX, WORKSPACE_PROFILE_STARTUP_CWD_MAX } from './types';

/** File name probed for at/above a workspace's cwd (stops at the repo root). */
export const WMUX_PROJECT_CONFIG_FILENAME = 'wmux.json';

// ── Validation caps ──────────────────────────────────────────────────────────
export const PROJECT_CONFIG_MAX_COMMANDS = 16;
export const PROJECT_CONFIG_TITLE_MAX = 64;
export const PROJECT_CONFIG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const PROJECT_CONFIG_MAX_LAYOUT_LEAVES = 12;
export const PROJECT_CONFIG_MAX_LAYOUT_DEPTH = 4;
export const PROJECT_CONFIG_URL_MAX = 2048;
/** Raw wmux.json files larger than this are ignored outright (DoS guard). */
export const PROJECT_CONFIG_MAX_FILE_BYTES = 256 * 1024;

export interface WmuxProjectCommand {
  id: string;
  title: string;
  command: string;
}

export interface WmuxProjectLayoutLeaf {
  type: 'leaf';
  /** Startup command pasted into the shell after boot (pty initialCommand). */
  command?: string;
  /** Working directory RELATIVE to the project root. Absolute / `..` rejected. */
  cwd?: string;
  /** http/https URL — the leaf becomes a browser pane (X3) instead of a PTY. */
  url?: string;
}

export interface WmuxProjectLayoutBranch {
  type: 'branch';
  direction: 'horizontal' | 'vertical';
  /** Percentages; only kept when it matches children length and sums sanely. */
  sizes?: number[];
  children: WmuxProjectLayoutNode[];
}

export type WmuxProjectLayoutNode = WmuxProjectLayoutLeaf | WmuxProjectLayoutBranch;

export interface WmuxProjectConfig {
  version: 1;
  commands?: WmuxProjectCommand[];
  layout?: WmuxProjectLayoutNode;
}

/**
 * Trust verdict for a discovered wmux.json (computed main-side by
 * ProjectConfigStore from the persisted decision + live content hash):
 *   - 'untrusted' — no decision yet → display only
 *   - 'trusted'   — user approved THESE bytes → commands may run
 *   - 'stale'     — approved, but the file changed since → display only
 *   - 'denied'    — user said no; sticky until explicitly cleared
 */
export type ProjectTrustState = 'trusted' | 'untrusted' | 'denied' | 'stale';

/** Renderer-facing snapshot for a workspace cwd (IPC PROJECT_CONFIG_GET). */
export interface ProjectConfigState {
  found: boolean;
  /** Directory containing wmux.json — the project root. Normalized. */
  root?: string;
  configPath?: string;
  /** Parsed + normalized config. Absent when the file is invalid. */
  config?: WmuxProjectConfig;
  /** True when a wmux.json exists but failed to parse/normalize. */
  invalid?: boolean;
  contentHash?: string;
  trust?: ProjectTrustState;
}

// ── Field validators ─────────────────────────────────────────────────────────

function normString(input: unknown, max: number): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/** Commands keep their content verbatim (only emptiness-trim), like
 * workspaceProfile.normalizeCommand — whitespace can be syntactically
 * meaningful inside a shell line. */
function normCommand(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  if (input.trim().length === 0) return undefined;
  if (input.length > WORKSPACE_PROFILE_COMMAND_MAX) return undefined;
  return input;
}

/** Project-relative cwd: rejects absolute paths, drive letters, UNC and any
 * `..` segment so a leaf can't escape the trusted project root. `.` and
 * nested relative segments are fine. */
export function isValidProjectRelativeCwd(input: string): boolean {
  if (input.length === 0 || input.length > WORKSPACE_PROFILE_STARTUP_CWD_MAX) return false;
  if (/^[A-Za-z]:/.test(input)) return false;            // drive-absolute
  if (input.startsWith('/') || input.startsWith('\\')) return false; // root/UNC
  const segments = input.split(/[\\/]+/);
  return segments.every((seg) => seg !== '..');
}

function normRelativeCwd(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (!isValidProjectRelativeCwd(trimmed)) return undefined;
  return trimmed;
}

/** Same policy as renderer browserPane.isSafeBrowserUrl (http/https only) —
 * re-implemented here because shared/ must not import from renderer/. */
export function isSafeProjectUrl(input: string): boolean {
  if (input.length > PROJECT_CONFIG_URL_MAX) return false;
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

function normalizeCommands(input: unknown): WmuxProjectCommand[] {
  if (!Array.isArray(input)) return [];
  const out: WmuxProjectCommand[] = [];
  const seenIds = new Set<string>();
  for (const raw of input) {
    if (out.length >= PROJECT_CONFIG_MAX_COMMANDS) break;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const src = raw as { id?: unknown; title?: unknown; command?: unknown };
    const id = typeof src.id === 'string' && PROJECT_CONFIG_ID_RE.test(src.id) ? src.id : undefined;
    const title = normString(src.title, PROJECT_CONFIG_TITLE_MAX);
    const command = normCommand(src.command);
    if (id === undefined || title === undefined || command === undefined) continue;
    if (seenIds.has(id)) continue; // first declaration wins
    seenIds.add(id);
    out.push({ id, title, command });
  }
  return out;
}

// ── layout ───────────────────────────────────────────────────────────────────

interface LayoutBudget {
  leaves: number;
}

/** Returns the normalized node, or null when ANY part is invalid — layout is
 * all-or-nothing (see module header). */
function normalizeLayoutNode(input: unknown, depth: number, budget: LayoutBudget): WmuxProjectLayoutNode | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  if (depth > PROJECT_CONFIG_MAX_LAYOUT_DEPTH) return null;
  const src = input as {
    direction?: unknown;
    sizes?: unknown;
    panes?: unknown;
    command?: unknown;
    cwd?: unknown;
    url?: unknown;
  };

  // Branch: presence of `panes` is the discriminator.
  if (src.panes !== undefined) {
    if (!Array.isArray(src.panes) || src.panes.length < 2) return null;
    if (src.direction !== 'horizontal' && src.direction !== 'vertical') return null;
    const children: WmuxProjectLayoutNode[] = [];
    for (const child of src.panes) {
      const node = normalizeLayoutNode(child, depth + 1, budget);
      if (node === null) return null;
      children.push(node);
    }
    const branch: WmuxProjectLayoutBranch = { type: 'branch', direction: src.direction, children };
    if (Array.isArray(src.sizes)) {
      const sizes = src.sizes.filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s > 0);
      if (sizes.length === children.length) branch.sizes = sizes;
      // Mismatched sizes are dropped (renderer recomputes equal splits) — a
      // cosmetic field shouldn't reject an otherwise-valid arrangement.
    }
    return branch;
  }

  // Leaf
  budget.leaves++;
  if (budget.leaves > PROJECT_CONFIG_MAX_LAYOUT_LEAVES) return null;
  const command = src.command === undefined ? undefined : normCommand(src.command);
  if (src.command !== undefined && command === undefined) return null;
  const cwd = src.cwd === undefined ? undefined : normRelativeCwd(src.cwd);
  if (src.cwd !== undefined && cwd === undefined) return null;
  let url: string | undefined;
  if (src.url !== undefined) {
    if (typeof src.url !== 'string' || !isSafeProjectUrl(src.url.trim())) return null;
    url = src.url.trim();
  }
  // A pane is either a terminal (command/cwd) or a browser (url) — both is a
  // contradiction the author must resolve, not something to guess at.
  if (url !== undefined && (command !== undefined || cwd !== undefined)) return null;

  const leaf: WmuxProjectLayoutLeaf = { type: 'leaf' };
  if (command !== undefined) leaf.command = command;
  if (cwd !== undefined) leaf.cwd = cwd;
  if (url !== undefined) leaf.url = url;
  return leaf;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Build a clean WmuxProjectConfig from untrusted JSON, or `undefined` when
 * nothing usable remains.
 *
 * `version`: absent → treated as 1 (hand-authoring friendliness). Present and
 * ≠ 1 → the whole file is rejected so a future v2 format is never half-read.
 */
export function normalizeWmuxProjectConfig(input: unknown): WmuxProjectConfig | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const src = input as { version?: unknown; commands?: unknown; layout?: unknown };

  if (src.version !== undefined && src.version !== 1) return undefined;

  const commands = normalizeCommands(src.commands);
  let layout: WmuxProjectLayoutNode | undefined;
  if (src.layout !== undefined) {
    // A bare-leaf root (no `panes`) is legal but pointless as a "layout" —
    // still accepted so `{"layout": {"command": "claude"}}` does what it says.
    layout = normalizeLayoutNode(src.layout, 1, { leaves: 0 }) ?? undefined;
  }

  if (commands.length === 0 && layout === undefined) return undefined;
  const config: WmuxProjectConfig = { version: 1 };
  if (commands.length > 0) config.commands = commands;
  if (layout !== undefined) config.layout = layout;
  return config;
}

/**
 * Every shell command the config can run — what the trust dialog must show
 * verbatim before the user approves. Order: custom commands first, then
 * layout startup commands (depth-first, matching visual order).
 */
export function collectConfigCommands(config: WmuxProjectConfig): string[] {
  const out: string[] = [];
  for (const cmd of config.commands ?? []) out.push(cmd.command);
  const walk = (node: WmuxProjectLayoutNode): void => {
    if (node.type === 'leaf') {
      if (node.command !== undefined) out.push(node.command);
      return;
    }
    node.children.forEach(walk);
  };
  if (config.layout !== undefined) walk(config.layout);
  return out;
}

/** Count layout leaves (UI summary: "applies a N-pane layout"). */
export function countLayoutLeaves(node: WmuxProjectLayoutNode): number {
  if (node.type === 'leaf') return 1;
  return node.children.reduce((acc, child) => acc + countLayoutLeaves(child), 0);
}
