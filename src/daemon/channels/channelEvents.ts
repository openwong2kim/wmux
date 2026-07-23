/**
 * Channel domain event payload + boot replay applier (envelope-design §5, PR3).
 *
 * Payload carries "determined effects" — validation/judgment (including now()·randomUUID)
 * is already done on the live path, and replay only deterministically re-applies those results.
 * (If you put request params and re-run business logic, now/uuid non-determinism makes replay
 * diverge from live — effect records are the only deterministic form.)
 *
 * ┌── Invariant: all appliers are idempotent ─────────────────────────────────────┐
 * │ (a) at-least-once contract (§2.6 D17): promotion records·post-rollback-survival │
 * │     records can reappear on replay — re-application must be harmless.           │
 * │ (b) Snapshot marker lag: snapshots serialize live reference at write time, so   │
 * │     content can precede the marker (snapshotLamport) — re-application of        │
 * │     already-applied events must be harmless for conservative replay up to the   │
 * │     marker to be safe.                                                          │
 * │ Each applier guarantees this with existence/seq guards (record identity basis). │
 * └─────────────────────────────────────────────────────────────────────────────────┘
 *
 * additive-only: only kind additions allowed. No field removal·semantic change for existing kinds (disk contract).
 * Unknown kinds are ignored (forward compatibility — old daemon replay passes records written by future daemons).
 */

import {
  CHANNEL_IDEMPOTENCY_CAP,
  CHANNEL_MESSAGES_MAX,
  type Channel,
  type ChannelMember,
  type ChannelMessage,
  type ChannelState,
} from '../../shared/channels';

/** Channel domain envelope payload (D16 — 1 commit = 1 envelope). */
export type ChannelEventPayload =
  | {
      kind: 'create';
      channel: Channel;
      members: ChannelMember[];
    }
  | {
      kind: 'archive';
      channelId: string;
      archivedAt: number;
      archivedBy: string;
    }
  | {
      kind: 'join';
      channelId: string;
      member: ChannelMember;
    }
  | {
      kind: 'invite';
      channelId: string;
      member: ChannelMember;
    }
  | {
      kind: 'leave';
      channelId: string;
      workspaceId: string;
      memberId: string;
      /** emptySince stamp determined by live path (only present when last member leaves). */
      emptySince?: number;
    }
  | {
      kind: 'kick';
      channelId: string;
      targetWorkspaceId: string;
      targetMemberId: string;
      emptySince?: number;
    }
  | {
      kind: 'purge';
      channelId: string;
      workspaceId: string;
      memberId?: string;
      principalId?: string;
      emptySince?: number;
    }
  | {
      kind: 'post';
      channelId: string;
      /** Fully determined message row (including seq·clientMsgId·mentions). */
      message: ChannelMessage;
      /** Sender cursor ride (§5 — recorded only when lastReadSeq === seq-1 on live path). */
      cursorRide?: { workspaceId: string; memberId: string };
      /** Confirmed value when 1b name refresh was included in this commit. */
      nameRefresh?: { workspaceId: string; memberId: string; memberName: string };
    }
  | {
      kind: 'ack';
      channelId: string;
      workspaceId: string;
      /** If present, cursor advance (member-scoped); if absent, receipt-only ack. */
      memberId?: string;
      uptoSeq: number;
      /** Live ack's now() — for deterministic reproduction of lastAttemptAt stamp. */
      ackedAt: number;
    }
  | {
      /**
       * operator-join (design §2.1.1) — bundles operator (human) seat push + server-issued system
       * message append into **one envelope**. Carrying both effects in one commit
       * guarantees atomicity: on append-only log, partial state where only seat is committed and message fails
       * must be structurally impossible ("atomic rollback of seat·message on persist failure"),
       * so join+post cannot be split into two envelopes. Maintains 1 commit = 1 envelope invariant
       * (D16). Applier is idempotent: seat uses (workspaceId, memberId) existence guard, message uses
       * seq existence/trimmed past seq guard (same shape as post applier).
       */
      kind: 'operator-join';
      channelId: string;
      member: ChannelMember;
      message: ChannelMessage;
    }
  | {
      /** §6.4c reseed marker (migrateToEventLog appends). State carried by snapshot — replay no-op. */
      kind: 'legacy-reseed';
      reseedNumber: number;
      stateHash: string;
      detectedAt: number;
    };

