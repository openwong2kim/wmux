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

// ─── Agent mode (per-workspace, owner design 2026-07-13, revised 2026-08-01) ──
//
// The user-facing control, and the answer to ONE question: HOW is the terminal
// brain's `claude` launched for this workspace?
//
//   off      the terminal brain does not run at all. Nothing spawns, and the
//            deck composer is disabled — there is nobody to type to. The
//            handler ALSO tears down running loops + disables cadence
//            schedules (kill switch).
//   assist   launch Claude in AUTO mode — `--permission-mode acceptEdits`.
//            It edits without asking, but every other permission prompt still
//            stops it.
//   danger   launch Claude in BYPASS mode — `--dangerously-skip-permissions`.
//            Nothing prompts. (This is the mode formerly called `auto`; the
//            rename is what turned the knob from a wake policy into a launch
//            policy.)
//
// WAKE POLICY IS A SEPARATE AXIS (2026-08-01). It used to be derived from the
// mode, which conflated two unrelated questions — "how much may this brain do
// without asking" and "what should wake it". They are now stored side by side:
// `wakePolicy` lives on the entry and is what the coalescer reads. modeToWakePolicy
// survives only to seed it (see below).
//
//   wake policy:  'none' | 'value-filtered' | 'all'
//   (a RUNNING loop overrides to 'all' regardless of the stored policy,
//    mirroring the global auto-wake switch's loop carve-out.)
//
// Legacy mode values are mapped on read (sanitizeEntry): 'manual' → 'off',
// and both 'orchestrate' (four-mode era) and 'auto' (the pre-rename danger
// mode) → 'danger'.
export type AgentMode = 'off' | 'assist' | 'danger';

export type WakePolicy = 'none' | 'value-filtered' | 'all';

/**
 * The wake policy a mode implies.
 *
 * MIGRATION / DEFAULT SEED ONLY — never a runtime read. Wake policy is its own
 * stored axis now (`WorkspaceAutonomy.wakePolicy`); every consumer reads that
 * field. This function exists so an entry written before the split (or a brand
 * new one) lands on the wake behaviour it had under the old derived scheme:
 * off → 'none', assist → 'value-filtered', auto/danger → 'all'. That is what
 * makes the split behaviour-preserving for existing deck-autonomy.json files.
 */
export function modeToWakePolicy(mode: AgentMode): WakePolicy {
  switch (mode) {
    case 'danger':
      return 'all';
    case 'assist':
      return 'value-filtered';
    case 'off':
      return 'none';
  }
}

export interface WorkspaceAutonomy {
  /** The user-facing mode this workspace is in — HOW the brain is launched.
   *  Source of truth; the three caps below are derived from it on write (a loop
   *  may transiently override the caps, never the mode). */
  mode: AgentMode;
  /** What wakes this workspace's brain. An INDEPENDENT axis from `mode`: a
   *  mode write never silently rewrites it (see setWorkspaceMode). Seeded from
   *  the mode on first read of a pre-split entry. */
  wakePolicy: WakePolicy;
  /** Open a turn that reports fleet state and stops. Default on. */
  summarize: boolean;
  /** Brain may send a follow-up instruction into a pane. Default off. */
  continueInstruction: boolean;
  /** Brain may press y/1/2/3 on an approval prompt. Default off. */
  approvalPress: boolean;
}

/** The three raw caps, without the two policy axes (mode + wakePolicy). */
export type AutonomyCaps = Pick<
  WorkspaceAutonomy,
  'summarize' | 'continueInstruction' | 'approvalPress'
>;

const ALL_MODES: readonly AgentMode[] = ['off', 'assist', 'danger'];

const ALL_WAKE_POLICIES: readonly WakePolicy[] = ['none', 'value-filtered', 'all'];

/** Legacy mode values mapped on read. `manual`/`orchestrate` are the four-mode
 *  era (pre-2026-07-17); `auto` is what `danger` was called before the mode
 *  became a LAUNCH policy (2026-08-01). This is the one migration seam — every
 *  renamed mode goes through it rather than growing a second one. */
const LEGACY_MODE_MAP: Readonly<Record<string, AgentMode>> = {
  manual: 'off',
  orchestrate: 'danger',
  auto: 'danger',
};

/** Derive the three raw caps from a mode. The dangerous cap (approvalPress)
 *  stays OFF except in `danger`, so a fresh/corrupt workspace never gains
 *  auto-approval. `continueInstruction` is on for assist/danger but only
 *  bites under a running loop (ambient assist drops plain stops via the value
 *  filter), so an ambient assist workspace is a notifier, not a driver. */
