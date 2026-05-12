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

// === Workspace: a named collection of panes ===
export interface Workspace {
  id: string;
  name: string;
  rootPane: Pane;
  activePaneId: string;
  metadata?: WorkspaceMetadata;
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
}

// === Agent status ===
export type AgentStatus = 'running' | 'complete' | 'error' | 'waiting' | 'idle';

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
  tokenDataByPty?: Record<string, { totalTokens: number; inputTokens: number; outputTokens: number; totalCost: number; lastUpdate: number }>;
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
}

// === Custom Theme Colors ===
export interface CustomThemeColors {
  // CSS variables
  bgBase: string;
  bgMantle: string;
  bgSurface: string;
  bgOverlay: string;
  textMuted: string;
  textSubtle: string;
  textSub: string;
  textSub2: string;
  textMain: string;
  accentCursor: string;
  accentBlue: string;
  accentGreen: string;
  accentRed: string;
  accentYellow: string;
  accentPink: string;
  accentTeal: string;
  accentPurple: string;
  // xterm terminal colors
  xtermBackground: string;
  xtermForeground: string;
  xtermCursor: string;
  xtermSelection: string;
  xtermBlack: string;
  xtermRed: string;
  xtermGreen: string;
  xtermYellow: string;
  xtermBlue: string;
  xtermMagenta: string;
  xtermCyan: string;
  xtermWhite: string;
  xtermBrightBlack: string;
  xtermBrightRed: string;
  xtermBrightGreen: string;
  xtermBrightYellow: string;
  xtermBrightBlue: string;
  xtermBrightMagenta: string;
  xtermBrightCyan: string;
  xtermBrightWhite: string;
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
  from: { workspaceId: string; name: string };
  to: { workspaceId: string; name: string };
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

// === Security: URL validation for SSRF prevention ===

/**
 * Fast preflight validation for browser navigation URLs.
 *
 * This blocks dangerous schemes and obvious private/null/link-local literal
 * addresses before navigation requests leave the caller. Hostname resolution
 * checks are enforced separately in the main process at the actual navigation
 * boundary.
 */
export function validateNavigationUrl(url: string): { valid: boolean; reason?: string } {
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

  // Extract hostname (strip brackets from IPv6)
  const hostname = parsed.hostname.toLowerCase();

  // Allow localhost and IPv4/IPv6 loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return { valid: true };
  }

  // Block IPv6 private/link-local ranges
  if (hostname.startsWith('[') || hostname.includes(':')) {
    // Hostname is an IPv6 address (URL parser strips brackets in .hostname)
    const addr = hostname;
    // Block fc00::/7 (unique local) — starts with fc or fd
    if (addr.startsWith('fc') || addr.startsWith('fd')) {
      return { valid: false, reason: 'Blocked private IPv6 address (fc00::/7)' };
    }
    // Block fe80::/10 (link-local) — starts with fe8, fe9, fea, feb
    if (/^fe[89ab]/.test(addr)) {
      return { valid: false, reason: 'Blocked link-local IPv6 address (fe80::/10)' };
    }
    // ::1 already allowed above; block any other loopback representation
    // Normalize: collapse :: and check
    if (addr === '0:0:0:0:0:0:0:1' || addr === '0000:0000:0000:0000:0000:0000:0000:0001') {
      return { valid: true };
    }

    // Block null IPv6 address (:: or 0:0:0:0:0:0:0:0) — equivalent to 0.0.0.0
    if (addr === '::' || addr === '0:0:0:0:0:0:0:0' || addr === '0000:0000:0000:0000:0000:0000:0000:0000') {
      return { valid: false, reason: 'Blocked null IPv6 address (equivalent to 0.0.0.0)' };
    }

    // Block IPv4-mapped IPv6 (::ffff:x.x.x.x) and IPv4-compatible IPv6 (::x.x.x.x)
    // These resolve to their embedded IPv4 address, bypassing IPv4 private IP checks.
    const v4MappedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
    const v4CompatMatch = !v4MappedMatch ? /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr) : null;
    const embeddedV4 = v4MappedMatch?.[1] ?? v4CompatMatch?.[1];
    if (embeddedV4) {
      // Recursively validate the embedded IPv4 through the same checks
      const embeddedResult = validateNavigationUrl(`http://${embeddedV4}/`);
      if (!embeddedResult.valid) {
        return { valid: false, reason: `Blocked IPv4-mapped/compatible IPv6: embedded ${embeddedV4} — ${embeddedResult.reason}` };
      }
    }

    return { valid: true };
  }

  // Check for IPv4 addresses
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4Match) {
    const octets = [
      parseInt(ipv4Match[1], 10),
      parseInt(ipv4Match[2], 10),
      parseInt(ipv4Match[3], 10),
      parseInt(ipv4Match[4], 10),
    ];

    // 127.0.0.1 already allowed above; block other 127.x.x.x
    if (octets[0] === 127) {
      return { valid: false, reason: 'Blocked loopback address' };
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
  }

  return { valid: true };
}

