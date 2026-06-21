// === Company Mode Types (canonical source: src/company/types.ts) ===
import type {
  AgentPreset as _AgentPreset,
  MemberStatus as _MemberStatus,
  TeamMember as _TeamMember,
  Department as _Department,
  Company as _Company,
  CompanyTemplateMember as _CompanyTemplateMember,
  CompanyTemplateDepartment as _CompanyTemplateDepartment,
  CompanyTemplate as _CompanyTemplate,
  WorktreeInfo as _WorktreeInfo,
  RiskLevel as _RiskLevel,
  ApprovalRequest as _ApprovalRequest,
  MessageRouteEvent as _MessageRouteEvent,
  InboxMessage as _InboxMessage,
} from '../company/types';
import { MAX_INBOX_SIZE as _MAX_INBOX_SIZE } from '../company/types';

// Re-export for backward compatibility
export type AgentPreset = _AgentPreset;
export type MemberStatus = _MemberStatus;
export type TeamMember = _TeamMember;
export type Department = _Department;
export type Company = _Company;
export type CompanyTemplateMember = _CompanyTemplateMember;
export type CompanyTemplateDepartment = _CompanyTemplateDepartment;
export type CompanyTemplate = _CompanyTemplate;
export type WorktreeInfo = _WorktreeInfo;
export type RiskLevel = _RiskLevel;
export type ApprovalRequest = _ApprovalRequest;
export type MessageRouteEvent = _MessageRouteEvent;
export type InboxMessage = _InboxMessage;
export const MAX_INBOX_SIZE = _MAX_INBOX_SIZE;

// === Surface: a single terminal instance within a Pane ===
export interface Surface {
  id: string;
  ptyId: string;
  title: string;
  shell: string;
  cwd: string;
  surfaceType?: 'terminal' | 'browser' | 'editor';
  browserUrl?: string;
  browserPartition?: string;
  editorFilePath?: string;
  scrollbackFile?: string;  // surfaceId used as filename for scrollback dump
  /** True once the user manually renamed this tab; blocks shell-set (OSC 0/2) titles. */
  titleLocked?: boolean;
}

// === Pane: either a leaf (has surfaces) or a branch (has children) ===
export interface PaneLeaf {
  id: string;
  type: 'leaf';
  surfaces: Surface[];
  activeSurfaceId: string;
  metadata?: PaneMetadata;
}

// === Pane Metadata: optional descriptive labels for external tooling ===
// Total serialized size capped at PANE_METADATA_MAX_BYTES so a misbehaving
// caller can't bloat session.json. Branches never carry metadata — only leaves.
export interface PaneMetadata {
  label?: string;
  role?: string;
  status?: string;
  custom?: Record<string, string>;
  updatedAt?: number;
}

export const PANE_METADATA_MAX_BYTES = 8 * 1024;
export const PANE_METADATA_LABEL_MAX = 64;
export const PANE_METADATA_ROLE_MAX = 64;
export const PANE_METADATA_STATUS_MAX = 128;
export const PANE_METADATA_CUSTOM_KEY_MAX = 64;
export const PANE_METADATA_CUSTOM_MAX_ENTRIES = 32;

export interface PaneBranch {
  id: string;
  type: 'branch';
  direction: 'horizontal' | 'vertical';
  children: Pane[];
  sizes?: number[];
}

export type Pane = PaneLeaf | PaneBranch;

// === Workspace Profile ===
// Per-workspace process profile applied to NEW panes only. Generic by design:
// it carries environment variables and an optional startup command, so it can
// drive Claude/Codex/Gemini config dirs, SSH wrappers, or any CLI tool without
// the app hardcoding a provider. This is environment separation for new child
// PTYs — NOT an OS-level security sandbox.
//
// Stored on Workspace (persisted in session.json), deliberately NOT on
// WorkspaceMetadata: metadata is published over event/RPC paths and is the
// wrong surface for user-entered, potentially secret-adjacent values.
export interface WorkspaceProfile {
  /** Env vars merged into new PTYs after the safe-inherited baseline. */
  env?: Record<string, string>;
  /** Optional command written into each new pane's shell after creation. */
  defaultPaneCommand?: string;
  /**
   * Starting directory for new terminals in this workspace. Overrides the
   * global startupDirectory setting; overridden by split CWD inheritance.
   * Tolerant at spawn time: a missing/invalid path falls back to homedir
   * (validateCwd in pty.handler), so a disconnected drive never hard-fails.
   */
  startupCwd?: string;
}

