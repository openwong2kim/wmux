// === JSON-RPC Protocol Types ===

export interface RpcRequest {
  id: string;
  method: RpcMethod;
  params: Record<string, unknown>;
  token?: string;
}

export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

// === RPC Method definitions ===
export type RpcMethod =
  | 'workspace.list'
  | 'workspace.new'
  | 'workspace.focus'
  | 'workspace.close'
  | 'workspace.current'
  | 'surface.list'
  | 'surface.new'
  | 'surface.focus'
  | 'surface.close'
  | 'pane.list'
  | 'pane.focus'
  | 'pane.split'
  | 'pane.setMetadata'
  | 'pane.getMetadata'
  | 'pane.clearMetadata'
  | 'pane.search'
  | 'events.poll'
  | 'input.send'
  | 'input.sendKey'
  | 'input.readScreen'
  | 'terminal.readEvents'
  | 'mcp.claimWorkspace'
  | 'notify'
  | 'meta.setStatus'
  | 'meta.setProgress'
  | 'system.identify'
  | 'system.capabilities'
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.goBack'
  | 'browser.close'
  | 'browser.session.start'
  | 'browser.session.stop'
  | 'browser.session.status'
  | 'browser.session.list'
  | 'browser.type.humanlike'
  | 'browser.cdp.target'
  | 'browser.cdp.info'
  | 'browser.screenshot'
  | 'browser.evaluate'
  | 'browser.type.cdp'
  | 'browser.click.cdp'
  | 'browser.press.cdp'
  | 'daemon.createSession'
  | 'daemon.destroySession'
  | 'daemon.attachSession'
  | 'daemon.detachSession'
  | 'daemon.resizeSession'
  | 'daemon.listSessions'
  | 'daemon.readPromptEvents'
  | 'daemon.ping'
  | 'daemon.shutdown'
  | 'daemon.compact'
  | 'a2a.resolve.identity'
  | 'a2a.whoami'
  | 'a2a.discover'
  | 'a2a.task.send'
  | 'a2a.task.query'
  | 'a2a.task.update'
  | 'a2a.task.cancel'
  | 'a2a.broadcast'
  | 'meta.setSkills'
  | 'company.create'
  | 'company.destroy'
  | 'company.status'
  | 'company.addDept'
  | 'company.removeDept'
  | 'company.addMember'
  | 'company.removeMember'
  | 'company.broadcast'
  | 'company.sendDept'
  | 'company.sendMember'
  | 'company.message'
  | 'company.save'
  | 'company.restore'
  | 'company.templates'
  | 'company.worktreeSetup'
  | 'company.mergeDept'
  | 'company.a2a.whoami'
  | 'company.a2a.send'
  | 'company.a2a.broadcast'
  | 'company.a2a.inbox'
  | 'company.a2a.ack'
  | 'company.a2a.status'
  | 'company.provision'
  | 'company.provisionAll'
  | 'company.provisionCeo';

// All available methods as array (for system.capabilities)
export const ALL_RPC_METHODS = [
  'workspace.list',
  'workspace.new',
  'workspace.focus',
  'workspace.close',
  'workspace.current',
  'surface.list',
  'surface.new',
  'surface.focus',
  'surface.close',
  'pane.list',
  'pane.focus',
  'pane.split',
  'pane.setMetadata',
  'pane.getMetadata',
  'pane.clearMetadata',
  'pane.search',
  'events.poll',
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'terminal.readEvents',
  'mcp.claimWorkspace',
  'notify',
  'meta.setStatus',
  'meta.setProgress',
  'system.identify',
  'system.capabilities',
  'browser.open',
  'browser.navigate',
  'browser.goBack',
  'browser.close',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
  'browser.type.humanlike',
  'browser.cdp.target',
  'browser.cdp.info',
  'browser.screenshot',
  'browser.evaluate',
  'browser.type.cdp',
  'browser.click.cdp',
  'browser.press.cdp',
  'daemon.createSession',
  'daemon.destroySession',
  'daemon.attachSession',
  'daemon.detachSession',
  'daemon.resizeSession',
  'daemon.listSessions',
  'daemon.readPromptEvents',
  'daemon.ping',
  'daemon.shutdown',
  'daemon.compact',
  'a2a.resolve.identity',
  'a2a.whoami',
  'a2a.discover',
  'a2a.task.send',
  'a2a.task.query',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  'meta.setSkills',
  'company.create',
  'company.destroy',
  'company.status',
  'company.addDept',
  'company.removeDept',
  'company.addMember',
  'company.removeMember',
  'company.broadcast',
  'company.sendDept',
  'company.sendMember',
  'company.message',
  'company.save',
  'company.restore',
  'company.templates',
  'company.worktreeSetup',
  'company.mergeDept',
  'company.a2a.whoami',
  'company.a2a.send',
  'company.a2a.broadcast',
  'company.a2a.inbox',
  'company.a2a.ack',
  'company.a2a.status',
  'company.provision',
  'company.provisionAll',
  'company.provisionCeo',
] as const satisfies readonly RpcMethod[];

// === RPC Parameter Types ===

export interface BrowserSessionStartParams {
  profile?: string;
}

export interface BrowserTypeHumanlikeParams {
  text: string;
  selector?: string;
}

// === Daemon RPC Types ===

export interface DaemonEvent {
  type:
    | 'session.created'
    | 'session.destroyed'
    | 'session.died'
    | 'session.output'
    | 'agent.event'
    | 'agent.critical'
    | 'activity.idle'
    | 'activity.active';
  sessionId: string;
  data: unknown;
}

// NOTE: 'session.destroyed' is broadcast when the renderer/MCP explicitly
// closes a session (pty:dispose → DaemonSessionManager.destroySession),
// while 'session.died' is broadcast when the underlying PTY exits on its
// own. Both must clear agentStatus on the main side; only one is reliably
// observed depending on the caller path.

export interface DaemonCreateSessionParams {
  id: string;
  cwd: string;
  cmd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  agent?: { role: string; teamId: string; displayName: string };
}

export interface DaemonSessionIdParams {
  id: string;
}

export interface DaemonResizeParams {
  id: string;
  cols: number;
  rows: number;
}
