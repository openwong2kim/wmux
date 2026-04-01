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
  | 'input.send'
  | 'input.sendKey'
  | 'input.readScreen'
  | 'notify'
  | 'meta.setStatus'
  | 'meta.setProgress'
  | 'system.identify'
  | 'system.capabilities'
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.close'
  | 'browser.session.start'
  | 'browser.session.stop'
  | 'browser.session.status'
  | 'browser.session.list'
  | 'browser.type.humanlike'
  | 'browser.cdp.target'
  | 'browser.cdp.info'
  | 'browser.cdp.send'
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
  | 'daemon.ping'
  | 'a2a.whoami'
  | 'a2a.discover'
  | 'a2a.task.send'
  | 'a2a.task.query'
  | 'a2a.task.update'
  | 'a2a.task.cancel'
  | 'a2a.broadcast'
  | 'meta.setSkills';

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
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'notify',
  'meta.setStatus',
  'meta.setProgress',
  'system.identify',
  'system.capabilities',
  'browser.open',
  'browser.navigate',
  'browser.close',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
  'browser.type.humanlike',
  'browser.cdp.target',
  'browser.cdp.info',
  'browser.cdp.send',
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
  'daemon.ping',
  'a2a.whoami',
  'a2a.discover',
  'a2a.task.send',
  'a2a.task.query',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  'meta.setSkills',
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
  type: 'session.created' | 'session.destroyed' | 'session.died' | 'session.output' | 'agent.event' | 'agent.critical' | 'activity.idle';
  sessionId: string;
  data: unknown;
}

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
