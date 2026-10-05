import type { BrowserWindow } from 'electron';
import { refuseHandoffMarker } from '../handoffMarkerTripwire';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import type { RpcContext } from '../../../shared/rpc';

/**
 * `operatorOrigin` for the renderer, from the router context only. Company
 * messages are pasted and submitted with Enter; the renderer sends a
 * non-operator one through main's approval gate, and only a call from the
 * operator's own surface skips it. Never copied from caller params.
 */
function operatorStamp(ctx: RpcContext | undefined): { operatorOrigin?: true } {
  return ctx?.operator ? { operatorOrigin: true } : {};
}

type GetWindow = () => BrowserWindow | null;

/**
 * Registers company.* RPC handlers.
 *
 * All commands are delegated to the renderer process via IPC where the
 * company store handles state mutations and PTY write operations.
 */
export function registerCompanyRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * company.create
   * Creates a new company with the given name.
   * params: { name: string }
   */
  router.register('company.create', (params) => {
    if (typeof params['name'] !== 'string' || params['name'].trim().length === 0) {
      throw new Error('company.create: missing required param "name"');
    }
    return sendToRenderer(getWindow, 'company.create', { name: params['name'] });
  });

  /**
   * company.destroy
   * Destroys the current company and removes all departments and members.
   * params: {}
   */
  router.register('company.destroy', (_params) =>
    sendToRenderer(getWindow, 'company.destroy', {}),
  );

  /**
   * company.status
   * Returns the current company state (name, departments, members).
   * params: {}
   */
  router.register('company.status', (_params) =>
    sendToRenderer(getWindow, 'company.status', {}),
  );

  /**
   * company.addDept
   * Adds a new department with a lead member.
   * params: { name: string; leadName: string }
   */
  router.register('company.addDept', (params) => {
    if (typeof params['name'] !== 'string' || params['name'].trim().length === 0) {
      throw new Error('company.addDept: missing required param "name"');
    }
    if (typeof params['leadName'] !== 'string' || params['leadName'].trim().length === 0) {
      throw new Error('company.addDept: missing required param "leadName"');
    }
    return sendToRenderer(getWindow, 'company.addDept', {
      name: params['name'],
      leadName: params['leadName'],
    });
  });

  /**
   * company.removeDept
   * Removes a department by ID.
   * params: { deptId: string }
   */
  router.register('company.removeDept', (params) => {
    if (typeof params['deptId'] !== 'string' || params['deptId'].trim().length === 0) {
      throw new Error('company.removeDept: missing required param "deptId"');
    }
    return sendToRenderer(getWindow, 'company.removeDept', { deptId: params['deptId'] });
  });

  /**
   * company.addMember
   * Adds a member to a department.
   * params: { deptId: string; name: string; preset: string; customPath?: string }
   */
  router.register('company.addMember', (params) => {
    if (typeof params['deptId'] !== 'string' || params['deptId'].trim().length === 0) {
      throw new Error('company.addMember: missing required param "deptId"');
    }
    if (typeof params['name'] !== 'string' || params['name'].trim().length === 0) {
      throw new Error('company.addMember: missing required param "name"');
    }
    if (typeof params['preset'] !== 'string' || params['preset'].trim().length === 0) {
      throw new Error('company.addMember: missing required param "preset"');
    }
    const payload: Record<string, unknown> = {
      deptId: params['deptId'],
      name: params['name'],
      preset: params['preset'],
    };
    if (typeof params['customPath'] === 'string' && params['customPath'].length > 0) {
      payload['customPath'] = params['customPath'];
    }
    return sendToRenderer(getWindow, 'company.addMember', payload);
  });

  /**
   * company.removeMember
   * Removes a member from a department.
   * params: { deptId: string; memberId: string }
   */
  router.register('company.removeMember', (params) => {
    if (typeof params['deptId'] !== 'string' || params['deptId'].trim().length === 0) {
      throw new Error('company.removeMember: missing required param "deptId"');
    }
    if (typeof params['memberId'] !== 'string' || params['memberId'].trim().length === 0) {
      throw new Error('company.removeMember: missing required param "memberId"');
    }
    return sendToRenderer(getWindow, 'company.removeMember', {
      deptId: params['deptId'],
      memberId: params['memberId'],
    });
  });

  /**
   * company.broadcast
   * Sends a message to all members (via their PTY).
   * params: { message: string }
   */
  router.register('company.broadcast', (params, ctx) => {
    const marked = refuseHandoffMarker('company.broadcast', params['message'], ctx);
    if (marked) return Promise.resolve(marked);
    if (typeof params['message'] !== 'string' || params['message'].length === 0) {
      throw new Error('company.broadcast: missing required param "message"');
    }
    return sendToRenderer(getWindow, 'company.broadcast', {
      ...operatorStamp(ctx),
      message: params['message'],
    });
  });

  /**
   * company.sendDept
   * Sends a message to all members in a department (via their PTYs).
   * params: { deptId: string; message: string }
   */
  router.register('company.sendDept', (params, ctx) => {
    const marked = refuseHandoffMarker('company.sendDept', params['message'], ctx);
    if (marked) return Promise.resolve(marked);
    if (typeof params['deptId'] !== 'string' || params['deptId'].trim().length === 0) {
      throw new Error('company.sendDept: missing required param "deptId"');
    }
    if (typeof params['message'] !== 'string' || params['message'].length === 0) {
      throw new Error('company.sendDept: missing required param "message"');
    }
    return sendToRenderer(getWindow, 'company.sendDept', {
      ...operatorStamp(ctx),
      deptId: params['deptId'],
      message: params['message'],
    });
  });

  /**
   * company.sendMember
   * Sends a message to a specific member (via their PTY).
   * params: { deptId: string; memberId: string; message: string }
   */
  router.register('company.sendMember', (params, ctx) => {
    const marked = refuseHandoffMarker('company.sendMember', params['message'], ctx);
    if (marked) return Promise.resolve(marked);
    if (typeof params['deptId'] !== 'string' || params['deptId'].trim().length === 0) {
      throw new Error('company.sendMember: missing required param "deptId"');
    }
    if (typeof params['memberId'] !== 'string' || params['memberId'].trim().length === 0) {
      throw new Error('company.sendMember: missing required param "memberId"');
    }
    if (typeof params['message'] !== 'string' || params['message'].length === 0) {
      throw new Error('company.sendMember: missing required param "message"');
    }
    return sendToRenderer(getWindow, 'company.sendMember', {
      ...operatorStamp(ctx),
      deptId: params['deptId'],
      memberId: params['memberId'],
      message: params['message'],
    });
  });

  /**
   * company.message
   * Agent-initiated message routing by name (not ID).
   * Resolves target by name: department name → lead, member name → member, "CEO" → CEO.
   * params: { from: string; to: string; message: string; broadcast?: boolean }
   */
  /**
   * company.save
   * Save current company as a template.
   * params: { name?: string }
   */
  router.register('company.save', (params) => {
    return sendToRenderer(getWindow, 'company.save', {
      name: typeof params['name'] === 'string' ? params['name'] : undefined,
    });
  });

  /**
   * company.restore
   * Restore company from a template by name.
   * params: { name: string }
   */
  router.register('company.restore', (params) => {
    if (typeof params['name'] !== 'string' || params['name'].trim().length === 0) {
      throw new Error('company.restore: missing required param "name"');
    }
    return sendToRenderer(getWindow, 'company.restore', { name: params['name'] });
  });

  /**
   * company.templates
   * List available company templates (builtin + saved).
   * params: {}
   */
  router.register('company.templates', (_params) =>
    sendToRenderer(getWindow, 'company.templates', {}),
  );

  /**
   * company.worktreeSetup
   * Create git worktrees for all departments.
   * params: {}
   */
  router.register('company.worktreeSetup', (_params) =>
    sendToRenderer(getWindow, 'company.worktreeSetup', {}),
  );

  /**
   * company.mergeDept
   * Merge a department worktree into main.
   * params: { dept: string }
   */
  router.register('company.mergeDept', (params) => {
    if (typeof params['dept'] !== 'string' || params['dept'].trim().length === 0) {
      throw new Error('company.mergeDept: missing required param "dept"');
    }
    return sendToRenderer(getWindow, 'company.mergeDept', { dept: params['dept'] });
  });

  // ── A2A: agent-to-agent structured communication ─────────────────────────

  router.register('company.a2a.whoami', (params) => {
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : '';
    return sendToRenderer(getWindow, 'company.a2a.whoami', { workspaceId });
  });

  router.register('company.a2a.send', (params, ctx) => {
    const marked = refuseHandoffMarker('company.a2a.send', params['message'], ctx);
    if (marked) return Promise.resolve(marked);
    if (typeof params['from'] !== 'string' || params['from'].trim().length === 0) {
      throw new Error('company.a2a.send: missing required param "from"');
    }
    if (typeof params['to'] !== 'string' || params['to'].trim().length === 0) {
      throw new Error('company.a2a.send: missing required param "to"');
    }
    if (typeof params['message'] !== 'string' || params['message'].trim().length === 0) {
      throw new Error('company.a2a.send: missing required param "message"');
    }
    return sendToRenderer(getWindow, 'company.a2a.send', {
      ...operatorStamp(ctx),
      from: params['from'],
      to: params['to'],
      message: params['message'],
      priority: params['priority'] ?? 'normal',
      workspaceId: params['workspaceId'] ?? '',
    });
  });

  router.register('company.a2a.broadcast', (params, ctx) => {
    const marked = refuseHandoffMarker('company.a2a.broadcast', params['message'], ctx);
    if (marked) return Promise.resolve(marked);
    if (typeof params['from'] !== 'string' || params['from'].trim().length === 0) {
      throw new Error('company.a2a.broadcast: missing required param "from"');
    }
    if (typeof params['message'] !== 'string' || params['message'].trim().length === 0) {
      throw new Error('company.a2a.broadcast: missing required param "message"');
    }
    return sendToRenderer(getWindow, 'company.a2a.broadcast', {
      ...operatorStamp(ctx),
      from: params['from'],
      message: params['message'],
      priority: params['priority'] ?? 'normal',
      workspaceId: params['workspaceId'] ?? '',
    });
  });

  router.register('company.a2a.inbox', (params) => {
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : '';
    const unreadOnly = params['unreadOnly'] === true;
    return sendToRenderer(getWindow, 'company.a2a.inbox', { workspaceId, unreadOnly });
  });

  router.register('company.a2a.ack', (params) => {
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : '';
    const messageIds = Array.isArray(params['messageIds']) ? params['messageIds'] : [];
    return sendToRenderer(getWindow, 'company.a2a.ack', { workspaceId, messageIds });
  });

  router.register('company.a2a.status', (_params) =>
    sendToRenderer(getWindow, 'company.a2a.status', {}),
  );

  router.register('company.message', (params, ctx) => {
    if (typeof params['from'] !== 'string' || params['from'].trim().length === 0) {
      throw new Error('company.message: missing required param "from"');
    }
    if (typeof params['message'] !== 'string' || params['message'].trim().length === 0) {
      throw new Error('company.message: missing required param "message"');
    }
    const isBroadcast = params['broadcast'] === true;
    if (!isBroadcast && (typeof params['to'] !== 'string' || params['to'].trim().length === 0)) {
      throw new Error('company.message: missing required param "to" (or set broadcast=true)');
    }
    return sendToRenderer(getWindow, 'company.message', {
      ...operatorStamp(ctx),
      from: params['from'],
      to: params['to'] ?? '',
      message: params['message'],
      broadcast: isBroadcast,
    });
  });
}