// Validation caps — enforced by shared/workspaceProfile.ts.
export const WORKSPACE_PROFILE_MAX_ENV_ENTRIES = 64;
export const WORKSPACE_PROFILE_ENV_KEY_MAX = 128;
export const WORKSPACE_PROFILE_ENV_VALUE_MAX = 8192;
export const WORKSPACE_PROFILE_COMMAND_MAX = 4096;
export const WORKSPACE_PROFILE_STARTUP_CWD_MAX = 1024;

// === Workspace: a named collection of panes ===
export interface Workspace {
  id: string;
  name: string;
  rootPane: Pane;
  activePaneId: string;
  metadata?: WorkspaceMetadata;
  /** Per-workspace process profile (env + startup command) for new panes. */
  profile?: WorkspaceProfile;
  companyRole?: 'ceo' | 'lead' | 'member';
  companyDeptName?: string;
}

// === Cross-Pane Search (T-A) ===
export interface PaneSearchResult {
  paneId: string;
  surfaceId: string;
  ptyId: string;
  lineIdx: number;             // logical line idx (post wrap-coalesce — see T-B)
  /**
   * Physical row index of the FIRST row composing the matched logical line.
   * This is the value to feed into `xterm.scrollToLine(...)` — feeding
   * `lineIdx` instead would land on the wrong row when wrap-coalescing
   * collapsed multiple physical rows into one logical line. (I6 fix.)
   */
  physicalBaseY: number;
  text: string;                // matched logical line, ≤500 chars
  contextBefore: string[];     // up to N (default 2) lines, each ≤500 chars
  contextAfter: string[];
  paneLabel?: string;          // optional — populated when PR #16 metadata is present
}

export interface PaneSearchResponse {
  resultShapeVersion: 1;       // literal type, not number — for exhaustive switches
  results: PaneSearchResult[];
  truncated: boolean;
  totalMatches: number;
  workspaceId: string;
}

// === Notification ===
export type NotificationType = 'info' | 'warning' | 'error' | 'agent';

export interface Notification {
  id: string;
  // Optional: app-level / workspace-level notifications (e.g. from MCP `notify` RPC
  // without an originating PTY) have no specific surface. Renderer resolves the
  // active surface from store when displaying, or treats it as workspace-scoped.
  surfaceId?: string;
  workspaceId: string;
  type: NotificationType;
  title: string;
  body: string;
  timestamp: number;
  read: boolean;
}

// === Workspace Metadata ===
export interface WorkspaceMetadata {
  gitBranch?: string;
  cwd?: string;
  listeningPorts?: number[];
  lastNotification?: number;
  status?: string;
  progress?: number;
  agentName?: string;
  agentStatus?: AgentStatus;
  // Per-workspace notification mute (Notification System Expansion T4).
  // Policy A4: "surface off, data preserved" — muted workspaces still
  // record notifications in the panel, but the bell badge math excludes
  // them, and the listener (T7) skips toast/sound/ring/flashFrame.
  // undefined === false === not muted.
  notificationsMuted?: boolean;
  // ── X1 workspace-context sidebar (schema-freeze §2, additive) ──
  /** True when gitBranch comes from a linked worktree, not the main checkout. */
  gitIsWorktree?: boolean;
  /** PR for the current branch, from `gh pr view --json` (5 min TTL cache).
   *  Absent when gh is not installed or no PR exists. `null` clears. */
  pr?: PrStatus | null;
  /** Latest notification.received summary for the sidebar line. */
  lastNotificationText?: LastNotificationText;
}

/** X1 — PR status for the current branch (schema-freeze §2). */
export interface PrStatus {
  number: number;
  state: 'open' | 'draft' | 'merged' | 'closed';
  checks: 'pending' | 'passing' | 'failing' | null;
  url: string;
}

/** X1 — latest terminal notification summary (schema-freeze §2). */
export interface LastNotificationText {
  ts: number;
  title: string | null;
  body: string;
  source: 'osc9' | 'osc777' | 'osc99';
}

// === Agent status ===
// 'awaiting_input' — agent paused mid-turn for a confirmation prompt (y/N,
// approval gate) and is blocked until the user responds. Distinct from
// 'waiting' (which means "turn ended, ready for next instruction").
export type AgentStatus =
  | 'running'
  | 'complete'
  | 'error'
  | 'waiting'
  | 'awaiting_input'
  | 'idle';

