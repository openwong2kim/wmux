// ─── Command Deck — per-workspace autonomy capabilities (event-push) ─────────
//
// The event-push loop lets a pane lifecycle change (agent.stop /
// agent.awaiting_input) WAKE a workspace's orchestrator into a fresh turn. What
// that turn is ALLOWED to do is gated here, per workspace, fail-closed.
//
// Three capabilities, from harmless to dangerous (decision 2 of
// plans/orchestrator-event-push-2026-07-12.md):
//   - summarize            (default ON)  — open a turn that reports state and
//                                          stops. Cannot touch a pane.
//   - continueInstruction  (default OFF) — the brain may send a follow-up
//                                          instruction into a pane.
//   - approvalPress        (default OFF) — the brain may press y/1/2/3 on an
//                                          approval prompt.
//
// FAIL-CLOSED: a missing/corrupt file, an unknown workspace, or a torn entry
// all resolve to DEFAULT_AUTONOMY (summarize on, the two dangerous caps off).
// This mirrors channelsTabVisible (#413): the safe posture is the one you fall
// back to when anything is uncertain.
//
// APPROVAL RULE ENFORCED ELSEWHERE (CommanderEventCoalescer): with approvalPress
// on, a hook-source awaiting_input may be pressed directly; a `detector`-source
// (regex) one must be VERIFIED on screen first (terminal_read) before pressing
// (owner decision 2026-07-17 — detector events are the only awaiting_input
// source, so a hook-only rule made approval-press dead code). This store only
// says whether the CAPABILITY is on; the coalescer's prompt builder carries the
// verify-then-press instruction.
//
// One JSON file (`deck-autonomy.json`) in the wmux data dir, atomic-written and
// WMUX_DATA_SUFFIX-isolated — the same storage shape as deck-schedules.json /
// deck-commander.json.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

// ─── Agent mode (per-workspace, owner design 2026-07-13, revised 2026-07-17) ──
//
// The user-facing control. One of three levels; the three raw caps below are
// DERIVED from it (modeToCaps) and the coalescer reads `mode` for its wake
// policy. This is the single knob; caps are the mechanism.
//
//   off      no ambient wake; the handler ALSO tears down running loops +
//            disables cadence schedules (kill switch). Human can still type,
//            and a loop the user explicitly starts still wakes (override).
//   assist   value-filtered wake: ambient wakes ONLY on awaiting_input
//            (a pane blocked on input) — plain agent.stop is dropped, which
//            is the summary-spam we are killing. Notify/report posture; never
//            presses approvals.
//   auto     DANGER: wake on every lifecycle event; drives panes and presses
//            approvals on its own judgment (verify-then-press for regex-
//            detected prompts), running work to completion unattended.
//
//   wake policy:  off → 'none'   assist → 'value-filtered'   auto → 'all'
//   (a RUNNING loop overrides to 'all' in every mode except off, mirroring the
//    global auto-wake switch's loop carve-out.)
//
// Legacy values from the four-mode era are mapped on read: 'manual' → 'off',
// 'orchestrate' → 'auto' (sanitizeEntry).
export type AgentMode = 'off' | 'assist' | 'auto';

export type WakePolicy = 'none' | 'value-filtered' | 'all';

/** The wake policy a mode implies (before the running-loop override). */
export function modeToWakePolicy(mode: AgentMode): WakePolicy {
  switch (mode) {
    case 'auto':
      return 'all';
    case 'assist':
      return 'value-filtered';
    case 'off':
      return 'none';
  }
}

export interface WorkspaceAutonomy {
  /** The user-facing mode this workspace is in. Source of truth; the three
   *  caps below are derived from it on write (a loop may transiently override
   *  the caps, never the mode). */
  mode: AgentMode;
  /** Open a turn that reports fleet state and stops. Default on. */
  summarize: boolean;
  /** Brain may send a follow-up instruction into a pane. Default off. */
  continueInstruction: boolean;
  /** Brain may press y/1/2/3 on an approval prompt. Default off. */
  approvalPress: boolean;
}

const ALL_MODES: readonly AgentMode[] = ['off', 'assist', 'auto'];

/** Legacy four-mode values (pre-2026-07-17 files) mapped to the new three. */
const LEGACY_MODE_MAP: Readonly<Record<string, AgentMode>> = {
  manual: 'off',
  orchestrate: 'auto',
};

/** Derive the three raw caps from a mode. The dangerous cap (approvalPress)
 *  stays OFF except in `auto`, so a fresh/corrupt workspace never gains
 *  auto-approval. `continueInstruction` is on for assist/auto but only
 *  bites under a running loop (ambient assist drops plain stops via the value
 *  filter), so an ambient assist workspace is a notifier, not a driver. */
export function modeToCaps(mode: AgentMode): Omit<WorkspaceAutonomy, 'mode'> {
  switch (mode) {
    case 'auto':
      return { summarize: true, continueInstruction: true, approvalPress: true };
    case 'assist':
      return { summarize: true, continueInstruction: true, approvalPress: false };
    case 'off':
      return { summarize: false, continueInstruction: false, approvalPress: false };
  }
}

/** Back-derive a mode from raw caps — used ONLY for legacy files written before
 *  the `mode` field existed (after that the mode is always stored). Maps by the
 *  dangerous caps: approval → auto; continue → assist; else → the product
 *  default (off — fail-closed, owner decision 2026-07-17). */
