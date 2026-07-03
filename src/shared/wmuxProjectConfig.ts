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

// ── X8 pane-supervision caps + defaults (SSOT) ───────────────────────────────
// A supervised leaf runs its `command` as the pane's root process under the
// daemon's PaneSupervisor (restart + runaway guard). These constants are the
// single source of truth: the schema clamps wmux.json values to the caps, and
// the funnel fills omitted restartLimit fields from the defaults before handing
// the policy to the daemon. Mirror of the daemon-side runaway model (#54):
// consecutive short-lived runs trip the guard; a healthy run resets the counter.
export const PROJECT_SUPERVISION_DEFAULT_BURST = 5;
export const PROJECT_SUPERVISION_DEFAULT_HEALTHY_UPTIME_SEC = 300;
export const PROJECT_SUPERVISION_BURST_MIN = 1;
export const PROJECT_SUPERVISION_BURST_MAX = 20;
export const PROJECT_SUPERVISION_HEALTHY_UPTIME_SEC_MIN = 30;
export const PROJECT_SUPERVISION_HEALTHY_UPTIME_SEC_MAX = 3600;

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
  /**
   * X8 supervision. When set, `command` is run as the pane's ROOT process under
   * the daemon's PaneSupervisor instead of being typed into an interactive
   * shell (exec-style unit). Requires `command`, mutually exclusive with `url`.
   *   - 'on-failure' — restart when the process exits non-zero / signalled / killed
   *   - 'always'     — restart on any exit (systemd Restart=always semantics)
   * The wmux.json author may also write 'never' (the unsupervised default) as a
   * documented no-op; it normalizes to this field being OMITTED.
   */
  restart?: 'on-failure' | 'always';
  /** X8 runaway-guard bounds. Partial by design: only author-written fields
   * survive normalization; omitted ones default at the funnel (SSOT consts). */
  restartLimit?: { burst?: number; healthyUptimeSec?: number };
  /**
   * Unattended reboot-survival opt-in (the normalized, EXPANDED flag). When
   * true, a reboot/crash replay re-applies the agent's captured permission mode
   * (e.g. `--dangerously-skip-permissions`) so an unattended agent resumes
   * without stalling at a prompt. This is only an INTENT: the daemon honors it
   * at replay ONLY against a matching, still-trusted per-session grant (live
   * content-hash + trust-epoch re-check — see the unattended-supervisor plan).
   * Requires an effective `restart` (a bare restore with no supervision is a
   * contradiction and rejects the layout). Authors usually write the
   * `unattended: true` sugar, which expands to `restart: 'on-failure'` (exit 0
   * = task done, only crashes relaunch) + this flag; explicit `restart` /
   * `restorePermissionMode` override the expansion.
   */
  restorePermissionMode?: boolean;
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
  /**
   * Unattended reboot-survival consent for THESE bytes (surfaced only when
   * `trust === 'trusted'`). Drives the layout funnel's per-leaf
   * `restorePermissionMode` gate: an unattended leaf restores its captured
   * permission mode on reboot ONLY when the user gave this explicit consent.
   */
  unattended?: boolean;
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

/**
 * Clamp + validate one runaway-guard bound (burst / healthyUptimeSec). STRICT
 * (decision ⑪): a value present but non-finite / NaN → invalid (returns null,
 * caller drops the whole layout) rather than silently snapping to a cap — a
 * typo'd limit must never quietly weaken supervision. Math.floor first so a
 * fractional value resolves to an integer, then range-check against the caps.
 */