// === Metadata update IPC payload ===
// Single discriminated payload shape used by IPC.METADATA_UPDATE. Sender (main)
// includes whichever fields changed; receiver (renderer) merges into the
// workspace identified by ptyId (preferred) or workspaceId (fallback for
// surface-less updates like session sanitize on restore).
//
// Migration: replaces the previous inconsistent 2-arg (ptyId, data) vs 1-arg
// (payload) patterns scattered across PTYBridge, meta.rpc, and metadata.handler.
export interface MetadataUpdatePayload {
  ptyId?: string;
  workspaceId?: string;
  gitBranch?: string;
  cwd?: string;
  listeningPorts?: number[];
  agentStatus?: AgentStatus;
  agentName?: string;
  // External RPC channels (meta.setStatus / meta.setProgress) write through
  // the same payload. Renderer applies these to the active workspace when no
  // ptyId/workspaceId is provided.
  status?: string;
  progress?: number;
  // X1 workspace-context fields (schema-freeze §2). `pr: null` clears a PR
  // that no longer applies (branch switched, PR closed without successor).
  gitIsWorktree?: boolean;
  pr?: PrStatus | null;
  lastNotificationText?: LastNotificationText;
  // Fleet View per-pane activity line (fleet-activity-line-hook.md). Derived in
  // hooks.rpc from a PostToolUse hook's tool_name/tool_input via
  // summarizeActivity(). Per-ptyId ONLY — the renderer stores it in the
  // transient surfaceActivity[ptyId] map and MUST destructure it out before
  // applying any active-pane update to workspace metadata (it is not workspace
  // state). Never persisted.
  activity?: string;
}

// === Status indicator colors ===
export type WorkspaceStatus = 'active' | 'idle' | 'error' | 'running';

// === Layout Templates ===
export interface LayoutNodeLeaf {
  type: 'leaf';
}

export interface LayoutNodeBranch {
  type: 'branch';
  direction: 'horizontal' | 'vertical';
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = LayoutNodeLeaf | LayoutNodeBranch;

export interface LayoutTemplate {
  id: string;
  name: string;
  builtin?: boolean;
  tree: LayoutNode;
}

export const BUILTIN_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'builtin-2col',
    name: '2 Columns',
    builtin: true,
    tree: { type: 'branch', direction: 'horizontal', sizes: [50, 50], children: [{ type: 'leaf' }, { type: 'leaf' }] },
  },
  {
    id: 'builtin-2row',
    name: '2 Rows',
    builtin: true,
    tree: { type: 'branch', direction: 'vertical', sizes: [50, 50], children: [{ type: 'leaf' }, { type: 'leaf' }] },
  },
  {
    id: 'builtin-3col',
    name: '3 Columns',
    builtin: true,
    tree: { type: 'branch', direction: 'horizontal', sizes: [33, 34, 33], children: [{ type: 'leaf' }, { type: 'leaf' }, { type: 'leaf' }] },
  },
  {
    id: 'builtin-main-side',
    name: 'Main + Side',
    builtin: true,
    tree: { type: 'branch', direction: 'horizontal', sizes: [70, 30], children: [{ type: 'leaf' }, { type: 'leaf' }] },
  },
  {
    id: 'builtin-grid',
    name: '2x2 Grid',
    builtin: true,
    tree: {
      type: 'branch', direction: 'vertical', sizes: [50, 50],
      children: [
        { type: 'branch', direction: 'horizontal', sizes: [50, 50], children: [{ type: 'leaf' }, { type: 'leaf' }] },
        { type: 'branch', direction: 'horizontal', sizes: [50, 50], children: [{ type: 'leaf' }, { type: 'leaf' }] },
      ],
    },
  },
];

// === Custom keybinding ===
export interface CustomKeybinding {
  id: string;
  key: string;        // e.g. 'F7', 'Ctrl+Shift+1'
  label: string;      // user-defined name
  command: string;    // text to send to terminal
  sendEnter: boolean; // append \n after command
}

/**
 * Built-in custom keybindings seeded into uiSlice initial state and used as
 * the backfill source when restoring a saved session. Single source of truth
 * so the load-merge in workspaceSlice never drifts from the uiSlice default.
 * Entries are identified by their `kb-default-*` id; user edits to a default
 * win on load (saved entry kept), while a default missing from an older saved
 * session is back-filled so shipping a new built-in never silently drops it.
 */
