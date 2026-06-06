/**
 * Company mode RPC handlers — ported from wmux-max.
 * Handles company.*, company.a2a.* methods.
 */
import { useStore } from '../../renderer/stores';
import type { Company, TeamMember } from '../types';
import { validateMessage } from '../../shared/types';
import { formatMessage, formatBroadcast } from '../core/messageTemplates';
import { submitBracketedPasteToPty } from '../../renderer/utils/ptyMessageDelivery';
import { spawnCompany, spawnMember } from './provisioner';

type Store = ReturnType<typeof useStore.getState>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTargetMembers(
  company: Company,
  toName: string,
  excludeId?: string,
): TeamMember[] {
  const normalized = toName.trim().toLowerCase();
  const allMembers = company.departments.flatMap((d) => d.members);

  // Department name → lead
  const dept = company.departments.find((d) => d.name.toLowerCase() === normalized);
  if (dept) {
    const lead = dept.members.find((m) => m.id === dept.leadId);
    return lead && lead.id !== excludeId ? [lead] : [];
  }

  // "DeptName Lead" pattern
  const leadMatch = normalized.match(/^(.+?)\s+lead$/);
  if (leadMatch) {
    const deptByLead = company.departments.find((d) => d.name.toLowerCase() === leadMatch[1]);
    if (deptByLead) {
      const lead = deptByLead.members.find((m) => m.id === deptByLead.leadId);
      return lead && lead.id !== excludeId ? [lead] : [];
    }
  }

  // Exact member name
  const exactMember = allMembers.find((m) => m.name.toLowerCase() === normalized && m.id !== excludeId);
  if (exactMember) return [exactMember];

  // Single partial match only
  const partialMatches = allMembers.filter((m) => m.name.toLowerCase().includes(normalized) && m.id !== excludeId);
  return partialMatches.length === 1 ? partialMatches : [];
}

function getCompanyActorName(company: Company, workspaceId: string): string | null {
  const allMembers = company.departments.flatMap((d) => d.members);
  const member = allMembers.find((m) => m.workspaceId === workspaceId);
  if (member) return member.name;
  if (company.ceoWorkspaceId === workspaceId) return 'CEO';
  return null;
}

function deliverToCeo(store: Store, from: string, message: string): void {
  const c = store.company;
  if (!c?.ceoWorkspaceId) return;
  const ws = store.workspaces.find((w) => w.id === c.ceoWorkspaceId);
  if (!ws) return;
  const leaves = findLeafPanes(ws.rootPane);
  for (const leaf of leaves) {
    const surface = leaf.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
    if (surface) {
      const formatted = formatMessage(from, 'CEO', message);
      submitBracketedPasteToPty(surface.ptyId, formatted);
      break;
    }
  }
}

function findLeafPanes(root: import('../../shared/types').Pane): import('../../shared/types').PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(findLeafPanes);
}

