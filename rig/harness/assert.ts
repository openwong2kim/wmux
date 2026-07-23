// Verification rig — state assertion helpers (design §5)
//
// Each helper asserts contracts against the daemon source of truth (pipe RPC results). §5 rule: **each helper
// comment must cite source-of-truth code coordinates** — when contracts move (e.g. seq rules or unread formula change),
// the rig is meant to break together and force updates. Asserting non-existent contracts marks normal behavior as fail (footgun),
// so coordinates are the contract's provenance marker.
//
// Failures throw(Error). vitest catches them and marks scenarios red.

/** Minimum shape of a message row returned by the daemon (fields assertions read only). */
export interface RigChannelMessage {
  /** Source of truth: `src/shared/channels.ts:141` — monotonic per-channel sequence (KTD2). */
  seq: number;
  /** Source of truth: `src/shared/channels.ts:142` — sending workspace. */
  workspaceId: string;
  text: string;
}

/** Minimum shape of an unread entry returned by the daemon. */
export interface RigUnreadEntry {
  /** Source of truth: return type of `ChannelService.unreadFor` `src/daemon/channels/ChannelService.ts:2304-2317`. */
  channelId: string;
  memberId: string;
  lastReadSeq: number;
  headSeq: number;
  unread: number;
  mentionUnread: number;
}

/**
 * Message fields needed to read delivery receipts (S5 no-ack current contract pinning). getMessages returns
 * the full `ChannelMessage`, so these fields exist (`ChannelService.getMessages`
 * → `ChannelMessage`, `src/shared/channels.ts:159,:167`).
 */
export interface RigDeliveryRow {
  /** Source of truth: `src/shared/channels.ts:159` — 'pending' at post, transitions to 'delivered' only via ack. */
  deliveryStatus: 'pending' | 'delivered' | 'target_gone';
  /** Source of truth: `src/shared/channels.ts:167,:232` — all members frozen as 'pending' at post. */
  recipientSnapshot?: Array<{ workspaceId: string; memberId: string; status: 'pending' | 'delivered' | 'target_gone' }>;
}

/** Minimum task state shape (S8). */
export interface RigTask {
  /** Source of truth: `Task.status.state` `src/shared/types.ts` (VALID_TRANSITIONS target). */
  status: { state: string };
  id: string;
}

/**
 * Seq integrity assertion — checks that getMessages full results are (a) exactly expected count (b) contiguous seq (gap 0)
 * (c) no duplicates (d) starting from expected seq.
 *
 * Source-of-truth contract:
 *   - seq is monotonic per-channel, +1 per post: first channel's nextSeq=1 right after create
 *     (`ChannelService.create` → `channel.nextSeq: 1`, smoke verified), post consumes and increments nextSeq
 *     → if lossless, contiguous [expectedFromSeq .. expectedFromSeq+N-1].
 *   - getMessages returns seq >= floor filter in order (`ChannelService.getMessages`
 *     `src/daemon/channels/ChannelService.ts:625` filter, public channel floor=0).
 *   - post commit contract: RPC ok return = after fsync commit (envelope PR3) → every message that got ok
 *     must appear in getMessages (lossless).
 *
 * @param messages       Full getMessages result.
 * @param expectedCount  Expected message count (total posts fired).
 * @param expectedFromSeq Expected starting seq (first post's seq — usually 1).
 */
export function assertChannelSeq(
  messages: RigChannelMessage[],
  expectedCount: number,
  expectedFromSeq: number,
): void {
  if (messages.length !== expectedCount) {
    throw new Error(
      `assertChannelSeq: expected ${expectedCount} messages, got ${messages.length} ` +
        `(seqs=[${messages.map((m) => m.seq).join(',')}]) — suspected loss or duplicate`,
    );
  }
  const seen = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const seq = messages[i].seq;
    if (seen.has(seq)) {
      throw new Error(`assertChannelSeq: duplicate seq ${seq} at index ${i} (no-duplicate violation)`);
    }
    seen.add(seq);
    const expectedSeq = expectedFromSeq + i;
    if (seq !== expectedSeq) {
      throw new Error(
        `assertChannelSeq: non-contiguous seq at index ${i}: expected ${expectedSeq}, got ${seq} ` +
          `(seqs=[${messages.map((m) => m.seq).join(',')}]) — gap or order violation`,
      );
    }
  }
}

/**
 * Full text multiset assertion — checks that sent bodies match received bodies exactly
 * (order-independent, no loss or duplication of content). When the flood persona fires deterministic bodies,
 * pins "full delivery" by content as well as seq.
 *
 * Source of truth: message body is preserved verbatim in `ChannelMessage.text` (`src/shared/channels.ts:146`).
 */
export function assertTextsDelivered(messages: RigChannelMessage[], expectedTexts: string[]): void {
  const got = messages.map((m) => m.text).slice().sort();
  const want = expectedTexts.slice().sort();
  if (got.length !== want.length) {
    throw new Error(
      `assertTextsDelivered: expected ${want.length} texts, got ${got.length}`,
    );
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      throw new Error(
        `assertTextsDelivered: text multiset mismatch at sorted index ${i}: ` +
          `want=${JSON.stringify(want[i])} got=${JSON.stringify(got[i])} — body loss/mutation`,
      );
    }
  }
}

/**
 * Unread assertion — checks unread/headSeq/lastReadSeq for a specific (channel, member).
 *
 * Source-of-truth contract (`ChannelService.unreadFor` `src/daemon/channels/ChannelService.ts:2304-2343`):
 *   - headSeq = channel.nextSeq - 1 (last committed seq).
 *   - unread = count of messages above cursor(lastReadSeq) and >= historyFromSeq.
 *   - Members who have not acked yet count messages they have not seen as unread (formula is seq-only, so
 *     own sends may be included — caller must compute expected accordingly).
 *
 * @param entries   Full entries from unread RPC.
 * @param channelId Target channel.
 * @param memberId  Target member (usually assigned same as workspaceId).
 * @param expect    Expected values (partial — only provided fields are checked).
 */