export const DEFAULT_CUSTOM_KEYBINDINGS: CustomKeybinding[] = [
  {
    id: 'kb-default-f7',
    key: 'F7',
    label: 'Claude (skip permissions)',
    command: 'claude --dangerously-skip-permissions',
    sendEnter: true,
  },
];

// === Prefix mode bindings ===
export interface PrefixConfig {
  key: string;  // e.code value for the prefix trigger, e.g. 'KeyB'
  bindings: Record<string, string>;  // key → action id
}

export const DEFAULT_PREFIX_CONFIG: PrefixConfig = {
  key: 'KeyB',
  bindings: {
    '%': 'splitHorizontal',
    '"': 'splitVertical',
    'x': 'closePane',
    'c': 'newWorkspace',
    'n': 'nextWorkspace',
    'p': 'prevWorkspace',
    'd': 'hideWindow',
    'z': 'toggleZoom',
    ':': 'commandPalette',
    ',': 'renameWorkspace',
    '&': 'killWorkspace',
    '?': 'showCheatSheet',
    'ArrowUp': 'focusUp',
    'ArrowDown': 'focusDown',
    'ArrowLeft': 'focusLeft',
    'ArrowRight': 'focusRight',
  },
};

// === Session: serialized app state ===
export interface SessionData {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  sidebarVisible: boolean;
  // User preferences (persisted across restarts)
  theme?: string;
  locale?: string;
  terminalFontSize?: number;
  terminalFontFamily?: string;
  defaultShell?: string;
  scrollbackLines?: number;
  /**
   * Issue #174: whether a pane created by splitting inherits the splitting
   * pane's current working directory (OSC 7-tracked). Default true.
   */
  splitInheritsCwd?: boolean;
  /**
   * Issue #167 idle-clearing of xterm's hidden IME textarea (protects
   * against field-replacing voice injectors). Default false since v3.1.1 —
   * the wipe is the prime suspect for IME claim storms that deaden input.
   */
  imeResidueGuardEnabled?: boolean;
  /**
   * Issue #175: global default starting directory for new terminals.
   * Empty/unset → os.homedir(). Per-workspace profile.startupCwd overrides.
   */
  startupDirectory?: string;
  /**
   * User setting: whether to attempt scrollback restore on launch.
   * true (default) — daemon-side ringBuffer replay + reconnect on Terminal mount.
   * false — startup clearAllPtyState; every pane mounts fresh. Daemon still
   *   dumps ringBuffers on graceful Quit (renderer just doesn't read them);
   *   StateWriter.cleanOrphanedBuffers + SUSPENDED_TTL_HOURS reap the .buf
   *   files within ~1 launch cycle and 7 days respectively.
   */
  scrollbackRestoreEnabled?: boolean;
  /**
   * Global YOLO setting for A2A execute:true requests. Default false.
   * When true, incoming A2A execute requests may spawn Claude with
   * bypassPermissions without showing the per-request approval prompt.
   */
  a2aAutoApproveExecute?: boolean;
  sidebarPosition?: 'left' | 'right';
  notificationSoundEnabled?: boolean;
  toastEnabled?: boolean;
  notificationRingEnabled?: boolean;
  customKeybindings?: CustomKeybinding[];
  autoUpdateEnabled?: boolean;
  customThemeColors?: CustomThemeColors;
  sidebarMode?: 'workspaces' | 'company';
  company?: Company | null;
  memberCosts?: Record<string, number>;
  sessionStartTime?: number;
  onboardingCompleted?: boolean;
  // First-run wizard (Plan 1.15) — magical-moment onboarding marker.
  // Optional so older saved sessions deserialize cleanly (default: false on read).
  firstRunCompleted?: boolean;
  // Cheat sheet "Don't show again" toggle (Plan 1.18, D11). Persisted via uiSlice.
  cheatSheetDismissed?: boolean;
  floatingPanePtyId?: string | null;
  layoutTemplates?: LayoutTemplate[];
  recentCommands?: string[];
  prefixConfig?: PrefixConfig;
  // Agent toolbar (2026-06-14). Non-sensitive prefs only — rich-input drafts
  // and transcript content are never persisted.
  agentToolbarEnabled?: boolean;
  agentToolbarSnippets?: { id: string; label: string; text: string }[];
  agentToolbarNewCommand?: string;
}

