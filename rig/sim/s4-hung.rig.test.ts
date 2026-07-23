// Verification rig — SIM S4: hung ×2 + alive ×2 (design §4 scenario S4, v1.1 redefinition)
//
// Contract (v1.1 §4 — **sole canonical source**): 2 hung personas join the channel then stay
// **connected but unresponsive** (no ack · no post — unlike dead, socket stays open). 2 alive
// personas keep acting. Assertion = **channel integrity · no infinite hold · unread accuracy** only.
//
// No ~~nudgeExhausted~~ assertion (review P5 — Claude c/85): nudge storm guard
// (`channelWakeWorker.ts:35` re-nudge cap → nudgeExhausted) **requires live PTY sessions**
// (`channelWakeWorker.ts:88` listLiveSessions + slug match + output silence). SIM does not
// consume real PTY (RigSession is harness-ready only; consumption is E2E/follow-up), so trigger
// conditions never fire. Do not assert nonexistent contracts.
//
// SIM model of "no infinite hold": even when hung is unresponsive, (a) alive posts commit
// immediately on channel mutex (hung's missing ack does not lock channel), (b) daemon ping
// survives entire span. Hung unread keeps accumulating (no ack → exactly unread count).
//
// Execution model: channel open (4 personas) → 2 hung join only (then unresponsive, socket kept) →
// 2 alive fire → immediate alive post commit confirmation (no infinite hold) + hung unread monotonic
// growth + daemon liveness.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertChannelSeq,
  assertUnread,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

const HUNG_COUNT = 2;
const ALIVE_COUNT = 2;
/** Posts per alive persona (enough to observe hung unread monotonic growth). */
const ALIVE_BURST = 5;

describe('SIM S4 — hung ×2 + alive ×2: channel integrity, no infinite hold (no nudge assertion)', () => {
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

  it('with 2 hung personas unresponsive alive posts commit immediately and hung unread accumulates correctly', async () => {
    // Deterministic fixed loop (no rng) — seed only used for PersonaRunner rng; scenario body
    // does not consume it. No seed reproduction wording (avoids false signal).
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's4', seed });
      const all = runner.spawn(HUNG_COUNT + ALIVE_COUNT);
      const hung = all.slice(0, HUNG_COUNT);
      const alive = all.slice(HUNG_COUNT);
      const creator = alive[0];
      const others = all.filter((p) => p !== creator);
      // openChannel joins everyone including hung (hung is normal through join, then unresponsive).
      const { channelId, nextSeq } = await runner.openChannel('rig-s4-hung', creator, others);
      expect(nextSeq, 'nextSeq=1 immediately after create').toBe(1);

      // 2 alive alternate firing. Hung does nothing (socket left open).
      // Each post commit confirmed immediately — if hung's missing ack locked channel mutex,
      // timeout would occur here; ok return itself is evidence of "no infinite hold".
      let seq = 0;
      for (let k = 0; k < ALIVE_BURST; k++) {
        for (const p of alive) {
          const res = await p.client.channelRpc('a2a.channel.post', {
            channelId,
            sender: { workspaceId: p.ws, memberId: p.ws },
            text: `s4|alive|${p.ws}|#${k}`,
          });
          seq += 1;
          // Immediate commit (no block). Post ok after fsync (envelope PR3) — return = no infinite hold.
          expect((res['message'] as { seq: number }).seq, `alive post commits immediately (${p.ws} #${k})`).toBe(
            seq,
          );
        }
        // Daemon liveness each round (hung idle does not destabilize daemon). daemon.ping handler
        // returns `{ status: 'ok', ... }` (`src/daemon/index.ts:1548`) — check handler status.
        const pong = (await creator.client.rpc('daemon.ping', {})) as { status?: string };
        expect(pong?.status, `round ${k} daemon alive`).toBe('ok');
      }
      const totalPosts = seq;

      // Full integrity (all alive sends, contiguous seq).
      const fetched = await creator.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];
      assertChannelSeq(messages, totalPosts, 1);

      // Hung unread: never ack'd, so all alive sends are unread = totalPosts.
      // (Hung has no self-sends, no self-exemption → all messages unread.) Pin "exactly totalPosts"
      // — neither runaway nor loss.
      for (const h of hung) {
        const unread = await h.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === h.ws);
        expect(row, `hung unread entry (ws=${h.ws})`).toBeTruthy();
        assertUnread(entries, channelId, h.ws, { headSeq: totalPosts, unread: totalPosts });
      }

      // Terminal daemon liveness.
      const finalPing = (await creator.client.rpc('daemon.ping', {})) as { status?: string };
      expect(finalPing.status, 'after hung left idle daemon alive').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S4] FAILED (deterministic fixed-loop scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S4] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