/** Idempotent index compositeKey — same format as ChannelService (A11 sender-scoped). */
function idemKey(workspaceId: string, clientMsgId: string): string {
  return JSON.stringify([workspaceId, clientMsgId]);
}

/**
 * Boot replay applier (§5). Mutates state in place. No event emission (reconstruction is silent).
 * All branches are idempotent — see file header invariant.
 */
export function applyChannelEvent(state: ChannelState, payload: unknown): void {
  if (payload === null || typeof payload !== 'object') return;
  const p = payload as ChannelEventPayload;
  switch (p.kind) {
    case 'create': {
      if (state.channels.some((c) => c.id === p.channel.id)) return; // idempotent
      state.channels.push({ ...p.channel });
      state.members[p.channel.id] = p.members.map((m) => ({ ...m }));
      state.messages[p.channel.id] = [];
      state.idempotency[p.channel.id] = {};
      return;
    }
    case 'archive': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      ch.status = 'archived';
      ch.archivedAt = p.archivedAt;
      ch.archivedBy = p.archivedBy;
      return;
    }
    case 'join':
    case 'invite': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const members = state.members[p.channelId] ?? [];
      // Idempotent: if row with same (workspaceId, memberId) already exists, re-apply is no-op.
      if (
        members.some(
          (m) => m.workspaceId === p.member.workspaceId && m.memberId === p.member.memberId,
        )
      ) {
        return;
      }
      members.push({ ...p.member });
      state.members[p.channelId] = members;
      // Live path always clears emptySince on join/invite.
      delete ch.emptySince;
      return;
    }
    case 'leave':
    case 'kick':
    case 'purge': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const members = state.members[p.channelId] ?? [];
      const matches = (m: ChannelMember): boolean => {
        if (p.kind === 'leave') {
          return m.workspaceId === p.workspaceId && m.memberId === p.memberId;
        }
        if (p.kind === 'kick') {
          return (
            m.workspaceId === p.targetWorkspaceId && m.memberId === p.targetMemberId
          );
        }
        // purge — same shape as live matcher (principalId first, then memberId, else whole ws).
        return (
          m.workspaceId === p.workspaceId &&
          (p.principalId !== undefined
            ? m.principalId === p.principalId
            : p.memberId === undefined || m.memberId === p.memberId)
        );
      };
      const survivors = members.filter((m) => !matches(m));
      if (survivors.length === members.length) return; // idempotent: already removed
      state.members[p.channelId] = survivors;
      if (
        p.emptySince !== undefined &&
        survivors.length === 0 &&
        ch.emptySince === undefined
      ) {
        ch.emptySince = p.emptySince;
      }
      return;
    }
    case 'post': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const msgs = (state.messages[p.channelId] ??= []);
      const seq = p.message.seq;
      // Idempotent: same seq already present (snapshot pre-reflection·promotion reappearance) — re-apply no-op.
      if (msgs.some((m) => m.seq === seq)) return;
      // Trimmed history guard (panel CL-3): seq < nextSeq but absent from msgs = history cap
      // already cut this past post. Re-applying would append to tail and break order, and cap trim would
      // evict preserved content from the front. Snapshot already reflected that effect (cursor·idempotency included),
      // so full no-op.
      if (seq < ch.nextSeq) return;
      msgs.push({ ...p.message });
      // nextSeq advance (equivalent to live nextSeq++ — replay clamps forward to seq+1).
      if (ch.nextSeq <= seq) ch.nextSeq = seq + 1;
      // Cursor ride — same live condition (lastReadSeq === seq-1), re-apply is no-op.
      if (p.cursorRide) {
        const row = (state.members[p.channelId] ?? []).find(
          (m) =>
            m.workspaceId === p.cursorRide!.workspaceId &&
            m.memberId === p.cursorRide!.memberId,
        );
        if (row && row.lastReadSeq === seq - 1) row.lastReadSeq = seq;
      }
      // 1b name refresh (set confirmed value — idempotent).
      if (p.nameRefresh) {
        const row = (state.members[p.channelId] ?? []).find(
          (m) =>
            m.workspaceId === p.nameRefresh!.workspaceId &&
            m.memberId === p.nameRefresh!.memberId,
        );
        if (row) row.memberName = p.nameRefresh.memberName;
      }
      // Idempotency index (state.idempotency) is log projection (§4) — post apply reconstructs it.
      if (p.message.clientMsgId) {
        const map = (state.idempotency[p.channelId] ??= {});
        map[idemKey(p.message.workspaceId, p.message.clientMsgId)] = seq;
        // On cap overflow, delete oldest by insertion order (same shape as boot hydration FIFO seed —
        // live LRU recency info is not in the log, so insertion order is the deterministic substitute).
        const keys = Object.keys(map);
        for (let i = 0; keys.length - i > CHANNEL_IDEMPOTENCY_CAP; i++) {
          delete map[keys[i]];
        }
      }
      // History cap trim (A2) — same rule live applies after post-commit, so replay converges
      // without a separate trim event.
      if (msgs.length > CHANNEL_MESSAGES_MAX) {
        const trimmed = msgs.slice(msgs.length - CHANNEL_MESSAGES_MAX);
        state.messages[p.channelId] = trimmed;
        const minSeq = trimmed.length > 0 ? trimmed[0].seq : 0;
        const map = state.idempotency[p.channelId];
        if (map) {
          for (const [k, v] of Object.entries(map)) {
            if (v < minSeq) delete map[k];
          }
        }
      }
      return;
    }
    case 'ack': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // Receipt flip — only touches pending → delivered, so re-apply is no-op (idempotent).
      for (const m of state.messages[p.channelId] ?? []) {
        if (m.seq > p.uptoSeq) continue;
        for (const entry of m.recipientSnapshot ?? []) {
          if (entry.workspaceId === p.workspaceId && entry.status === 'pending') {
            entry.status = 'delivered';
            entry.lastAttemptAt = p.ackedAt;
            if (m.deliveryStatus !== 'delivered') m.deliveryStatus = 'delivered';
          }
        }
      }
      // Cursor advance — advance-only·head clamp (same as live), cannot regress so idempotent.
      if (p.memberId !== undefined) {
        const cursorTarget = Math.min(p.uptoSeq, ch.nextSeq - 1);
        for (const row of state.members[p.channelId] ?? []) {
          if (row.workspaceId !== p.workspaceId || row.memberId !== p.memberId) continue;
          const current = typeof row.lastReadSeq === 'number' ? row.lastReadSeq : -1;
          if (cursorTarget > current) row.lastReadSeq = cursorTarget;
        }
      }
      return;
    }
    case 'operator-join': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // Apply both effects with independent idempotent guards (live always runs both, but re-apply
      // safely absorbs partial-reflection snapshots too).
      // 1) Human seat push — no-op if (workspaceId, memberId) exists (same shape as join applier).
      const members = state.members[p.channelId] ?? [];
      if (
        !members.some(
          (m) => m.workspaceId === p.member.workspaceId && m.memberId === p.member.memberId,
        )
      ) {
        members.push({ ...p.member });
        state.members[p.channelId] = members;
        // operatorJoin re-entry after leave is also a "new seat" → clears emptySince like join.
        delete ch.emptySince;
      }
      // 2) System message append — seq existence/trimmed past seq guard (same shape as post applier).
      //    No clientMsgId·cursorRide·nameRefresh (system marker).
      const msgs = (state.messages[p.channelId] ??= []);
      const seq = p.message.seq;
      if (!msgs.some((m) => m.seq === seq) && seq >= ch.nextSeq) {
        msgs.push({ ...p.message });
        if (ch.nextSeq <= seq) ch.nextSeq = seq + 1;
        if (msgs.length > CHANNEL_MESSAGES_MAX) {
          state.messages[p.channelId] = msgs.slice(msgs.length - CHANNEL_MESSAGES_MAX);
        }
      }
      return;
    }
    case 'legacy-reseed':
      return; // State carried by reseed snapshot (§6.4c) — marker is audit-only.
    default:
      return; // Unknown kind — forward-compatible pass-through (additive-only).
  }
}
