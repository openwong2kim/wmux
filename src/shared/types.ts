// === Surface: a single terminal instance within a Pane ===
export interface Surface {
  id: string;
  ptyId: string;
  title: string;
  shell: string;
  cwd: string;
  surfaceType?: 'terminal' | 'browser';
  browserUrl?: string;
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

// === Session: serialized app state ===
export interface SessionData {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  sidebarVisible: boolean;
}

// === Utility: generate unique IDs ===
export function generateId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// === Security: sanitize text before PTY write ===

/**
 * Strips control characters (\r, \n, \x00-\x1f except \t) from text
 * that will be written to a PTY, preventing embedded command injection.
 */
export function sanitizePtyText(text: string): string {
  // Remove all control chars except tab (\x09)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0a-\x1f\x7f\u0080-\u009f]/g, '');
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

