import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import {
  generateId,
  type Company,
  type Department,
  type TeamMember,
  type AgentPreset,
  type MemberStatus,
  type ApprovalRequest,
  type InboxMessage,
  MAX_INBOX_SIZE,
} from '../../../shared/types';
import type { QueuedMessage } from '../../company/MessageQueue';
import { clearColdParkEntry } from './workspaceSlice';

/** Maximum number of pending messages in the queue to prevent memory exhaustion. */
const MAX_MESSAGE_QUEUE_SIZE = 500;
/** Maximum number of pending approval requests. */
const MAX_APPROVAL_QUEUE_SIZE = 50;

export interface CompanySlice {
  company: Company | null;

  // Company CRUD
  createCompany: (name: string, skipPermissions?: boolean, workDir?: string) => void;
  destroyCompany: () => void;

  // Loop prevention (L2)
  taskHistory: Record<string, { from: string; to: string; attempts: number; firstSeen: number }>;
  waitGraph: Record<string, string>; // memberId -> waiting-on memberId

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
  sessionStartTime: number | null;             // session 시작 timestamp (ms)
  addMemberCost: (memberId: string, amount: number) => void;
  resetCosts: () => void;
  setSessionStartTime: (time: number | null) => void;
  updateCostEstimate: (cost: number) => void;  // company.totalCostEstimate 갱신

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

  // A2A inbox (per-member structured message store)
  memberInbox: Record<string, InboxMessage[]>;
  addToInbox: (memberId: string, msg: Omit<InboxMessage, 'id' | 'timestamp' | 'read'>) => void;
  ackInbox: (memberId: string, messageIds: string[]) => void;
  getInbox: (memberId: string, unreadOnly?: boolean) => InboxMessage[];
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
    // 새 company 생성 시 세션 시작 시간 자동 설정
    state.sessionStartTime = Date.now();
    state.memberCosts = {};
  }),

  destroyCompany: () => set((state) => {
    // Remove all company-linked workspaces
    state.workspaces = state.workspaces.filter((ws) => !ws.companyRole);
    // If active workspace was a company one, switch to first remaining
    if (!state.workspaces.some((ws) => ws.id === state.activeWorkspaceId)) {
      state.activeWorkspaceId = state.workspaces[0]?.id || '';
      clearColdParkEntry(state, state.activeWorkspaceId); // keep promoted ws visible
    }
    state.company = null;
    state.memberCosts = {};
    state.sessionStartTime = null;
    state.messageQueue = [];
    state.approvalQueue = [];
  }),

  // ─── Department ──────────────────────────────────────────────────────────

  addDepartment: (name, leadName, leadPreset) => set((state) => {
    if (!state.company) return;

    const lead: TeamMember = {
      id: generateId('member'),
      name: leadName,
      // See src/company/renderer/store.ts — leadPreset ?? 'project-manager'
      // keeps the historical default when templates don't supply a preset.
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
      clearColdParkEntry(state, state.activeWorkspaceId); // keep promoted ws visible
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
    // totalCostEstimate 동기화
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

  // ─── A2A inbox ──────────────────────────────────────────────────────────
  memberInbox: {},

  addToInbox: (memberId, msg) => set((state) => {
    if (!state.memberInbox[memberId]) {
      state.memberInbox[memberId] = [];
    }
    const inbox = state.memberInbox[memberId];
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