export function assertUnread(
  entries: RigUnreadEntry[],
  channelId: string,
  memberId: string,
  expect: { unread?: number; headSeq?: number; lastReadSeq?: number; mentionUnread?: number },
): void {
  const row = entries.find((e) => e.channelId === channelId && e.memberId === memberId);
  if (!row) {
    throw new Error(
      `assertUnread: no unread entry for (channel=${channelId}, member=${memberId}) ` +
        `— entries=${JSON.stringify(entries)}`,
    );
  }
  for (const key of ['unread', 'headSeq', 'lastReadSeq', 'mentionUnread'] as const) {
    const want = expect[key];
    if (want !== undefined && row[key] !== want) {
      throw new Error(
        `assertUnread: (channel=${channelId}, member=${memberId}) ${key} expected ${want}, got ${row[key]} ` +
          `— row=${JSON.stringify(row)}`,
      );
    }
  }
}

/**
 * Delivery receipt contract pinning assertion (S5 no-ack). Checks that a specific message's `deliveryStatus` and
 * the target workspace entry/entries in its `recipientSnapshot` match expectations.
 *
 * Source-of-truth contract (§4 S5 — if Q1-2 P3 inverts this contract, the rig is meant to break and force updates,
 * design Claude m/80):
 *   - Right after post: message `deliveryStatus='pending'`, all member snapshots 'pending'
 *     (`ChannelService.post` `src/daemon/channels/ChannelService.ts:1755-1759,:1844-1845`).
 *   - **Only** ack transitions caller snapshot pending→delivered; when at least one is delivered, message
 *     `deliveryStatus` also transitions to delivered (`ChannelService.ack` :2086-2090). Without ack,
 *     pending persists — this function pins that invariant.
 *
 * @param row               Message row from getMessages (deliveryStatus + recipientSnapshot).
 * @param expectMsgStatus   Expected message delivery status.
 * @param recipientWs       Target workspace to check in snapshot.
 * @param expectRowStatus   Expected status for that workspace snapshot entry.
 */
export function assertDeliveryStatus(
  row: RigDeliveryRow,
  expectMsgStatus: RigDeliveryRow['deliveryStatus'],
  recipientWs: string,
  expectRowStatus: 'pending' | 'delivered' | 'target_gone',
): void {
  if (row.deliveryStatus !== expectMsgStatus) {
    throw new Error(
      `assertDeliveryStatus: message deliveryStatus expected ${expectMsgStatus}, got ${row.deliveryStatus} ` +
        `— canonical contract (transition only on ack) violation. row=${JSON.stringify(row)}`,
    );
  }
  const entries = (row.recipientSnapshot ?? []).filter((e) => e.workspaceId === recipientWs);
  if (entries.length === 0) {
    throw new Error(
      `assertDeliveryStatus: no recipientSnapshot entry for workspace=${recipientWs} ` +
        `— snapshot=${JSON.stringify(row.recipientSnapshot)}`,
    );
  }
  for (const e of entries) {
    if (e.status !== expectRowStatus) {
      throw new Error(
        `assertDeliveryStatus: recipientSnapshot[${recipientWs}] status expected ${expectRowStatus}, got ${e.status} ` +
          `— entry=${JSON.stringify(e)}`,
      );
    }
  }
}

/**
 * Task state assertion (S8). Finds taskId in query result and checks status.state matches expectation.
 *
 * Source of truth: `A2aTaskService.queryTasks` returns `Task[]`; `task.status.state` is a state machine
 * enforced by VALID_TRANSITIONS (`src/shared/types.ts:655`).
 */
export function assertTaskState(tasks: RigTask[], taskId: string, expectState: string): void {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(
      `assertTaskState: task ${taskId} not found in query result ` +
        `(ids=[${tasks.map((t) => t.id).join(',')}])`,
    );
  }
  if (task.status.state !== expectState) {
    throw new Error(
      `assertTaskState: task ${taskId} state expected ${expectState}, got ${task.status.state}`,
    );
  }
}

/**
 * S7 one-way subset assertion (design §4 S7 · footgun 9). After SIGKILL→respawn, checks that the set of items
 * **confirmed committed via RPC ok** is a **subset** of the replay result set.
 *
 * Why one-way (review Claude c/80): AppendOnlyLog has at-least-once valid-tail promotion contract
 * (`src/daemon/eventlog/AppendOnlyLog.ts:13-15,:254-269`) — physically written but uncommitted data before the
 * fsync barrier may be legitimately promoted on boot scan. Therefore "no resurrection of uncommitted"(replay ⊆
 * committed) would mark normal behavior as fail and is **not assertable**. What we pin is only
 * "RPC-ok-confirmed commits must survive"(committed ⊆ replay) — lossless survival of confirmed commits.
 *
 * @param committed  Items definitely committed before SIGKILL (e.g. seq·taskId) via RPC ok.
 * @param replayed   Full items restored by daemon replay after respawn.
 * @param label      Diagnostic label.
 */
export function assertReplaySuperset<T>(committed: T[], replayed: T[], label: string): void {
  const have = new Set(replayed);
  const missing = committed.filter((c) => !have.has(c));
  if (missing.length > 0) {
    throw new Error(
      `assertReplaySuperset[${label}]: ${missing.length} committed item(s) did NOT survive replay ` +
        `(missing=[${missing.map((m) => String(m)).join(',')}]) — confirmed commit lossless violation. ` +
        `replayed=[${replayed.map((r) => String(r)).join(',')}]`,
    );
  }
}
