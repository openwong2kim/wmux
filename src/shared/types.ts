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
}

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
}

// === Notification ===
export type NotificationType = 'info' | 'warning' | 'error' | 'agent';

export interface Notification {
  id: string;
  surfaceId: string;
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

// === Status indicator colors ===
export type WorkspaceStatus = 'active' | 'idle' | 'error' | 'running';

// === Custom keybinding ===
export interface CustomKeybinding {
  id: string;
  key: string;        // e.g. 'F7', 'Ctrl+Shift+1'
  label: string;      // user-defined name
  command: string;    // text to send to terminal
  sendEnter: boolean; // append \n after command
}

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
  company?: { name: string; totalCostEstimate: number } | null;
  memberCosts?: Record<string, number>;
  sessionStartTime?: number;
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

