// Verification rig — SIM S3: dead ×3 + alive ×2 (design §4 scenario S3)
//
// Contract (v1.1 §4): 3 dead personas join · post then vanish (socket close). 2 alive personas
// keep acting. Core assertion = unread · lifecycle convergence + **channel function survives**
// (channel keeps working after dead vanish; dead's messages/membership remain in ledger).
//
// SIM model of "dead vanish": daemon pipe is stateless per connection (persona = one socket),
// so dead's PipeClient.close() is that persona's vanish — daemon keeps durable membership ledger,
// dead's posted messages remain in seq ledger (disconnect ≠ leave). This mirrors production:
// agent pane death leaves channel membership · history in daemon canonical store.
//
// Execution model: channel open (5 personas) → 3 dead post then close → 2 alive keep posting →
// full getMessages reconciliation (dead messages persist) + getMembers (dead membership persists) +
// alive persona unread consistency (dead sends count as unread if unread) + daemon liveness.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertChannelSeq,
  assertTextsDelivered,
  assertUnread,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

const DEAD_COUNT = 3;
const ALIVE_COUNT = 2;

describe('SIM S3 — dead ×3 + alive ×2: unread/lifecycle convergence, channel function survives', () => {
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

  it('after 3 dead personas vanish channel still works and dead ledger (messages·membership) remains', async () => {
    // Deterministic fixed loop (no rng) — seed only used for PersonaRunner rng; scenario body
    // does not consume it. No seed reproduction wording (avoids false signal).
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's3', seed });
      const all = runner.spawn(DEAD_COUNT + ALIVE_COUNT);
      const dead = all.slice(0, DEAD_COUNT);
      const alive = all.slice(DEAD_COUNT);
      const creator = alive[0]; // Alive persona owns channel (does not vanish).
      const others = all.filter((p) => p !== creator);
      const { channelId, nextSeq } = await runner.openChannel('rig-s3-dead', creator, others);
      expect(nextSeq, 'nextSeq=1 immediately after create').toBe(1);

      const sentTexts: string[] = [];
      let seq = 0;

      // 1. Each of 3 dead posts once then closes socket to vanish (sequential — deterministic seq).
      for (const d of dead) {
        const text = `s3|dead|${d.ws}`;
        const res = await d.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: d.ws, memberId: d.ws },
          text,
        });
        seq += 1;
        expect((res['message'] as { seq: number }).seq, `dead post seq (${d.ws})`).toBe(seq);
        sentTexts.push(text);
        d.client.close(); // Vanish — this persona makes no further calls.
      }

      // 2. 2 alive keep posting after dead vanish (proves channel function survives).
      const alivePostsEach = 3;
      for (const p of alive) {
        for (let k = 0; k < alivePostsEach; k++) {
          const text = `s3|alive|${p.ws}|#${k}`;
          const res = await p.client.channelRpc('a2a.channel.post', {
            channelId,
            sender: { workspaceId: p.ws, memberId: p.ws },
            text,
          });
          seq += 1;
          expect((res['message'] as { seq: number }).seq, `alive post seq (${p.ws} #${k})`).toBe(
            seq,
          );
          sentTexts.push(text);
        }
      }
      const totalPosts = seq;

      // 3. Full getMessages reconciliation: dead's messages persist in ledger (vanish ≠ history delete).
      const fetched = await creator.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];
      assertChannelSeq(messages, totalPosts, 1);
      assertTextsDelivered(messages, sentTexts);
      for (const d of dead) {
        expect(
          messages.some((m) => m.workspaceId === d.ws),
          `dead ${d.ws} messages must remain in ledger`,
        ).toBe(true);
      }

      // 4. getMembers: dead membership persists (disconnect is not leave). All personas (dead included)
      //    must remain in member list.
      const membersRes = await creator.client.channelRpc('a2a.channel.getMembers', { channelId });
      const members = (membersRes['members'] ?? []) as Array<{ workspaceId: string }>;
      for (const p of all) {
        expect(
          members.some((m) => m.workspaceId === p.ws),
          `${p.ws} membership must remain (including dead)`,
        ).toBe(true);
      }

      // 5. Alive persona unread consistency: nobody ack'd yet, so each alive persona counts all messages
      //    (except self-authored) as unread — including dead sends (lifecycle convergence: sender death
      //    does not remove message from recipient unread).
      //
      //    **Cursor input is client ledger — do not put daemon output into expected values (R1 circular lesson)**:
      //    no alive persona called ack, so client-known cursor = initial = historyFrom (public channel=0).
      //    Using daemon-reported lastReadSeq as unread expected input moves both expected and actual together
      //    on cursor corruption bugs (partial circularity caught in R1). So expected is computed from
      //    client-side cursor (0) only; daemon lastReadSeq is separately asserted to match that client-side
      //    value (cursor integrity).
      const CLIENT_KNOWN_CURSOR = 0; // Public channel historyFrom, no ack → client-known cursor.
      for (const p of alive) {
        const unread = await p.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === p.ws);
        expect(row, `unread entry (ws=${p.ws})`).toBeTruthy();
        assertUnread(entries, channelId, p.ws, { headSeq: totalPosts });
        // Cursor integrity: daemon lastReadSeq must match client-side cursor (0 — no ack).
        expect(row!.lastReadSeq, `daemon cursor matches client-side value (ws=${p.ws})`).toBe(
          CLIENT_KNOWN_CURSOR,
        );
        // Expected unread = count of client-ledger posts where seq > client-side cursor AND sender≠self.
        // Daemon lastReadSeq is comparison target, not expected-value input.
        const expectedUnread = messages.filter(
          (m) => m.seq > CLIENT_KNOWN_CURSOR && m.workspaceId !== p.ws,
        ).length;
        expect(row!.unread, `unread recalculation cross-check (ws=${p.ws})`).toBe(expectedUnread);
      }

      // 6. Daemon liveness (dead vanish does not destabilize daemon). daemon.ping handler returns
      //    `{ status: 'ok', ... }` (`src/daemon/index.ts:1548`).
      const ping = (await creator.client.rpc('daemon.ping', {})) as { status?: string };
      expect(ping.status, 'after dead personas vanish daemon alive').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S3] FAILED (deterministic fixed-loop scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S3] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