function clampSupervisionBound(value: number, min: number, max: number): number | null {
  if (!Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  if (floored < min || floored > max) return null;
  return floored;
}

/**
 * Result of normalizing a leaf's X8 supervision fields:
 *   - 'invalid' — the author wrote something that can't downgrade safely (bad
 *     restart enum, out-of-range/NaN restartLimit, restart with no command, or
 *     restart alongside url). The whole layout drops (all-or-nothing).
 *   - { restart?, restartLimit? } — the validated, possibly-empty policy. An
 *     omitted/`'never'` restart yields no `restart` field; a partial
 *     restartLimit keeps only the present field(s) (defaulted later at the
 *     funnel). A restartLimit with no effective restart is dropped silently
 *     (cosmetic orphan, decision ⑪).
 */
type NormalizedSupervision =
  | 'invalid'
  | {
      restart?: 'on-failure' | 'always';
      restartLimit?: { burst?: number; healthyUptimeSec?: number };
      restorePermissionMode?: boolean;
    };

function normalizeSupervision(
  rawRestart: unknown,
  rawLimit: unknown,
  command: string | undefined,
  url: string | undefined,
  rawUnattended: unknown,
  rawRestorePermissionMode: unknown,
): NormalizedSupervision {
  // `unattended: true` sugar (decision ⑨/⑩): one word to declare a
  // reboot-surviving unattended agent. Expands to `restart: 'on-failure'`
  // (exit 0 = task done → respected; only crashes relaunch) + permission-mode
  // restore on reboot. Explicit `restart` / `restorePermissionMode` override the
  // expansion. Strict: a non-boolean `unattended` is a typo, not a downgrade.
  let sugar = false;
  if (rawUnattended !== undefined) {
    if (typeof rawUnattended !== 'boolean') return 'invalid';
    sugar = rawUnattended;
  }

  // restart enum. Accept exactly 'on-failure' | 'always' | 'never'; 'never'
  // normalizes to "field omitted" (documented no-op alias). Any other defined
  // value is a typo we refuse to silently downgrade → invalid.
  let restart: 'on-failure' | 'always' | undefined;
  if (rawRestart !== undefined) {
    if (rawRestart === 'on-failure' || rawRestart === 'always') {
      restart = rawRestart;
    } else if (rawRestart === 'never') {
      restart = undefined;
    } else {
      return 'invalid';
    }
  } else if (sugar) {
    // Sugar fills restart ONLY when the author didn't write one. An explicit
    // `restart: 'never'` stays "unsupervised" and collides with the sugar's
    // permission-restore intent below (rejected — decision ⑨ conflict guard).
    restart = 'on-failure';
  }

  // restorePermissionMode: explicit boolean, or true via `unattended` sugar
  // (unless the author explicitly set it false). Strict on non-boolean.
  let restorePermissionMode: boolean | undefined;
  if (rawRestorePermissionMode !== undefined) {
    if (typeof rawRestorePermissionMode !== 'boolean') return 'invalid';
    if (rawRestorePermissionMode) restorePermissionMode = true;
  } else if (sugar) {
    restorePermissionMode = true;
  }

  // An effective restart needs a command (the process IS the unit) and cannot
  // coexist with a browser url.
  if (restart !== undefined) {
    if (command === undefined) return 'invalid';
    if (url !== undefined) return 'invalid';
  }

  // Permission-mode restore is meaningless — and contradictory — without
  // supervision: only a replayed exec unit can have anything restored on
  // reboot. Reject `unattended:true` + `restart:'never'`, or a bare
  // `restorePermissionMode:true` with no restart (decision ⑨ conflict guard).
  if (restorePermissionMode === true && restart === undefined) return 'invalid';

  // restartLimit: present fields must validate; missing fields stay absent and
  // are defaulted at the funnel. Accept a partial object (only one field).
  let restartLimit: { burst?: number; healthyUptimeSec?: number } | undefined;
  if (rawLimit !== undefined) {
    if (rawLimit === null || typeof rawLimit !== 'object' || Array.isArray(rawLimit)) return 'invalid';
    const lim = rawLimit as { burst?: unknown; healthyUptimeSec?: unknown };
    const out: { burst?: number; healthyUptimeSec?: number } = {};
    if (lim.burst !== undefined) {
      if (typeof lim.burst !== 'number') return 'invalid';
      const burst = clampSupervisionBound(lim.burst, PROJECT_SUPERVISION_BURST_MIN, PROJECT_SUPERVISION_BURST_MAX);
      if (burst === null) return 'invalid';
      out.burst = burst;
    }
    if (lim.healthyUptimeSec !== undefined) {
      if (typeof lim.healthyUptimeSec !== 'number') return 'invalid';
      const sec = clampSupervisionBound(
        lim.healthyUptimeSec,
        PROJECT_SUPERVISION_HEALTHY_UPTIME_SEC_MIN,
        PROJECT_SUPERVISION_HEALTHY_UPTIME_SEC_MAX,
      );
      if (sec === null) return 'invalid';
      out.healthyUptimeSec = sec;
    }
    if (out.burst !== undefined || out.healthyUptimeSec !== undefined) restartLimit = out;
  }

  // A restartLimit with no effective restart is a cosmetic orphan — drop it
  // silently (it changes nothing) rather than reject the layout. (restorePermission
  // is guaranteed absent here — the conflict guard above already rejected it.)
  if (restart === undefined) return {};
  const result: {
    restart: 'on-failure' | 'always';
    restartLimit?: { burst?: number; healthyUptimeSec?: number };
    restorePermissionMode?: boolean;
  } = { restart };
  if (restartLimit !== undefined) result.restartLimit = restartLimit;
  if (restorePermissionMode === true) result.restorePermissionMode = true;
  return result;
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
    restart?: unknown;
    restartLimit?: unknown;
    unattended?: unknown;
    restorePermissionMode?: unknown;
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

  // X8 supervision (decision ⑪ — STRICT; a bad value drops the whole layout
  // rather than silently downgrading to unsupervised).
  const supervision = normalizeSupervision(
    src.restart,
    src.restartLimit,
    command,
    url,
    src.unattended,
    src.restorePermissionMode,
  );
  if (supervision === 'invalid') return null;

  const leaf: WmuxProjectLayoutLeaf = { type: 'leaf' };
  if (command !== undefined) leaf.command = command;
  if (cwd !== undefined) leaf.cwd = cwd;
  if (url !== undefined) leaf.url = url;
  if (supervision.restart !== undefined) leaf.restart = supervision.restart;
  if (supervision.restartLimit !== undefined) leaf.restartLimit = supervision.restartLimit;
  if (supervision.restorePermissionMode === true) leaf.restorePermissionMode = true;
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