export function deriveMode(caps: Omit<WorkspaceAutonomy, 'mode'>): AgentMode {
  if (caps.approvalPress) return 'auto';
  if (caps.continueInstruction) return 'assist';
  return DEFAULT_MODE;
}

/** Product default for a workspace with no entry: OFF (owner decision
 *  2026-07-17 — autonomy is strictly opt-in; the previous default was assist). */
export const DEFAULT_MODE: AgentMode = 'off';

/** Product default entry. Mode `off` means every cap is false, so this doubles
 *  as the fail-closed fallback on a torn file — a fresh/corrupt workspace has
 *  no autonomy at all until the operator opts in. */
export const DEFAULT_AUTONOMY: Readonly<WorkspaceAutonomy> = {
  mode: DEFAULT_MODE,
  ...modeToCaps(DEFAULT_MODE),
};

/** Same workspace-id shape the deck handler validates before keying maps. */
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function getDeckAutonomyPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-autonomy.json');
}

/** Coerce one raw entry to a WorkspaceAutonomy. The caps are read as stored (a
 *  loop may have transiently overridden them). The mode is used as stored when
 *  it is a known value; a legacy entry with no `mode` field back-derives one
 *  from its caps (deriveMode) so old files keep working. */
function sanitizeEntry(raw: unknown): WorkspaceAutonomy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTONOMY };
  const o = raw as Record<string, unknown>;
  const caps = {
    // summarize's legacy default was ON; keep that unless EXACTLY false.
    summarize: o.summarize === false ? false : true,
    continueInstruction: o.continueInstruction === true,
    approvalPress: o.approvalPress === true,
  };
  const mode: AgentMode =
    typeof o.mode === 'string' && (ALL_MODES as readonly string[]).includes(o.mode)
      ? (o.mode as AgentMode)
      : typeof o.mode === 'string' && o.mode in LEGACY_MODE_MAP
        ? LEGACY_MODE_MAP[o.mode]
        : deriveMode(caps);
  return { mode, ...caps };
}

type AutonomyFile = Record<string, WorkspaceAutonomy>;

/** Load the whole map; a missing/corrupt file is an empty map (every workspace
 *  then resolves to DEFAULT). Bad keys are dropped. */
function loadAll(dir?: string): AutonomyFile {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getDeckAutonomyPath(dir));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AutonomyFile = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!WORKSPACE_ID_RE.test(k)) continue;
    out[k] = sanitizeEntry(v);
  }
  return out;
}

/** The one read the coalescer needs: resolve a workspace's caps, fail-closed to
 *  DEFAULT on any doubt (bad id, missing entry, torn file). Never throws. */
export function loadWorkspaceAutonomy(workspaceId: string, dir?: string): WorkspaceAutonomy {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return { ...DEFAULT_AUTONOMY };
  try {
    const all = loadAll(dir);
    return all[workspaceId] ?? { ...DEFAULT_AUTONOMY };
  } catch {
    return { ...DEFAULT_AUTONOMY };
  }
}

/** Read every stored entry (for a Settings panel). Workspaces with no entry are
 *  simply absent — the caller renders them as DEFAULT. */
export function loadDeckAutonomy(dir?: string): AutonomyFile {
  return loadAll(dir);
}

/** Merge a partial update into one workspace's caps and persist. Returns the
 *  resolved caps after the merge. A bad workspaceId is a no-op that returns
 *  DEFAULT (never writes a bad key). */
export async function setWorkspaceAutonomy(
  workspaceId: string,
  patch: Partial<WorkspaceAutonomy>,
  dir?: string,
): Promise<WorkspaceAutonomy> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return { ...DEFAULT_AUTONOMY };
  const all = loadAll(dir);
  const current = all[workspaceId] ?? { ...DEFAULT_AUTONOMY };
  const next: WorkspaceAutonomy = {
    // The mode is preserved unless explicitly patched — the loop cap-override
    // path patches ONLY caps and must never silently change the stored mode.
    mode: patch.mode ?? current.mode,
    summarize: typeof patch.summarize === 'boolean' ? patch.summarize : current.summarize,
    continueInstruction:
      typeof patch.continueInstruction === 'boolean'
        ? patch.continueInstruction
        : current.continueInstruction,
    approvalPress:
      typeof patch.approvalPress === 'boolean' ? patch.approvalPress : current.approvalPress,
  };
  all[workspaceId] = next;
  await atomicWriteJSON(getDeckAutonomyPath(dir), all);
  return next;
}

/** Set a workspace's MODE and write the mode-derived caps together (the atomic
 *  "one knob" operation). Returns the resolved entry. A bad workspaceId or an
 *  unknown mode is a no-op returning DEFAULT (never writes a bad key/mode).
 *  The `off` teardown (stop loops / disable schedules) lives in the handler —
 *  this store only owns the mode+caps write. */
export async function setWorkspaceMode(
  workspaceId: string,
  mode: AgentMode,
  dir?: string,
): Promise<WorkspaceAutonomy> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return { ...DEFAULT_AUTONOMY };
  if (!(ALL_MODES as readonly string[]).includes(mode)) return { ...DEFAULT_AUTONOMY };
  const all = loadAll(dir);
  const next: WorkspaceAutonomy = { mode, ...modeToCaps(mode) };
  all[workspaceId] = next;
  await atomicWriteJSON(getDeckAutonomyPath(dir), all);
  return next;
}

/** Resolve just the mode (fail-closed to the product default). */
export function loadWorkspaceMode(workspaceId: string, dir?: string): AgentMode {
  return loadWorkspaceAutonomy(workspaceId, dir).mode;
}
