// Verification rig — SIM S5: no-ack ×3 (design §4 scenario S5)
//
// Contract (v1.1 §4 — **current receipt contract pinned**): no-ack personas receive but do not ack.
// `deliveryStatus` transitions pending→delivered only via ack
// (`ChannelService.ack` `src/daemon/channels/ChannelService.ts:2086-2090`, schema
// `src/shared/channels.ts:159`). Without ack, pending persists — and when any recipient acks,
// message deliveryStatus also transitions to delivered at that moment ("at least one delivered").
//
// **Why pin this** (review Claude m/80): when Q1-2 P3 overturns this receipt contract, the rig
// **breaks together** to force updates — intentional. Assertions cite canonical coordinates in
// comments (assert.ts `assertDeliveryStatus` header) and literalize the current contract. When
// contract changes, this test goes red as signal to "update the rig too".
//
// Execution model: channel open (sender 1 + 3 no-ack receivers) → sender posts once → confirm
// deliveryStatus=pending · all recipient snapshots pending with **nobody ack'd** → 3 no-ack keep
// not acking (unread persists) → exactly 1 acks → message deliveryStatus=delivered at that moment
// (& that recipient snapshot delivered, remaining no-ack still pending).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertDeliveryStatus,
  assertUnread,
  type RigChannelMessage,
  type RigDeliveryRow,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

const NO_ACK_COUNT = 3;

describe('SIM S5 — no-ack ×3: current receipt contract pinned (deliveryStatus transitions only on ack)', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  let runner: PersonaRunner;
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
  }, 120000);

  afterAll(async () => {
    runner?.closeAll();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('without ack deliveryStatus and recipient snapshot stay pending, on ack they transition immediately', async () => {
    // Deterministic fixed loop (no rng) — seed only used for PersonaRunner rng; scenario body
    // does not consume it. No seed reproduction wording (avoids false signal).
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's5', seed });
      const all = runner.spawn(1 + NO_ACK_COUNT);
      const sender = all[0];
      const receivers = all.slice(1); // 3 no-ack personas.
      const { channelId, nextSeq } = await runner.openChannel('rig-s5-noack', sender, receivers);
      expect(nextSeq, 'nextSeq=1 immediately after create').toBe(1);

      // Sender posts once. At this point message deliveryStatus=pending, all snapshots pending.
      const posted = await sender.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: sender.ws, memberId: sender.ws },
        text: 's5|the-message',
      });
      const postedSeq = (posted['message'] as { seq: number }).seq;
      expect(postedSeq, 'first post seq=1').toBe(1);

      // Helper: fetch postedSeq message row from current ledger (deliveryStatus + snapshot included).
      const readRow = async (): Promise<RigChannelMessage & RigDeliveryRow> => {
        const fetched = await sender.client.channelRpc('a2a.channel.getMessages', { channelId });
        const msgs = (fetched['messages'] ?? []) as Array<RigChannelMessage & RigDeliveryRow>;
        const row = msgs.find((m) => m.seq === postedSeq);
        if (!row) throw new Error(`[S5] posted message seq=${postedSeq} not found`);
        return row;
      };

      // 1. Nobody ack'd: message pending + each no-ack recipient snapshot pending.
      let row = await readRow();
      for (const r of receivers) {
        assertDeliveryStatus(row, 'pending', r.ws, 'pending');
      }

      // 2. 3 no-ack keep not acking → each has unread=1 (unread non-self message).
      //    This is the no-ack persona definition: can receive but does not ack, so no receipt.
      for (const r of receivers) {
        const unread = await r.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        assertUnread(entries, channelId, r.ws, { unread: 1, headSeq: 1 });
      }

      // 3. Exactly one no-ack acks → at that moment (a) message deliveryStatus=delivered ("at least
      //    one"), (b) that recipient snapshot delivered, (c) remaining no-ack still pending.
      const acker = receivers[0];
      const stillNoAck = receivers.slice(1);
      await acker.client.channelRpc('a2a.channel.ack', {
        channelId,
        uptoSeq: postedSeq,
        memberId: acker.ws, // Member-scoped ack (includes cursor advance) — agent consumption path.
      });

      row = await readRow();
      // (a)+(b): message is delivered, acker snapshot is delivered.
      assertDeliveryStatus(row, 'delivered', acker.ws, 'delivered');
      // (c): no-ack recipients who haven't ack'd — snapshots still pending (message showing delivered
      //      is independent; per-recipient receipt flips only on own ack).
      for (const r of stillNoAck) {
        const entries = (row.recipientSnapshot ?? []).filter((e) => e.workspaceId === r.ws);
        expect(entries.length, `no-ack ${r.ws} snapshot entry exists`).toBeGreaterThan(0);
        for (const e of entries) {
          expect(e.status, `no-ack ${r.ws} still pending`).toBe('pending');
        }
      }

      // 4. Acker unread dropped to 0 (cursor advanced), but no-ack still unread=1.
      {
        const unread = await acker.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        assertUnread(entries, channelId, acker.ws, { unread: 0 });
      }
      for (const r of stillNoAck) {
        const unread = await r.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        assertUnread(entries, channelId, r.ws, { unread: 1 });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S5] FAILED (deterministic fixed-loop scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S5] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
