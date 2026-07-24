import type { StateCreator } from 'zustand';
import type { StoreState } from '../../renderer/stores/index';
import { generateId, createWorkspace } from '../../shared/types';
import type {
  Company,
  Department,
  TeamMember,
  AgentPreset,
  MemberStatus,
  ApprovalRequest,
  InboxMessage,
} from '../types';
import { MAX_INBOX_SIZE } from '../types';
import type { QueuedMessage } from '../core/MessageQueue';

/** Maximum number of pending messages in the queue to prevent memory exhaustion. */
const MAX_MESSAGE_QUEUE_SIZE = 500;
/** Maximum number of content-hash entries for loop detection. */
const MAX_TASK_HISTORY_SIZE = 1000;
/** Maximum number of pending approval requests. */
const MAX_APPROVAL_QUEUE_SIZE = 50;

export interface CompanySlice {
  company: Company | null;

  // Company CRUD
  createCompany: (name: string, skipPermissions?: boolean, workDir?: string) => void;
  destroyCompany: () => void;

  // Department
  addDepartment: (name: string, leadName: string, leadPreset?: AgentPreset) => void;
  removeDepartment: (deptId: string) => void;

  // Member
  addMember: (deptId: string, name: string, preset: AgentPreset, customPath?: string) => void;
  removeMember: (deptId: string, memberId: string) => void;
  updateMemberStatus: (memberId: string, status: MemberStatus, lastMessage?: string) => void;
  setMemberWorkspace: (memberId: string, workspaceId: string) => void;
  setMemberPty: (memberId: string, ptyId: string) => void;

  // Cost (per-member granular tracking)
  memberCosts: Record<string, number>;         // memberId → estimated cost ($)
  sessionStartTime: number | null;             // session start timestamp (ms)
  addMemberCost: (memberId: string, amount: number) => void;
  resetCosts: () => void;
  setSessionStartTime: (time: number | null) => void;
  updateCostEstimate: (cost: number) => void;  // refresh company.totalCostEstimate

  // CEO workspace
  setCeoWorkspace: (workspaceId: string) => void;

  // Approval queue
  approvalQueue: ApprovalRequest[];
  addApproval: (request: ApprovalRequest) => void;
  resolveApproval: (requestId: string, _approved: boolean) => void;

  // Message queue
  messageQueue: QueuedMessage[];
  enqueueMessage: (
    targetMemberId: string,
    targetPtyId: string,
    targetName: string,
    message: string,
    from: string,
    isBroadcast?: boolean,
  ) => string;
  markDelivered: (msgId: string) => void;
  clearDeliveredMessages: () => void;
  clearMemberMessages: (memberId: string) => void;
  getPendingMessages: (memberId: string) => QueuedMessage[];

  // Message feed log (for UI display)
  messageFeed: MessageFeedEntry[];
  addFeedEntry: (entry: Omit<MessageFeedEntry, 'id' | 'timestamp'>) => void;
  clearFeed: () => void;

  // Team structure
  promoteMemberToLead: (deptId: string, memberId: string) => void;
  reassignMember: (memberId: string, fromDeptId: string, toDeptId: string) => void;
  incrementTurnCount: (memberId: string) => void;
  markCompacted: (memberId: string) => void;

  // A2A inbox (per-member structured message store)
  memberInbox: Record<string, InboxMessage[]>;
  addToInbox: (memberId: string, msg: Omit<InboxMessage, 'id' | 'timestamp' | 'read'>) => void;
  ackInbox: (memberId: string, messageIds: string[]) => void;
  getInbox: (memberId: string, unreadOnly?: boolean) => InboxMessage[];

  // Loop prevention (L2)
  taskHistory: Record<string, { from: string; to: string; attempts: number; firstSeen: number }>;
  waitGraph: Record<string, string>; // memberId -> waiting-on memberId
}

// ── Loop-prevention helpers ──────────────────────────────────────────────

