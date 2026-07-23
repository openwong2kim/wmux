// Verification rig — SIM S1: flood ×8 (design §4 scenario S1)
//
// Core assertion (§4): after 8 flood personas fire into one channel with a deterministic seed,
// full getMessages reconciliation confirms (full delivery · contiguous seq · no duplicates).
// Each persona has one workspaceId + one PipeClient (G6 honest-main: one identity per persona,
// only that value is stamped). S1 is implemented with direct PipeClient use — no persona.ts
// framework needed (design §9 delegated judgment).
//
// Concurrency (review follow-up — real flood): personas fire **concurrently** via Promise.all
// to actually contend on the channel mutex commit path. **Within** each persona, posts are
// sequential (next fire only after prior post commit confirmed) so per-persona send order is
// preserved — enabling per-persona monotonic seq column assertions. Global interleaving is
// nondeterministic but all assertions are set-based + continuity checks, safe under interleave.
//
// Execution model: RigDaemon.spawn (isolated env) → ready=daemon.ping → channel create/join →
// concurrent fire → full reconciliation → teardown. Fresh context per scenario (§2 — no state carryover).
//
// Determinism (G7): persona post counts and bodies are fixed **before** firing from seed (fire plan);
// on failure, print seed for reproduction (WMUX_RIG_SEED=<seed> for fixed replay).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PipeClient } from '../harness/pipe';
import {
  assertChannelSeq,
  assertTextsDelivered,
  assertUnread,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { SeededRng, pickSeed } from '../harness/seed';

/** Persona count (§4 S1: flood ×8). */
const PERSONA_COUNT = 8;
/** Per-persona post count range [min, max). Determined by seed. */
const MIN_POSTS = 3;
const MAX_POSTS = 10;

describe('SIM S1 — flood ×8: full delivery, contiguous seq, no duplicates', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  const clients: PipeClient[] = [];
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
  }, 120000); // Review follow-up: CI slow-runner headroom (informational lane — headroom prevents flakes)

  afterAll(async () => {
    // Order: close pipe sockets → daemon tree-kill (wait for exit) → delete temp home (§2).
    for (const c of clients) c.close();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('flood 8 personas firing concurrently deliver all messages with contiguous seq and no duplicates', async () => {
    // Always log seed on failure for reproduction (G7).
    // eslint-disable-next-line no-console
    console.log(`[S1] seed=${seed} (reproduce with WMUX_RIG_SEED=${seed})`);

    try {
      const rng = new SeededRng(seed);

      // Persona = one workspaceId + one PipeClient (G6). Deterministic names.
      const personas = Array.from({ length: PERSONA_COUNT }, (_, i) => {
        const ws = `ws-rig-s1-p${i}`;
        const client = new PipeClient(ctx.daemonPipePath, ctx.daemonTokenPath, ws);
        clients.push(client); // Register for socket close in afterAll.
        return { ws, client };
      });
      const creator = personas[0];

      // 1. Create channel (public). Creator is auto-added as first member (create seats creator).
      const created = await creator.client.channelRpc('a2a.channel.create', {
        name: 'rig-s1-flood',
        visibility: 'public',
        createdBy: { workspaceId: creator.ws, memberId: creator.ws },
      });
      const channel = created['channel'] as { id: string; nextSeq: number };
      const channelId = channel.id;
      expect(channelId, 'create must return channelId').toBeTruthy();
      // nextSeq=1 right after create → first post seq is 1 (full-reconciliation baseline).
      expect(channel.nextSeq, 'nextSeq=1 immediately after create').toBe(1);

      // 2. Remaining personas join (creator already member). Each stamps only own identity (G6).
      for (const p of personas.slice(1)) {
        await p.client.channelRpc('a2a.channel.join', {
          channelId,
          member: { workspaceId: p.ws, memberId: p.ws },
        });
      }

      // 3. Fix fire plan from seed **before** firing (persona iteration order is fixed → deterministic).
      //    Bodies are unique via (ws, k) — full reconciliation regardless of interleaving.
      const plan = personas.map((p) => ({ p, count: rng.int(MIN_POSTS, MAX_POSTS) }));
      const sentTexts = plan.flatMap(({ p, count }) =>
        Array.from({ length: count }, (_, k) => `s1|${p.ws}|#${k}`),
      );
      const totalPosts = sentTexts.length;

      // 4. Concurrent fire (review follow-up — real flood). Parallel across personas / sequential within.
      //    Post commit contract: RPC ok = after fsync commit (envelope PR3) → every ok'd post must
      //    appear in getMessages. Collect returned seq per persona for (i) global set reconciliation
      //    and (ii) per-persona order preservation.
      const perPersonaSeqs = await Promise.all(
        plan.map(async ({ p, count }) => {
          const seqs: number[] = [];
          for (let k = 0; k < count; k++) {
            const res = await p.client.channelRpc('a2a.channel.post', {
              channelId,
              sender: { workspaceId: p.ws, memberId: p.ws },
              text: `s1|${p.ws}|#${k}`,
            });
            const message = res['message'] as { seq: number } | undefined;
            expect(message, `post must return message (ws=${p.ws} k=${k})`).toBeTruthy();
            seqs.push(message!.seq);
          }
          return seqs;
        }),
      );
      const okSeqs = perPersonaSeqs.flat();
      // eslint-disable-next-line no-console
      console.log(`[S1] personas=${PERSONA_COUNT} totalPosts=${totalPosts} (concurrent flood)`);
      expect(totalPosts, 'at least MIN_POSTS per persona required').toBeGreaterThanOrEqual(
        PERSONA_COUNT * MIN_POSTS,
      );

      // Per-persona send order preserved: each persona's seq column must be monotonically increasing
      // (sequential fire within persona — k-th post commit confirmed before k+1 sent, so this
      //  relationship holds regardless of channel mutex interleaving).
      for (let i = 0; i < plan.length; i++) {
        const seqs = perPersonaSeqs[i];
        for (let j = 1; j < seqs.length; j++) {
          expect(
            seqs[j],
            `persona internal order preserved (ws=${plan[i].p.ws}, seqs=[${seqs.join(',')}])`,
          ).toBeGreaterThan(seqs[j - 1]);
        }
      }

      // 5. Full getMessages reconciliation (creator view; public channel floor=0 → full history).
      const fetched = await creator.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];

      // (a) Contiguous seq · no duplicates · exact count · starting seq=1.
      assertChannelSeq(messages, totalPosts, 1);
      // (b) Body multiset exact match (full delivery, no loss · no mutation).
      assertTextsDelivered(messages, sentTexts);
      // (c) ok seq set from posts == getMessages seq set (commit receipt matches canonical).
      const fetchedSeqs = messages.map((m) => m.seq).slice().sort((x, y) => x - y);
      const committedSeqs = okSeqs.slice().sort((x, y) => x - y);
      expect(fetchedSeqs, 'ok-received seq set must match getMessages seq set').toEqual(
        committedSeqs,
      );

      // 6. Unread consistency. Canonical formula (`unreadFor` `src/daemon/channels/ChannelService.ts:2343,
      //    :2349`): unread = count of messages where (seq > cursor AND seq >= historyFromSeq AND
      //    not self-authored). Self-authored exemption (:2349) and cursor auto-advance depend on
      //    interleaving, so hardcoding is brittle — recompute expected unread from canonical message
      //    list + daemon-reported cursor and compare.
      //
      //    Honest limit of this check (review follow-up): **formula self-consistency verification** —
      //    catches regressions in self-authored exemption and cursor inputs, but **cannot detect loss**.
      //    getMessages and unreadFor read the same `state.messages` array (post is single-array push),
      //    so if messages are lost both undercount equally and this check still passes. Loss detection
      //    is handled by step 5 client-ledger reconciliation (a)–(c) (expected count · contiguous seq ·
      //    body multiset · ok-seq set). Public channel → historyFromSeq=0.
      for (const p of personas) {
        const unread = await p.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === p.ws);
        expect(row, `unread entry must exist (ws=${p.ws})`).toBeTruthy();
        // (i) Head consistency.
        assertUnread(entries, channelId, p.ws, { headSeq: totalPosts });
        // (ii) Recompute expected unread from canonical list using daemon-reported cursor → compare
        //      (formula self-consistency — blind to loss; see comment above).
        const cursor = row!.lastReadSeq;
        const expectedUnread = messages.filter(
          (m) => m.seq > cursor && m.workspaceId !== p.ws,
        ).length;
        expect(row!.unread, `unread recalculation cross-check (ws=${p.ws}, cursor=${cursor})`).toBe(expectedUnread);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S1] FAILED with seed=${seed} — reproduce with WMUX_RIG_SEED=${seed}`);
      // eslint-disable-next-line no-console
      console.error(`[S1] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