export function modeToCaps(mode: AgentMode): AutonomyCaps {
  switch (mode) {
    case 'danger':
      return { summarize: true, continueInstruction: true, approvalPress: true };
    case 'assist':
      return { summarize: true, continueInstruction: true, approvalPress: false };
    case 'off':
      return { summarize: false, continueInstruction: false, approvalPress: false };
  }
}

/** Back-derive a mode from raw caps — used ONLY for legacy files written before
 *  the `mode` field existed (after that the mode is always stored). Maps by the
 *  dangerous caps: approval → danger; continue → assist; else → the product
 *  default (off — fail-closed, owner decision 2026-07-17). */
export function deriveMode(caps: AutonomyCaps): AgentMode {
  if (caps.approvalPress) return 'danger';
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
  wakePolicy: modeToWakePolicy(DEFAULT_MODE),
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
 *  from its caps (deriveMode) so old files keep working.
 *
 *  WAKE POLICY MIGRATION: an entry with no valid `wakePolicy` — i.e. every file
 *  written before the mode became a launch policy — is seeded with
 *  modeToWakePolicy(mode), computed from the ALREADY legacy-mapped mode. That
 *  reproduces exactly the wake behaviour the entry had when the policy was
 *  derived, so the split changes nothing for existing installs. */
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
  const wakePolicy: WakePolicy =
    typeof o.wakePolicy === 'string' && (ALL_WAKE_POLICIES as readonly string[]).includes(o.wakePolicy)
      ? (o.wakePolicy as WakePolicy)
      : modeToWakePolicy(mode);
  return { mode, wakePolicy, ...caps };
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
    // Same for the wake policy: it is its own axis, so only an explicit patch
    // moves it (a mode patch here does NOT re-derive it).
    wakePolicy: patch.wakePolicy ?? current.wakePolicy,
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
  emitAutonomyWritten();
  return next;
}

/** Set a workspace's MODE and write the mode-derived caps together (the atomic
 *  "one knob" operation). Returns the resolved entry. A bad workspaceId or an
 *  unknown mode is a no-op returning DEFAULT (never writes a bad key/mode).
 *  The `off` teardown (stop loops / disable schedules) lives in the handler —
 *  this store only owns the mode+caps write.
 *
 *  The WAKE POLICY IS NOT TOUCHED for a workspace that already has an entry: it
 *  is an independent axis, and clobbering it here would mean the mode picker
 *  silently rewrote a wake setting the operator chose. A workspace with no
 *  entry yet has no stored policy to preserve, so it is seeded from the mode
 *  (modeToWakePolicy) exactly as the migration does. */
export async function setWorkspaceMode(
  workspaceId: string,
  mode: AgentMode,
  dir?: string,
): Promise<WorkspaceAutonomy> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return { ...DEFAULT_AUTONOMY };
  if (!(ALL_MODES as readonly string[]).includes(mode)) return { ...DEFAULT_AUTONOMY };
  const all = loadAll(dir);
  const current = all[workspaceId];
  const next: WorkspaceAutonomy = {
    mode,
    wakePolicy: current ? current.wakePolicy : modeToWakePolicy(mode),
    ...modeToCaps(mode),
  };
  all[workspaceId] = next;
  await atomicWriteJSON(getDeckAutonomyPath(dir), all);
  emitAutonomyWritten();
  return next;
}

/** Resolve just the mode (fail-closed to the product default). */
export function loadWorkspaceMode(workspaceId: string, dir?: string): AgentMode {
  return loadWorkspaceAutonomy(workspaceId, dir).mode;
}

// ── Change notification ─────────────────────────────────────────────────────
//
// The daemon needs to know a workspace's autonomy mode to decide whether an
// AUTOMATED approval press may land in it, and it cannot read this file (it is
// main's store, and a daemon→main fetch would hang with the GUI closed). So
// main pushes, and this is how the push learns a write happened. Deliberately
// a bare "something changed" signal rather than a diff: the subscriber sends
// the whole table anyway (workspaceFactsFeed.ts), so a payload here would only
// be a second thing to keep correct.

const writeListeners = new Set<() => void>();

/** Subscribe to "a workspace's autonomy was written". Returns the unsubscribe. */
export function onAutonomyWritten(listener: () => void): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

function emitAutonomyWritten(): void {
  for (const listener of writeListeners) {
    try {
      listener();
    } catch (err) {
      // A broken subscriber must never fail the write that already landed.
      console.warn(`[deck] autonomy write listener threw: ${String(err)}`);
    }
  }
}