type MessagePriority = import('../core/messageTemplates').MessagePriority;

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleCompanyRpc(
  method: string,
  params: Record<string, unknown>,
  store: Store,
): Promise<unknown | null> {
  // company.create
  if (method === 'company.create') {
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name) return { error: 'company.create: missing param "name"' };
    store.createCompany(name);
    const c = useStore.getState().company;
    return c ? { id: c.id, name: c.name } : { error: 'company.create: failed' };
  }

  if (method === 'company.destroy') {
    store.destroyCompany();
    return { ok: true };
  }

  if (method === 'company.status') {
    const c = store.company;
    if (!c) return null;
    return {
      id: c.id, name: c.name, createdAt: c.createdAt,
      totalCostEstimate: c.totalCostEstimate ?? 0,
      departments: c.departments.map((d) => ({
        id: d.id, name: d.name, leadId: d.leadId,
        members: d.members.map((m) => ({
          id: m.id, name: m.name, preset: m.preset,
          workspaceId: m.workspaceId, ptyId: m.ptyId ?? null,
          status: m.status, lastMessage: m.lastMessage ?? null,
        })),
      })),
    };
  }

  if (method === 'company.addDept') {
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    const leadName = typeof params.leadName === 'string' ? params.leadName.trim() : '';
    if (!name) return { error: 'company.addDept: missing param "name"' };
    if (!leadName) return { error: 'company.addDept: missing param "leadName"' };
    store.addDepartment(name, leadName);
    const c = useStore.getState().company;
    if (!c) return { error: 'company.addDept: no company' };
    const dept = c.departments[c.departments.length - 1];
    return dept ? { id: dept.id, name: dept.name, leadId: dept.leadId } : { error: 'failed' };
  }

  if (method === 'company.removeDept') {
    const deptId = typeof params.deptId === 'string' ? params.deptId : '';
    if (!deptId) return { error: 'company.removeDept: missing param "deptId"' };
    store.removeDepartment(deptId);
    return { ok: true };
  }

  if (method === 'company.addMember') {
    const deptId = typeof params.deptId === 'string' ? params.deptId : '';
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    const preset = typeof params.preset === 'string' ? params.preset : '';
    const customPath = typeof params.customPath === 'string' ? params.customPath : undefined;
    if (!deptId) return { error: 'company.addMember: missing param "deptId"' };
    if (!name) return { error: 'company.addMember: missing param "name"' };
    if (!preset) return { error: 'company.addMember: missing param "preset"' };
    store.addMember(deptId, name, preset as import('../types').AgentPreset, customPath);
    const c = useStore.getState().company;
    const dept = c?.departments.find((d) => d.id === deptId);
    const member = dept?.members.find((m) => m.name === name);
    return member ? { id: member.id, name: member.name, preset: member.preset } : { error: 'failed' };
  }

  if (method === 'company.removeMember') {
    const deptId = typeof params.deptId === 'string' ? params.deptId : '';
    const memberId = typeof params.memberId === 'string' ? params.memberId : '';
    if (!deptId) return { error: 'company.removeMember: missing param "deptId"' };
    if (!memberId) return { error: 'company.removeMember: missing param "memberId"' };
    store.removeMember(deptId, memberId);
    return { ok: true };
  }

  if (method === 'company.broadcast') {
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const from = typeof params.from === 'string' ? params.from : 'CEO';
    if (!rawMessage) return { error: 'company.broadcast: missing param "message"' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `company.broadcast: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const c = store.company;
    if (!c) return { error: 'company.broadcast: no company' };
    let sentImmediate = 0; let queued = 0;
    for (const member of c.departments.flatMap((d) => d.members)) {
      if (!member.ptyId) continue;
      if (member.status === 'idle') {
        submitBracketedPasteToPty(member.ptyId, formatBroadcast(from, message));
        sentImmediate++;
      } else {
        store.enqueueMessage(member.id, member.ptyId, member.name, message, from, true);
        queued++;
      }
    }
    return { ok: true, sentImmediate, queued };
  }

  if (method === 'company.sendDept') {
    const deptId = typeof params.deptId === 'string' ? params.deptId : '';
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const from = typeof params.from === 'string' ? params.from : 'CEO';
    if (!deptId || !rawMessage) return { error: 'company.sendDept: missing params' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `company.sendDept: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const c = store.company;
    if (!c) return { error: 'no company' };
    const dept = c.departments.find((d) => d.id === deptId);
    if (!dept) return { error: `dept "${deptId}" not found` };
    let sentImmediate = 0; let queued = 0;
    for (const member of dept.members) {
      if (!member.ptyId) continue;
      if (member.status === 'idle') {
        submitBracketedPasteToPty(member.ptyId, formatMessage(from, member.name, message));
        sentImmediate++;
      } else {
        store.enqueueMessage(member.id, member.ptyId, member.name, message, from, false);
        queued++;
      }
    }
    return { ok: true, sentImmediate, queued };
  }

  if (method === 'company.sendMember') {
    const deptId = typeof params.deptId === 'string' ? params.deptId : '';
    const memberId = typeof params.memberId === 'string' ? params.memberId : '';
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const from = typeof params.from === 'string' ? params.from : 'CEO';
    if (!deptId || !memberId || !rawMessage) return { error: 'company.sendMember: missing params' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `company.sendMember: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const c = store.company;
    if (!c) return { error: 'no company' };
    const dept = c.departments.find((d) => d.id === deptId);
    if (!dept) return { error: `dept not found` };
    const member = dept.members.find((m) => m.id === memberId);
    if (!member?.ptyId) return { error: `member not found or no PTY` };
    if (member.status === 'idle') {
      submitBracketedPasteToPty(member.ptyId, formatMessage(from, member.name, message));
      return { ok: true, sentImmediate: 1, queued: 0 };
    } else {
      store.enqueueMessage(member.id, member.ptyId, member.name, message, from, false);
      return { ok: true, sentImmediate: 0, queued: 1 };
    }
  }

  if (method === 'company.message') {
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const from = typeof params.from === 'string' ? params.from : '';
    const to = typeof params.to === 'string' ? params.to : '';
    const isBroadcast = params.broadcast === true;
    if (!from || !rawMessage) return { error: 'company.message: missing params' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `company.message: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const c = store.company;
    if (!c) return { error: 'no company' };
    const tag = isBroadcast ? 'broadcast' as const : 'directive' as const;
    store.addFeedEntry({ from, to: to || 'All', message, tag });
    if (isBroadcast) {
      let sent = 0;
      for (const member of c.departments.flatMap((d) => d.members)) {
        if (!member.ptyId) continue;
        if (member.status === 'idle') {
          submitBracketedPasteToPty(member.ptyId, formatBroadcast(from, message));
        } else {
          store.enqueueMessage(member.id, member.ptyId, member.name, message, from, true);
        }
        sent++;
      }
      if (c.ceoWorkspaceId) deliverToCeo(store, from, message);
      return { ok: true, sent };
    }
    if (to.trim().toLowerCase() === 'ceo' && c.ceoWorkspaceId) {
      deliverToCeo(store, from, message);
      return { ok: true, sent: 1 };
    }
    const targets = resolveTargetMembers(c, to);
    let sent = 0;
    for (const member of targets) {
      if (!member.ptyId) continue;
      if (member.status === 'idle') {
        submitBracketedPasteToPty(member.ptyId, formatMessage(from, member.name, message));
      } else {
        store.enqueueMessage(member.id, member.ptyId, member.name, message, from, false);
      }
      sent++;
    }
    return { ok: true, sent };
  }

  // -- A2A structured communication --

  if (method === 'company.a2a.whoami') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const c = store.company;
    if (!c) return { error: 'no company active' };
    const allMembers = c.departments.flatMap((d) => d.members);
    const member = allMembers.find((m) => m.workspaceId === workspaceId);
    if (!member) {
      if (c.ceoWorkspaceId === workspaceId) return { role: 'ceo', name: 'CEO', companyName: c.name };
      return { error: `no member found for workspace ${workspaceId}` };
    }
    const dept = c.departments.find((d) => d.members.some((m) => m.id === member.id));
    return { memberId: member.id, name: member.name, preset: member.preset, role: dept?.leadId === member.id ? 'lead' : 'member', department: dept?.name ?? null, companyName: c.name, status: member.status };
  }

  if (method === 'company.a2a.send') {
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const to = typeof params.to === 'string' ? params.to : '';
    const priority = typeof params.priority === 'string' ? params.priority : 'normal';
    if (!workspaceId || !to || !rawMessage) return { error: 'company.a2a.send: missing params' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `company.a2a.send: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const c = store.company;
    if (!c) return { error: 'no company active' };
    const from = getCompanyActorName(c, workspaceId);
    if (!from) return { error: `no company sender for workspace ${workspaceId}` };
    store.addFeedEntry({ from, to, message, tag: 'message' });
    if (to.trim().toLowerCase() === 'ceo' && c.ceoWorkspaceId) {
      deliverToCeo(store, from, message);
      return { ok: true, delivered: 1, queued: 0 };
    }
    const targets = resolveTargetMembers(c, to);
    let delivered = 0; let queued = 0;
    for (const member of targets) {
      store.addToInbox(member.id, { from, to: member.name, message, priority });
      if (!member.ptyId) continue;
      if (member.status === 'idle') {
        submitBracketedPasteToPty(member.ptyId, formatMessage(from, member.name, message, priority as MessagePriority));
        delivered++;
      } else {
        store.enqueueMessage(member.id, member.ptyId, member.name, message, from, false);
        queued++;
      }
    }
    return { ok: true, delivered, queued, targetCount: targets.length };
  }

  if (method === 'company.a2a.broadcast') {
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const priority = typeof params.priority === 'string' ? params.priority : 'normal';
    if (!workspaceId || !rawMessage) return { error: 'company.a2a.broadcast: missing params' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `company.a2a.broadcast: ${e instanceof Error ? e.message : 'invalid'}` };
    }
    const c = store.company;
    if (!c) return { error: 'no company active' };
    const from = getCompanyActorName(c, workspaceId);
    if (!from) return { error: `no company sender for workspace ${workspaceId}` };
    store.addFeedEntry({ from, to: 'All', message, tag: 'broadcast' });
    let sent = 0;
    for (const member of c.departments.flatMap((d) => d.members)) {
      store.addToInbox(member.id, { from, to: 'All', message, priority });
      if (!member.ptyId) continue;
      if (member.status === 'idle') {
        submitBracketedPasteToPty(member.ptyId, formatBroadcast(from, message, priority as MessagePriority));
      } else {
        store.enqueueMessage(member.id, member.ptyId, member.name, message, from, true);
      }
      sent++;
    }
    if (c.ceoWorkspaceId) deliverToCeo(store, from, message);
    return { ok: true, sent };
  }

  if (method === 'company.a2a.inbox') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const unreadOnly = params.unreadOnly === true;
    const c = store.company;
    if (!c) return { error: 'no company active' };
    const member = c.departments.flatMap((d) => d.members).find((m) => m.workspaceId === workspaceId);
    if (!member) return { error: `no member for workspace ${workspaceId}`, messages: [] };
    return { memberId: member.id, messages: store.getInbox(member.id, unreadOnly) };
  }

  if (method === 'company.a2a.ack') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const messageIds = Array.isArray(params.messageIds) ? params.messageIds as string[] : [];
    const c = store.company;
    if (!c) return { error: 'no company active' };
    const member = c.departments.flatMap((d) => d.members).find((m) => m.workspaceId === workspaceId);
    if (!member) return { error: `no member for workspace ${workspaceId}` };
    store.ackInbox(member.id, messageIds);
    return { ok: true, acknowledged: messageIds.length };
  }

  if (method === 'company.a2a.status') {
    const c = store.company;
    if (!c) return null;
    return {
      company: c.name,
      departments: c.departments.map((d) => ({
        name: d.name,
        members: d.members.map((m) => ({
          name: m.name, role: m.id === d.leadId ? 'lead' : 'member',
          status: m.status, preset: m.preset,
        })),
      })),
    };
  }

  // ── Provisioning ─────────────────────────────────────────────────────────

  if (method === 'company.provision') {
    const memberId = typeof params.memberId === 'string' ? params.memberId : '';
    if (!memberId) return { error: 'company.provision: missing param "memberId"' };
    const c = store.company;
    if (!c) return { error: 'no company' };
    // Find member
    for (const dept of c.departments) {
      const member = dept.members.find((m) => m.id === memberId);
      if (!member) continue;
      const lead = dept.members.find((m) => m.id === dept.leadId);
      const result = await spawnMember(
        c.name, dept.name, lead?.name || 'Lead', member.name, member.preset,
        c.skipPermissions || false, c.workDir,
      );
      store.setMemberWorkspace(member.id, result.workspaceId);
      store.setMemberPty(member.id, result.ptyId);
      return { ok: true, ...result };
    }
    return { error: 'member not found' };
  }

  if (method === 'company.provisionAll') {
    const c = store.company;
    if (!c) return { error: 'no company' };
    return spawnCompany({
      companyName: c.name,
      skipPermissions: c.skipPermissions || false,
      workDir: c.workDir,
      departments: c.departments.map((d) => ({
        name: d.name,
        leadName: d.members.find((m) => m.id === d.leadId)?.name || 'Lead',
        members: d.members.filter((m) => m.id !== d.leadId).map((m) => ({ name: m.name, preset: m.preset })),
      })),
    });
  }

  if (method === 'company.provisionCeo') {
    return { error: 'company.provisionCeo: CEO is auto-spawned during company creation' };
  }

  // TODO: company.save/restore/templates require template IPC handlers (not yet ported)
  if (method === 'company.save') return { error: 'company.save: template IPC not yet available' };
  if (method === 'company.restore') return { error: 'company.restore: template IPC not yet available' };
  if (method === 'company.templates') return { error: 'company.templates: template IPC not yet available' };

  // TODO: company.worktreeSetup/mergeDept require worktree IPC handlers (not yet ported)
  if (method === 'company.worktreeSetup') return { error: 'company.worktreeSetup: worktree IPC not yet available' };
  if (method === 'company.mergeDept') return { error: 'company.mergeDept: worktree IPC not yet available' };

  // Not a company method
  return null;
}
