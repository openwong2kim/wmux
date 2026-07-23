// Verification rig — SIM S2: ping-pong ×2 (design §4 scenario S2, v1.1 redefinition)
//
// Contract (v1.1 §4 table — **sole canonical source**): two personas mention each other in
// round-trip load. Assertion = **channel integrity only** (no loss · order · cap · daemon resource
// bounds). **No anti-loop assertion.**
//
// Why no anti-loop assertion (review P6 — Claude M/82): server-side pair-cap is unimplemented /
// deferred, and replyGate is a renderer prompt string (`src/renderer/hooks/
// channelMentionFlush.ts:131`) — **absent** from SIM observability (daemon pipe). Asserting a
// nonexistent contract marks normal behavior as fail (footgun). S2 only verifies "channel retains
// integrity under ping-pong load".
//
// Daemon resource bounds (v1.1 §4): RSS/CPU measurement is overkill for SIM — substitute with
// `daemon.ping` round-trip surviving the entire round-trip load (daemon neither dies nor hangs
// indefinitely).
//
// Execution model: RigDaemon.spawn → channel open (2 personas) → deterministic round-trip rounds
// (each round mentions the other) → full getMessages reconciliation (no loss · contiguous seq ·
// bodies) + unread mention consistency + ping liveness.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertChannelSeq,
  assertTextsDelivered,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

/** Round-trip round count (each round = both personas post once = 2 posts). */
const ROUNDS = 12;

describe('SIM S2 — ping-pong ×2: channel integrity under ping-pong load (no anti-loop assertion)', () => {
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

  it('two personas mention-ping-pong and all messages arrive with contiguous seq, no loss, no infinite hold', async () => {
    // This scenario is **deterministic fixed loop** (no rng) — seed is only used by PersonaRunner
    // to create rng; this scenario body does not consume it. So no "reproduce with WMUX_RIG_SEED"
    // wording (avoids false signal — review minor).
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's2', seed });
      const [a, b] = runner.spawn(2);
      const { channelId, nextSeq } = await runner.openChannel('rig-s2-pingpong', a, [b]);
      expect(nextSeq, 'nextSeq=1 immediately after create').toBe(1);

      // Round-trip rounds: each round a mentions b, then b mentions a. Sequential within persona
      // (next post after prior commit confirmed) → deterministic order. Bodies unique by (sender, round).
      const sentTexts: string[] = [];
      // Count mentions each persona receives from peer (= peer sends) for unread mention reconciliation.
      for (let r = 0; r < ROUNDS; r++) {
        const aText = `s2|a|r${r} @${b.ws}`;
        const aRes = await a.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: a.ws, memberId: a.ws },
          text: aText,
          mentions: [{ workspaceId: b.ws, name: b.ws }],
        });
        expect((aRes['message'] as { seq: number }).seq, `a post r${r} seq`).toBe(2 * r + 1);
        sentTexts.push(aText);

        const bText = `s2|b|r${r} @${a.ws}`;
        const bRes = await b.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: b.ws, memberId: b.ws },
          text: bText,
          mentions: [{ workspaceId: a.ws, name: a.ws }],
        });
        expect((bRes['message'] as { seq: number }).seq, `b post r${r} seq`).toBe(2 * r + 2);
        sentTexts.push(bText);

        // Daemon resource bound substitute: ping must stay alive mid round-trip (no infinite hold ·
        // no daemon death). ping is identity-agnostic — call via rpc() directly. daemon.ping handler
        // returns `{ status: 'ok', ... }` (`src/daemon/index.ts:1548-1558`) — check handler payload
        // status, not transport envelope ok (rpc() unwraps envelope).
        const pong = (await a.client.rpc('daemon.ping', {})) as { status?: string } | undefined;
        expect(pong?.status, `ping-pong during round ${r} daemon.ping alive`).toBe('ok');
      }

      const totalPosts = 2 * ROUNDS;

      // Full integrity reconciliation (no loss · contiguous seq · no duplicates · bodies).
      const fetched = await a.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];
      assertChannelSeq(messages, totalPosts, 1);
      assertTextsDelivered(messages, sentTexts);

      // Mention consistency: each persona counts ROUNDS peer-sent mentions via mentionUnread
      // (self-authored exempt — `unreadFor` self-authored skip :2349). Nobody has ack'd yet.
      for (const [self, peer] of [
        [a, b],
        [b, a],
      ] as const) {
        const unread = await self.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === self.ws);
        expect(row, `unread entry (ws=${self.ws})`).toBeTruthy();
        // Mentions received from peer = ROUNDS. An infinite loop would have blown this up.
        expect(row!.mentionUnread, `${self.ws} mention count received from ${peer.ws} = ROUNDS`).toBe(
          ROUNDS,
        );
        // Head consistency (all posts committed).
        expect(row!.headSeq, `${self.ws} headSeq = totalPosts`).toBe(totalPosts);
      }

      // Final daemon liveness (still responds after round-trip load — terminal resource-bound check).
      const finalPing = (await a.client.rpc('daemon.ping', {})) as { status?: string };
      expect(finalPing.status, 'daemon alive after ping-pong load').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S2] FAILED (deterministic fixed-loop scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S2] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