// === xterm 20-slot ANSI palette ===
// Background, foreground, cursor, selection + 16 ANSI colors (8 normal + 8 bright).
// Lives in shared/types so CustomThemeColors can reference Partial<XtermThemeColors>
// for per-color overrides without an import cycle into the renderer-side themes.ts.
export interface XtermThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

// === Custom Theme Colors ===
// 10 manual UI tokens + an xterm palette preset id + optional per-color overrides.
// The renderer derives the remaining 4 CSS variables (bgOverlay, textSubtle,
// textSub2, accentCursor) from the 10 tokens via deriveFullPalette().
// xtermOverrides lets the user fine-tune the terminal palette on top of the
// chosen preset; any key present here replaces the preset value at runtime.
export interface CustomThemeColors {
  // Background tier
  bgBase: string;
  bgSurface: string;
  bgMantle: string;
  // Text tier
  textMain: string;
  textSub: string;
  textMuted: string;
  // Semantic accents
  accent: string;
  success: string;
  danger: string;
  warning: string;
  // Terminal 16-color ANSI palette: pick a preset, then optionally override
  // individual slots. Unset slots fall through to the preset.
  xtermPaletteId: string;
  xtermOverrides?: Partial<XtermThemeColors>;
}

// === A2A Protocol Types (Google A2A Standard) ===

// --- Part types (kind discriminant, per A2A spec) ---

export type TextPart = { kind: 'text'; text: string; metadata?: Record<string, unknown> };
export type FilePart = { kind: 'file'; file: { name?: string; mimeType?: string; bytes?: string; uri?: string }; metadata?: Record<string, unknown> };
export type DataPart = { kind: 'data'; data: Record<string, unknown>; metadata?: Record<string, unknown> };
export type Part = TextPart | FilePart | DataPart;

// --- Message ---

export interface Message {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: Part[];
  metadata?: Record<string, unknown>;
}

// --- Task state & status ---

export type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

/** Every valid TaskState, in declaration order — the single source for isTaskState. */
export const TASK_STATES: readonly TaskState[] = [
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
];

/**
 * Runtime type guard for TaskState. Authored for LanLink PR-4 (C10): a `state`
 * field decoded from an UNTRUSTED LAN wire message must be membership-validated
 * before it is attached to a durable inbox record, so a hostile value can never
 * become a `VALID_TRANSITIONS[state]` lookup key (prototype / type-confusion) on
 * any downstream consumer. Rejects non-strings, objects, and `'constructor'` etc.
 */
export function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && (TASK_STATES as readonly string[]).includes(v);
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp: string; // ISO 8601
}

/** Valid state transitions for A2A tasks */
export const VALID_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  submitted: ['working', 'canceled'],
  working: ['completed', 'failed', 'canceled', 'input-required'],
  'input-required': ['working', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

/** Validate whether a status transition is allowed */
export function validateTransition(from: TaskState, to: TaskState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** Terminal states — tasks in these states are eligible for GC */
export const TERMINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'canceled'];

// --- Artifact ---

export interface Artifact {
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
}

// --- wmux task metadata extension ---

export interface WmuxTaskMetadata {
  title: string;
  // Pane-level addressing: `paneId`/`surfaceId` pin the task to a specific
  // pane/surface inside a workspace so delivery lands on the intended agent when
  // a workspace hosts more than one. `to` is the receiver pin (Part A, #235);
  // `from` is the symmetric sender pin (S-C2) so a reply can return to the exact
  // originating pane and the stored history role is computed per-pane. Both
  // sides optional — a ws-only side keeps active-pane delivery / ws-level role.
  // Always ws-scoped: the id must belong to its own `workspaceId` (validated at
  // delivery; cross-ws is refused).
  from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
  to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  [key: string]: unknown;
}

// --- Task (A2A standard + wmux extensions in metadata) ---

export interface Task {
  kind: 'task';
  id: string;
  status: TaskStatus;
  history: Message[];
  artifacts: Artifact[];
  metadata: WmuxTaskMetadata;
}

// --- Agent discovery ---

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface AgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  capabilities: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills: AgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  metadata?: {
    workspaceId: string;
    status: 'idle' | 'busy' | 'offline';
    [key: string]: unknown;
  };
}

// === Utility: generate unique IDs ===
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// === Security: sanitize text before PTY write ===

/**
 * Strips dangerous control characters from text before writing to a PTY.
 * Removes: NULL byte (\x00) and C1 control characters (\x80-\x9f).
 * Preserves: CR (\r), LF (\n), Tab (\t), ESC sequences (\x1b[...),
 * and other standard terminal control characters needed for normal operation.
 */
