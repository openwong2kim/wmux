// Verification rig — SIM S7: daemon SIGKILL→respawn during flood (design §4 scenario S7, v1.1 redefinition)
//
// Contract (v1.1 §4 — **one-way subset only**): SIGKILL daemon during flood, respawn with same suffix,
// then {message seq confirmed committed via RPC ok} ⊆ {getMessages seq after replay}.
// Asserts **lossless confirmed commits only** (§6.L envelope proof).
//
// **Uncommitted non-resurrection not assertable** (review P4 — Claude c/80, footgun 9): AppendOnlyLog
// at-least-once valid-tail promotion contract (`src/daemon/eventlog/AppendOnlyLog.ts:13-15,:254-269`)
// — physically written uncommitted data just before fsync barrier may legitimately promote on boot scan.
// Asserting "replay ⊆ committed" (uncommitted stays dead) fails normal behavior.
// We pin only committed ⊆ replay (assertReplaySuperset — one-way).
//
// **ack excluded from commit evidence** (footgun 11 — Codex M12): ack can be no-op ok without flip
// (`ChannelService.ts:2185` area) so "ok=commit" doesn't hold. S7 commit ledger is post ok seq only.
// ack effect verification is outside this scenario.
//
// **No graceful vs SIGKILL confusion** (footgun 10): graceful close confirms all pending false
// (separate contract, E2E-3 scope). S7 is SIGKILL so tail promotion possible — different contract.
//
// Execution model: channel open → 1st flood (collect each post ok seq=confirmed commit) → **daemon SIGKILL**
// → respawn (disk state restore) → getMessages for replay → committed ⊆ replay assert.
// + verify channel still works after respawn (2nd post).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import { assertReplaySuperset, type RigChannelMessage, type RigUnreadEntry } from '../harness/assert';
import { pickSeed } from '../harness/seed';

/** 1st flood post count (ledger definitely committed before SIGKILL). */
const FLOOD_POSTS = 20;

describe('SIM S7 — SIGKILL→respawn during flood: lossless confirmed commits (one-way subset)', () => {
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

  it('after SIGKILL respawn, all RPC-ok-confirmed messages survive replay', async () => {
    // Fixed loop so deterministic (no rng) — seed only used as PersonaRunner rng seed
    // and this scenario body does not consume it. No seed reproduction wording (avoids false signal).
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's7', seed });
      const [poster, reader] = runner.spawn(2);
      const { channelId, nextSeq } = await runner.openChannel('rig-s7-replay', poster, [reader]);
      expect(nextSeq, 'nextSeq=1 right after create').toBe(1);

      // 1. 1st flood — collect each post ok return seq. ok = after fsync commit (envelope PR3)
      //    so these seqs are "definitely committed" ledger. Sequential fire (next after commit confirmed).
      const committedSeqs: number[] = [];
      for (let k = 0; k < FLOOD_POSTS; k++) {
        const res = await poster.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: poster.ws, memberId: poster.ws },
          text: `s7|${poster.ws}|#${k}`,
        });
        const seq = (res['message'] as { seq: number }).seq;
        committedSeqs.push(seq);
      }
      expect(committedSeqs.length, 'first flood all ok').toBe(FLOOD_POSTS);

      // 1b. reader acks all (member scope — cursor advance). ack is **not counted as commit evidence**
      //     (footgun 11 · Codex M12: ack can be no-op ok without flip so "ok=log commit" doesn't hold).
      //     Instead verify cursor survival via **unread query** after respawn (if alive, unread decreases).
      await reader.client.channelRpc('a2a.channel.ack', {
        channelId,
        uptoSeq: FLOOD_POSTS,
        memberId: reader.ws,
      });
      // eslint-disable-next-line no-console
      console.log(`[S7] committed ${committedSeqs.length} posts + reader ack, pid=${daemon.pid} → SIGKILL`);

      // 2. Daemon tree SIGKILL (chaos injection) — wait until exit reclaimed. Immediate termination
      //    regardless of commit barrier (RigDaemon.kill preserves SIGKILL semantics).
      const killedPid = daemon.pid;
      await daemon.kill();
      expect(daemon.pid, 'no pid after kill').toBeUndefined();

      // 3. Respawn with same suffix — daemon restores state from event log in temp home
      //    (§6.L replay). respawn waits until ready (daemon.ping).
      await daemon.respawn();
      expect(daemon.pid, 'new pid exists after respawn').toBeDefined();
      expect(daemon.pid, 'respawn is a new process').not.toBe(killedPid);

      // 4. Collect replay results — socket must reopen after respawn so reader client
      //    reconnects lazily (PipeClient reconnects dropped socket on next call). getMessages reads
      //    full restored ledger.
      const fetched = await reader.client.channelRpc('a2a.channel.getMessages', { channelId });
      const replayed = (fetched['messages'] ?? []) as RigChannelMessage[];
      const replayedSeqs = replayed.map((m) => m.seq);
      // eslint-disable-next-line no-console
      console.log(`[S7] replayed ${replayedSeqs.length} messages after respawn`);

      // 5. **One-way subset**: all confirmed commit seqs must appear in replay results
      //    (committed ⊆ replayed). Reverse direction (replay ⊆ committed) not asserted due to
      //    at-least-once tail promotion contract (footgun 9).
      assertReplaySuperset(committedSeqs, replayedSeqs, 's7-post-seqs');

      // 5b. ack effect verified **via unread only** (separate from post seq commit evidence — footgun 11:
      //     receipt-only ack can be no-op ok without flip so not countable as commit evidence). But ack in
      //     step 3 is **member-scoped** (memberId specified — line 78-81) so cursor actually advances —
      //     a **commit**: cursorFlips trigger commitAndApply (append-then-barrier)
      //     (`ChannelService.ack` :2185-2208) so its ok is **durable after barrier**. Therefore hard-asserting
      //     this cursor's replay survival is justified (different contract from no-op receipt ack's no guarantee
      //     — member-scoped cursor commit has same durability as post). Verify reader's lastReadSeq survives
      //     SIGKILL at or beyond acked point.
      const readerUnread = await reader.client.channelRpc('a2a.channel.unread', {});
      const readerEntries = (readerUnread['entries'] ?? []) as RigUnreadEntry[];
      const readerRow = readerEntries.find(
        (e) => e.channelId === channelId && e.memberId === reader.ws,
      );
      expect(readerRow, 'reader unread entry exists after respawn (membership restored)').toBeTruthy();
      // Cursor survives replay → read point (lastReadSeq) at or beyond acked seq.
      expect(
        readerRow!.lastReadSeq,
        'reader cursor durably survives respawn (ack survives replay)',
      ).toBeGreaterThanOrEqual(Math.min(FLOOD_POSTS, Math.max(...replayedSeqs)));

      // 6. Channel still works after respawn (continues writing above restored nextSeq). New post
      //    seq must exceed max replayed seq (seq ledger continuity survives restart).
      const maxReplayed = replayedSeqs.length > 0 ? Math.max(...replayedSeqs) : 0;
      const after = await poster.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: poster.ws, memberId: poster.ws },
        text: 's7|post-respawn',
      });
      const afterSeq = (after['message'] as { seq: number }).seq;
      expect(afterSeq, 'post seq after respawn exceeds max replayed seq (ledger continuity)').toBeGreaterThan(
        maxReplayed,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S7] FAILED (deterministic fixed-loop scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S7] --- daemon log tail ---\n${daemon.log.slice(-3000)}`);
      throw err;
    }
  }, 90000);
});