function findMemberByName(state: StoreState, name: string): TeamMember | undefined {
  if (!state.company) return undefined;
  for (const dept of state.company.departments) {
    const member = dept.members.find((m) => m.name === name);
    if (member) return member;
  }
  return undefined;
}

function findMemberById(state: StoreState, id: string): TeamMember | undefined {
  if (!state.company) return undefined;
  for (const dept of state.company.departments) {
    const member = dept.members.find((m) => m.id === id);
    if (member) return member;
  }
  return undefined;
}

export interface MessageFeedEntry {
  id: string;
  from: string;
  to: string;
  message: string;
  tag: 'directive' | 'report' | 'approval' | 'blocked' | 'broadcast' | 'message';
  timestamp: number;
}

export const createCompanySlice: StateCreator<StoreState, [['zustand/immer', never]], [], CompanySlice> = (set, get) => ({
  company: null,
  approvalQueue: [],
  messageQueue: [],
  memberCosts: {},
  sessionStartTime: null,
  taskHistory: {},
  waitGraph: {},

  // ─── Company CRUD ─────────────────────────────────────────────────────────

  createCompany: (name, skipPermissions, workDir) => set((state) => {
    const company: Company = {
      id: generateId('company'),
      name,
      departments: [],
      createdAt: Date.now(),
      skipPermissions,
      workDir: workDir || undefined,
    };
    state.company = company;
    // Auto-set session start time when creating a new company
    state.sessionStartTime = Date.now();
    state.memberCosts = {};
  }),

  destroyCompany: () => set((state) => {
    // Remove all company-linked workspaces
    state.workspaces = state.workspaces.filter((ws) => !ws.companyRole);
    // If no workspaces remain, create a default one
    if (state.workspaces.length === 0) {
      state.workspaces.push(createWorkspace('Workspace 1'));
    }
    // Switch to first remaining workspace if active was removed
    if (!state.workspaces.some((ws) => ws.id === state.activeWorkspaceId)) {
      state.activeWorkspaceId = state.workspaces[0]?.id || '';
    }
    // Switch sidebar back to workspaces tab
    state.sidebarMode = 'workspaces';
    state.company = null;
    state.memberCosts = {};
    state.sessionStartTime = null;
    state.messageQueue = [];
    state.approvalQueue = [];
    state.taskHistory = {};
    state.waitGraph = {};
  }),

  // ─── Department ──────────────────────────────────────────────────────────

  addDepartment: (name, leadName, leadPreset) => set((state) => {
    if (!state.company) return;

    const lead: TeamMember = {
      id: generateId('member'),
      name: leadName,
      // Fall back to 'project-manager' only when the caller did not
      // supply a preset. Templates that know the lead's role (CTO,
      // CISO, Software Architect, …) should pass `leadPreset` so the
      // SOUL injection matches the persona instead of defaulting
      // every lead to the product-manager persona.
      preset: leadPreset ?? 'project-manager',
      workspaceId: '',
      status: 'idle',
    };

    const dept: Department = {
      id: generateId('dept'),
      name,
      leadId: lead.id,
      members: [lead],
    };

    state.company.departments.push(dept);
  }),

  removeDepartment: (deptId) => set((state) => {
    if (!state.company) return;
    const dept = state.company.departments.find((d) => d.id === deptId);
    if (!dept) return;
    // Remove workspaces linked to this department's members
    const memberWsIds = new Set(dept.members.map((m) => m.workspaceId).filter(Boolean));
    state.workspaces = state.workspaces.filter((ws) => !memberWsIds.has(ws.id));
    if (!state.workspaces.some((ws) => ws.id === state.activeWorkspaceId)) {
      state.activeWorkspaceId = state.workspaces[0]?.id || '';
    }
    // Remove department
    const idx = state.company.departments.findIndex((d) => d.id === deptId);
    if (idx !== -1) state.company.departments.splice(idx, 1);
  }),

  // ─── Member ───────────────────────────────────────────────────────────────

  addMember: (deptId, name, preset, customPath) => set((state) => {
    if (!state.company) return;
    const dept = state.company.departments.find((d) => d.id === deptId);
    if (!dept) return;

    const member: TeamMember = {
      id: generateId('member'),
      name,
      preset,
      customAgentPath: customPath,
      workspaceId: '',
      status: 'idle',
    };

    dept.members.push(member);
  }),

  removeMember: (deptId, memberId) => set((state) => {
    if (!state.company) return;
    const dept = state.company.departments.find((d) => d.id === deptId);
    if (!dept) return;
    const idx = dept.members.findIndex((m) => m.id === memberId);
    if (idx !== -1) {
      dept.members.splice(idx, 1);
    }
  }),

  updateMemberStatus: (memberId, status, lastMessage) => set((state) => {
    if (!state.company) return;
    for (const dept of state.company.departments) {
      const member = dept.members.find((m) => m.id === memberId);
      if (member) {
        member.status = status;
        if (lastMessage !== undefined) {
          member.lastMessage = lastMessage;
        }
        member.lastActivity = Date.now();

        // Wait graph tracking for cycle detection
        if (status === 'waiting') {
          const lastSent = state.messageFeed
            .filter((f) => f.from === (member.name || memberId))
            .pop();
          if (lastSent) {
            const targetMember = findMemberByName(state, lastSent.to);
            if (targetMember) {
              state.waitGraph[memberId] = targetMember.id;
              // Cycle detection: follow the chain
              const visited = new Set<string>([memberId]);
              let current = targetMember.id;
              while (current && state.waitGraph[current]) {
                if (visited.has(state.waitGraph[current])) {
                  console.log(`[WaitGraph] Cycle detected involving ${memberId}`);
                  // Break cycle: clear edges for both parties
                  delete state.waitGraph[current];
                  delete state.waitGraph[memberId];
                  const blocker = findMemberById(state, current);
                  if (blocker) blocker.status = 'stuck';
                  break;
                }
                visited.add(current);
                current = state.waitGraph[current];
              }
            }
          }
        } else {
          delete state.waitGraph[memberId];
        }

        return;
      }
    }
  }),

  setMemberWorkspace: (memberId, workspaceId) => set((state) => {
    if (!state.company) return;
    for (const dept of state.company.departments) {
      const member = dept.members.find((m) => m.id === memberId);
      if (member) {
        member.workspaceId = workspaceId;
        return;
      }
    }
  }),

  setMemberPty: (memberId, ptyId) => set((state) => {
    if (!state.company) return;
    for (const dept of state.company.departments) {
      const member = dept.members.find((m) => m.id === memberId);
      if (member) {
        member.ptyId = ptyId;
        return;
      }
    }
  }),

  // ─── Cost ─────────────────────────────────────────────────────────────────

  addMemberCost: (memberId, amount) => set((state) => {
    const prev = state.memberCosts[memberId] ?? 0;
    state.memberCosts[memberId] = prev + amount;
    // Sync totalCostEstimate
    if (state.company) {
      const total = Object.values(state.memberCosts).reduce((s, v) => s + v, 0);
      state.company.totalCostEstimate = total;
    }
  }),

  resetCosts: () => set((state) => {
    state.memberCosts = {};
    state.sessionStartTime = Date.now();
    if (state.company) {
      state.company.totalCostEstimate = 0;
    }
  }),

  setSessionStartTime: (time) => set((state) => {
    state.sessionStartTime = time;
  }),

  updateCostEstimate: (cost) => set((state) => {
    if (!state.company) return;
    state.company.totalCostEstimate = cost;
  }),

  // ─── CEO workspace ────────────────────────────────────────────────────────

  setCeoWorkspace: (workspaceId) => set((state) => {
    if (!state.company) return;
    state.company.ceoWorkspaceId = workspaceId;
  }),

  // ─── Approval queue ───────────────────────────────────────────────────────

  addApproval: (request) => set((state) => {
    // Prevent duplicate requests for the same pty+action
    const alreadyQueued = state.approvalQueue.some(
      (r) => r.ptyId === request.ptyId && r.action === request.action,
    );
    if (!alreadyQueued) {
      // Evict oldest entry if at capacity to prevent unbounded growth
      if (state.approvalQueue.length >= MAX_APPROVAL_QUEUE_SIZE) {
        state.approvalQueue.shift();
      }
      state.approvalQueue.push(request);
    }
  }),

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  resolveApproval: (_requestId, _approved) => set((state) => {
    const idx = state.approvalQueue.findIndex((r) => r.id === _requestId);
    if (idx !== -1) {
      state.approvalQueue.splice(idx, 1);
    }
    // PTY write (y\n / n\n) is performed by the caller before invoking resolveApproval
  }),

  // ─── Message queue ────────────────────────────────────────────────────────

  enqueueMessage: (targetMemberId, targetPtyId, targetName, message, from, isBroadcast = false) => {
    const id = generateId('mq');
    set((state) => {
      // Evict oldest delivered messages first, then oldest undelivered if still at cap
      if (state.messageQueue.length >= MAX_MESSAGE_QUEUE_SIZE) {
        const deliveredIdx = state.messageQueue.findIndex((m) => m.delivered);
        if (deliveredIdx !== -1) {
          state.messageQueue.splice(deliveredIdx, 1);
        } else {
          // Drop oldest undelivered to make room
          state.messageQueue.shift();
        }
      }
      const msg: QueuedMessage = {
        id,
        targetMemberId,
        targetPtyId,
        targetName,
        message,
        from,
        priority: 'normal',
        timestamp: Date.now(),
        delivered: false,
        isBroadcast,
      };
      state.messageQueue.push(msg);
    });
    return id;
  },

  markDelivered: (msgId) => set((state) => {
    const msg = state.messageQueue.find((m) => m.id === msgId);
    if (msg) {
      msg.delivered = true;
    }
  }),

  clearDeliveredMessages: () => set((state) => {
    state.messageQueue = state.messageQueue.filter((m) => !m.delivered);
  }),

  clearMemberMessages: (memberId) => set((state) => {
    state.messageQueue = state.messageQueue.filter((m) => m.targetMemberId !== memberId);
  }),

  getPendingMessages: (memberId) => {
    return get().messageQueue.filter((m) => m.targetMemberId === memberId && !m.delivered);
  },

  // ─── Message feed log ──────────────────────────────────────────────────
  messageFeed: [],

  addFeedEntry: (entry) => set((state) => {
    const full: MessageFeedEntry = {
      ...entry,
      id: generateId('feed'),
      timestamp: Date.now(),
    };
    state.messageFeed.push(full);
    // Cap at 200 entries
    if (state.messageFeed.length > 200) {
      state.messageFeed = state.messageFeed.slice(-200);
    }
  }),

  clearFeed: () => set((state) => {
    state.messageFeed = [];
  }),

  // ─── Team structure ────────────────────────────────────────────────────

  promoteMemberToLead: (deptId, memberId) => set((state) => {
    if (!state.company) return;
    const dept = state.company.departments.find((d) => d.id === deptId);
    if (!dept) return;
    const member = dept.members.find((m) => m.id === memberId);
    if (!member) return;
    // Demote old lead to regular member status
    const oldLead = dept.members.find((m) => m.id === dept.leadId);
    if (oldLead && oldLead.status !== 'error') {
      oldLead.status = 'idle';
    }
    dept.leadId = memberId;
  }),

  reassignMember: (memberId, fromDeptId, toDeptId) => set((state) => {
    if (!state.company) return;
    const fromDept = state.company.departments.find((d) => d.id === fromDeptId);
    const toDept = state.company.departments.find((d) => d.id === toDeptId);
    if (!fromDept || !toDept) return;
    const memberIdx = fromDept.members.findIndex((m) => m.id === memberId);
    if (memberIdx === -1) return;
    // Cannot reassign the lead
    if (fromDept.leadId === memberId) return;
    const member = fromDept.members[memberIdx];
    // Track original department for pool return
    if (!member.originalDeptId) {
      member.originalDeptId = fromDeptId;
    }
    member.status = 'idle';
    fromDept.members.splice(memberIdx, 1);
    toDept.members.push(member);
  }),

  incrementTurnCount: (memberId) => set((state) => {
    if (!state.company) return;
    for (const dept of state.company.departments) {
      const member = dept.members.find((m) => m.id === memberId);
      if (member) {
        member.turnCount = (member.turnCount ?? 0) + 1;
        return;
      }
    }
  }),

  markCompacted: (memberId) => set((state) => {
    if (!state.company) return;
    for (const dept of state.company.departments) {
      const member = dept.members.find((m) => m.id === memberId);
      if (member) {
        member.turnCount = 0;
        member.lastCompactedAt = Date.now();
        return;
      }
    }
  }),

  // ─── A2A inbox ──────────────────────────────────────────────────────────
  memberInbox: {},

  addToInbox: (memberId, msg) => set((state) => {
    if (!state.memberInbox[memberId]) {
      state.memberInbox[memberId] = [];
    }
    const inbox = state.memberInbox[memberId];

    // Content hash dedup — detect repeated identical messages
    const contentKey = `${msg.from}:${memberId}:${msg.message.toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const hashKey = `${contentKey.slice(0, 100)}:${contentKey.length}`;
    const existing = state.taskHistory[hashKey];
    if (existing) {
      existing.attempts++;
      if (existing.attempts >= 3) {
        // Abandon — don't deliver, inject system warning instead
        const warning: InboxMessage = {
          ...msg,
          id: generateId('inbox'),
          timestamp: Date.now(),
          read: false,
          from: '[FMUX-SYSTEM]',
          message: `Task abandoned after 3 identical attempts from ${msg.from}. Change approach or escalate.`,
        };
        inbox.push(warning);
        if (inbox.length > MAX_INBOX_SIZE) {
          state.memberInbox[memberId] = inbox.slice(-MAX_INBOX_SIZE);
        }
        return;
      }
    } else {
      // Evict oldest entries if at capacity
      const keys = Object.keys(state.taskHistory);
      if (keys.length >= MAX_TASK_HISTORY_SIZE) {
        let oldestKey = keys[0];
        let oldestTime = state.taskHistory[oldestKey].firstSeen;
        for (const k of keys) {
          if (state.taskHistory[k].firstSeen < oldestTime) {
            oldestKey = k;
            oldestTime = state.taskHistory[k].firstSeen;
          }
        }
        delete state.taskHistory[oldestKey];
      }
      state.taskHistory[hashKey] = {
        from: msg.from,
        to: memberId,
        attempts: 1,
        firstSeen: Date.now(),
      };
    }

    const full: InboxMessage = {
      ...msg,
      id: generateId('inbox'),
      timestamp: Date.now(),
      read: false,
    };
    inbox.push(full);
    if (inbox.length > MAX_INBOX_SIZE) {
      state.memberInbox[memberId] = inbox.slice(-MAX_INBOX_SIZE);
    }
  }),

  ackInbox: (memberId, messageIds) => set((state) => {
    const inbox = state.memberInbox[memberId];
    if (!inbox) return;
    const idSet = new Set(messageIds);
    for (const msg of inbox) {
      if (idSet.has(msg.id)) msg.read = true;
    }
  }),

  getInbox: (memberId, unreadOnly = false) => {
    const inbox = get().memberInbox[memberId] ?? [];
    return unreadOnly ? inbox.filter((m) => !m.read) : inbox;
  },
});