export function sanitizePtyText(text: string): string {
  // Remove NULL byte and C1 control characters (U+0080–U+009F)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00\u0080-\u009f]/g, '');
}

/**
 * Validates and clamps a user-supplied name string.
 * Returns the trimmed string if valid, or throws if invalid.
 */
export function validateName(value: string, label: string, maxLength = 100): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

/**
 * Validates a message body string.
 * Returns the trimmed string if valid, or throws if invalid.
 */
export function validateMessage(value: string, maxLength = 10000): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Message must not be empty');
  }
  if (trimmed.length > maxLength) {
    throw new Error(`Message must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

// === Factory functions ===
export function createSurface(ptyId: string, shell: string, cwd: string): Surface {
  return {
    id: generateId('surface'),
    ptyId,
    title: shell,
    shell,
    cwd,
  };
}

export function createLeafPane(surface?: Surface): PaneLeaf {
  const surfaces = surface ? [surface] : [];
  return {
    id: generateId('pane'),
    type: 'leaf',
    surfaces,
    activeSurfaceId: surfaces[0]?.id || '',
  };
}

export function createWorkspace(name: string): Workspace {
  const rootPane = createLeafPane();
  return {
    id: generateId('ws'),
    name,
    rootPane,
    activePaneId: rootPane.id,
  };
}

/**
 * Deep-clone a pane tree for workspace duplication.
 *
 * Every pane and surface id is regenerated (ids must stay globally unique) and
 * each surface's `ptyId` is cleared + `scrollbackFile` dropped, so the cloned
 * panes spawn FRESH PTYs on mount (Terminal self-create path) instead of
 * aliasing the source workspace's live sessions or replaying its scrollback.
 *
 * Everything that defines the *shape and intent* of the layout is preserved:
 * branch direction/sizes, and each surface's shell, cwd, surfaceType, browser
 * URL/partition, editor path, and title — plus leaf pane metadata. Browser and
 * editor surfaces keep their content pointer (URL / file path) so a duplicated
 * layout reopens to the same places.
 */
export function clonePaneTreeFresh(pane: Pane): Pane {
  if (pane.type === 'leaf') {
    const surfaces: Surface[] = pane.surfaces.map((s) => {
      // Spread to preserve shell/cwd/type and any browser/editor pointers,
      // then reset ptyId and drop scrollbackFile (keyed by the OLD surface id)
      // so the clone is a clean slate that spawns its own PTY on mount.
      const next: Surface = { ...s, id: generateId('surface'), ptyId: '' };
      delete next.scrollbackFile;
      return next;
    });
    // Preserve which surface was active by POSITION, since ids changed.
    const activeIdx = pane.surfaces.findIndex((s) => s.id === pane.activeSurfaceId);
    return {
      id: generateId('pane'),
      type: 'leaf',
      surfaces,
      activeSurfaceId: surfaces[activeIdx >= 0 ? activeIdx : 0]?.id ?? '',
      ...(pane.metadata ? { metadata: { ...pane.metadata } } : {}),
    };
  }
  return {
    id: generateId('pane'),
    type: 'branch',
    direction: pane.direction,
    children: pane.children.map(clonePaneTreeFresh),
    ...(pane.sizes ? { sizes: [...pane.sizes] } : {}),
  };
}

// === Security: URL validation for SSRF prevention ===

type UrlValidationResult = { valid: boolean; reason?: string };

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }

  return octets;
}

function validateIpv4NavigationAddress(address: string): UrlValidationResult {
  const octets = parseIpv4Octets(address);
  if (!octets) return { valid: false, reason: `Invalid IPv4 address: ${address}` };

  // 127.0.0.1 is allowed for local development; block other 127.x.x.x.
  if (octets[0] === 127) {
    return octets[1] === 0 && octets[2] === 0 && octets[3] === 1
      ? { valid: true }
      : { valid: false, reason: 'Blocked loopback address' };
  }

  // Block 10.0.0.0/8
  if (octets[0] === 10) {
    return { valid: false, reason: 'Blocked private IP address (10.0.0.0/8)' };
  }

  // Block 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
    return { valid: false, reason: 'Blocked private IP address (172.16.0.0/12)' };
  }

  // Block 192.168.0.0/16
  if (octets[0] === 192 && octets[1] === 168) {
    return { valid: false, reason: 'Blocked private IP address (192.168.0.0/16)' };
  }

  // Block 169.254.0.0/16 (link-local, includes cloud metadata 169.254.169.254)
  if (octets[0] === 169 && octets[1] === 254) {
    return { valid: false, reason: 'Blocked link-local/cloud metadata address (169.254.0.0/16)' };
  }

  // Block 0.0.0.0
  if (octets.every((o) => o === 0)) {
    return { valid: false, reason: 'Blocked null address (0.0.0.0)' };
  }

  return { valid: true };
}

function expandIpv6NavigationAddress(address: string): string[] | null {
  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(':');

  if (normalized.includes('.') && lastColon !== -1) {
    const embeddedIpv4 = normalized.slice(lastColon + 1);
    const octets = parseIpv4Octets(embeddedIpv4);
    if (!octets) return null;

    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const pieces = normalized.split('::');
  if (pieces.length > 2) return null;

  const [head, tail] = pieces;
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const allParts = [...headParts, ...tailParts];
  if (allParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) {
    return null;
  }

  if (!normalized.includes('::')) {
    return headParts.length === 8 ? headParts.map((part) => part.padStart(4, '0')) : null;
  }

  const missingGroups = 8 - allParts.length;
  if (missingGroups < 1) return null;

  return [
    ...headParts.map((part) => part.padStart(4, '0')),
    ...Array.from({ length: missingGroups }, () => '0000'),
    ...tailParts.map((part) => part.padStart(4, '0')),
  ];
}

function validateIpv6NavigationAddress(address: string): UrlValidationResult {
  const expanded = expandIpv6NavigationAddress(address);
  if (!expanded) return { valid: false, reason: `Invalid IPv6 address: ${address}` };

  const compact = expanded.join(':');
  if (compact === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return { valid: false, reason: 'Blocked null IPv6 address (equivalent to 0.0.0.0)' };
  }
  if (compact === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return { valid: true };
  }

  // Block IPv4-mapped IPv6 (::ffff:x.x.x.x / ::ffff:hhhh:hhhh) and
  // IPv4-compatible IPv6 (::x.x.x.x / ::hhhh:hhhh) by validating the embedded
  // IPv4 address after WHATWG URL normalization has converted dotted quads to
  // hexadecimal groups.
  const isIpv4Mapped = expanded.slice(0, 5).every((group) => group === '0000') && expanded[5] === 'ffff';
  const isIpv4Compatible = expanded.slice(0, 6).every((group) => group === '0000');
  if (isIpv4Mapped || isIpv4Compatible) {
    const hi = Number.parseInt(expanded[6], 16);
    const lo = Number.parseInt(expanded[7], 16);
    const ipv4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    const embeddedResult = validateIpv4NavigationAddress(ipv4);
    if (!embeddedResult.valid) {
      return { valid: false, reason: `Blocked IPv4-mapped/compatible IPv6: embedded ${ipv4} — ${embeddedResult.reason}` };
    }
  }

  const firstGroup = Number.parseInt(expanded[0], 16);
  if ((firstGroup & 0xfe00) === 0xfc00) {
    return { valid: false, reason: 'Blocked private IPv6 address (fc00::/7)' };
  }
  if ((firstGroup & 0xffc0) === 0xfe80) {
    return { valid: false, reason: 'Blocked link-local IPv6 address (fe80::/10)' };
  }

  return { valid: true };
}

/**
 * Fast preflight validation for browser navigation URLs.
 *
 * This blocks dangerous schemes and obvious private/null/link-local literal
 * addresses before navigation requests leave the caller. Hostname resolution
 * checks are enforced separately in the main process at the actual navigation
 * boundary.
 */
export function validateNavigationUrl(url: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  // Only allow http and https schemes
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { valid: false, reason: `Blocked URL scheme: ${scheme}` };
  }

  // WHATWG URL keeps IPv6 literals bracketed in Node/Electron. Strip the
  // brackets before doing range checks so private/link-local prefixes and
  // IPv4-mapped forms cannot bypass validation.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // Allow localhost and IPv4/IPv6 loopback
  if (hostname === 'localhost') {
    return { valid: true };
  }

  if (hostname.includes(':')) {
    return validateIpv6NavigationAddress(hostname);
  }

  // Check for IPv4 addresses
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return validateIpv4NavigationAddress(hostname);
  }

  return { valid: true };
}

