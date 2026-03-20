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
  | 'browser.snapshot'
  | 'browser.click'
  | 'browser.fill'
  | 'browser.eval'
  | 'browser.navigate';

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
  'browser.snapshot',
  'browser.click',
  'browser.fill',
  'browser.eval',
  'browser.navigate',
] as const satisfies readonly RpcMethod[];
