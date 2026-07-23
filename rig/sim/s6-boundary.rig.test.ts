// Verification rig — SIM S6: boundary (design §4 scenario S6)
//
// Contract (§4): cap boundary accept/reject accuracy at **wire level** (boundary±1). Catches off-by-one regressions.
//
// Target caps (canonical):
//   - Channel body: CHANNEL_BODY_MAX=8192 (`src/shared/channels.ts:371`) → on exceed
//     CHANNEL_BODY_TOO_LARGE (`ChannelService.post` :1660-1667). Measured by length after
//     sanitization (`sanitizePostText` :2589 — C0 strip + trim) so pure ASCII preserves length.
//   - Mention count: CHANNEL_MENTIONS_MAX=64 (`:386`) → CHANNEL_MENTIONS_TOO_MANY (:1702-1710).
//     This cap fires **before** membership validation/drop (:1698 "Reject BEFORE allocating a seq")
//     — so mention targets need not be real members (synthetic ws suffices). This property lets S6
//     hit the cap with 1 socket (sender alone), avoiding daemon connection-rate cap — see comment below.
//   - Completion evidence E12: item string cap EVIDENCE_MAX_STR_BYTES=4096 bytes
//     (`src/shared/completionEvidence.ts:15,:58-59`) → completion_evidence_too_large (:93).
//
// **Why single sender** (harness decision fixed without review): DaemonPipeServer caps
// new connections at MAX_NEW_CONNECTIONS_PER_SEC=20 (`DaemonPipeServer.ts:57,:251-252`).
// Hitting mention cap with 64 real members needs ~64 sockets opened in ~1s, exceeding this cap and
// daemon drops connections ("connection lost"). Since mention cap fires before membership, loading 65
// synthetic ws mentions verifies the same contract on the wire with 1 socket (real cap, not backdoor).
//
// Channel caps: channelRpc promotes result.ok===false to throw → rejections use rejects, acceptances return normally.
// A2A evidence cap: judged directly via {ok,error} in rpc() payload.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import { pickSeed } from '../harness/seed';

// Canonical cap values (fixed literals — if canonical changes, this test goes red forcing update).
const CHANNEL_BODY_MAX = 8192; // src/shared/channels.ts:371
const CHANNEL_MENTIONS_MAX = 64; // src/shared/channels.ts:386
const EVIDENCE_MAX_ITEMS = 64; // src/shared/completionEvidence.ts:14 (E12)
const EVIDENCE_MAX_STR_BYTES = 4 * 1024; // src/shared/completionEvidence.ts:15 — per item string

describe('SIM S6 — boundary: cap edge accept/reject accuracy (wire level)', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  let runner: PersonaRunner;
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
    runner = new PersonaRunner(ctx, { idPrefix: 's6', seed });
  }, 120000);

  afterAll(async () => {
    runner?.closeAll();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('body·mention caps: boundary values accepted, +1 rejected with canonical reason code', async () => {
    // Fixed boundary scenario so deterministic (no rng) — seed only used as PersonaRunner rng seed
    // and this scenario body does not consume it. No seed reproduction wording (avoids false signal).
    try {
      // sender alone — mention cap fires before membership so real members unnecessary (see header comment).
      const [sender] = runner.spawn(1);
      const { channelId } = await runner.openChannel('rig-s6-boundary', sender);

      // 1. Body cap: exactly 8192 bytes (pure ASCII 1B/char, length unchanged by sanitization) accepted.
      const atLimit = 'a'.repeat(CHANNEL_BODY_MAX);
      const okRes = await sender.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: sender.ws, memberId: sender.ws },
        text: atLimit,
      });
      expect((okRes['message'] as { text: string }).text.length, 'boundary body accepted(8192)').toBe(
        CHANNEL_BODY_MAX,
      );

      // Body +1 (8193) rejected with CHANNEL_BODY_TOO_LARGE.
      const overBody = 'a'.repeat(CHANNEL_BODY_MAX + 1);
      const bodyErr = await sender.client
        .channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: sender.ws, memberId: sender.ws },
          text: overBody,
        })
        .then(() => null, (e: Error) => e);
      expect(bodyErr, 'body +1 rejected').toBeTruthy();
      expect(String(bodyErr), 'canonical reason code CHANNEL_BODY_TOO_LARGE').toMatch(
        /CHANNEL_BODY_TOO_LARGE/,
      );

      // 2. Mention cap: exactly 64 mentions (synthetic ws — cap before membership so values irrelevant) accepted.
      //    non-member so all echoed as droppedMentions but **post itself succeeds** (under cap).
      const mkMentions = (n: number): Array<{ workspaceId: string; name: string }> =>
        Array.from({ length: n }, (_, i) => ({ workspaceId: `ws-rig-s6-m${i}`, name: `m${i}` }));

      const okMentions = await sender.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: sender.ws, memberId: sender.ws },
        text: 's6|mentions-at-cap',
        mentions: mkMentions(CHANNEL_MENTIONS_MAX),
      });
      expect((okMentions['message'] as { seq: number }).seq, 'boundary mentions accepted(64)').toBeGreaterThan(0);

      // Mention +1 (65) rejected with CHANNEL_MENTIONS_TOO_MANY (cap before membership/drop).
      const mentionErr = await sender.client
        .channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: sender.ws, memberId: sender.ws },
          text: 's6|mentions-over-cap',
          mentions: mkMentions(CHANNEL_MENTIONS_MAX + 1),
        })
        .then(() => null, (e: Error) => e);
      expect(mentionErr, 'mention +1 rejected').toBeTruthy();
      expect(String(mentionErr), 'canonical reason code CHANNEL_MENTIONS_TOO_MANY').toMatch(
        /CHANNEL_MENTIONS_TOO_MANY/,
      );

      // Daemon survival (cap rejections don't destabilize daemon — rejections don't consume seq either). daemon.ping
      // handler returns `{ status: 'ok', ... }` (`src/daemon/index.ts:1548`).
      const ping = (await sender.client.rpc('daemon.ping', {})) as { status?: string };
      expect(ping.status, 'after cap rejection daemon alive').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S6] FAILED (deterministic fixed-boundary scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S6] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  it('completion evidence cap (E12): oversized item string rejected as completion_evidence_too_large, boundary accepted', async () => {
    try {
      const [from, to] = runner.spawn(2);

      // Task create (from→to) → working → completed. id deterministic (unique via runId).
      const taskId = `rig-s6-evidence-${ctx.runId}`;
      const created = (await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's6 evidence cap',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      })) as { ok?: boolean; taskId?: string };
      expect(created.ok, 'task.create ok').toBe(true);

      // to transitions to working with receiver authz (normal — non-terminal so evidence gate not in scope).
      const working = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'working',
      })) as { ok?: boolean };
      expect(working.ok, 'working transition ok').toBe(true);

      // completed attempt with item summary EVIDENCE_MAX_STR_BYTES+1 bytes → per-string cap
      // exceeded. wire normalize only checks total bytes (64KiB) so this single ~4KiB string passes normalize,
      // and authoritative gate withinCaps per-string cap (`completionEvidence.ts:58-59`) rejects with
      // completion_evidence_too_large (E12 — gate path that emits too_large).
      const oversizeSummary = 'x'.repeat(EVIDENCE_MAX_STR_BYTES + 1);
      const rejected = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: {
          summary: 's6 done',
          items: [{ kind: 'command', status: 'passed', summary: oversizeSummary, command: 'echo x' }],
        },
      })) as { ok?: boolean; error?: string };
      expect(rejected.ok, 'oversized string evidence rejected').toBe(false);
      expect(String(rejected.error), 'canonical reason code completion_evidence_too_large').toMatch(
        /completion_evidence_too_large/,
      );

      // items count boundary +1: EVIDENCE_MAX_ITEMS+1 (65) rejected. All well-formed but items
      // count cap exceeded. **Rejection reason is completion_evidence_malformed** (not too_large):
      // transition path runs wire normalize (`normalizeCompletionEvidenceWire`) **before** authoritative gate,
      // and normalize self-checks items count cap (`completionEvidence.ts:155`
      // — `v.items.length > EVIDENCE_MAX_ITEMS` returns null) rejecting as malformed before gate
      // (`A2aTaskService.ts:353-359`). So items cap enforced at wire level; this case catches regression
      // if that enforcement disappears (normalize items cap removed). (String cap contrast: normalize only
      // checks total bytes so single 4KiB passes → gate withinCaps rejects too_large — two boundaries
      // enforced at different layers.)
      const overItems = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, (_, i) => ({
        kind: 'command' as const,
        status: 'passed' as const,
        summary: `c${i}`,
        command: `e${i}`,
      }));
      const rejectedItems = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: { summary: 's6 done', items: overItems },
      })) as { ok?: boolean; error?: string };
      expect(rejectedItems.ok, `items=${EVIDENCE_MAX_ITEMS + 1} rejected`).toBe(false);
      expect(
        String(rejectedItems.error),
        'canonical reason code completion_evidence_malformed (wire normalize items cap)',
      ).toMatch(/completion_evidence_malformed/);

      // Boundary acceptance: EVIDENCE_MAX_ITEMS (small strings, under cap) completes successfully — hits both
      // count and string boundaries (each string under cap).
      const atCapItems = Array.from({ length: EVIDENCE_MAX_ITEMS }, (_, i) => ({
        kind: 'command' as const,
        status: 'passed' as const,
        summary: `c${i}`,
        command: `e${i}`,
      }));
      const accepted = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: { summary: 's6 done', items: atCapItems },
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(accepted.ok, 'evidence boundary accepted(completed, items=64)').toBe(true);
      expect(accepted.verifiedItemCount, 'verifiedItemCount = all items passed').toBe(EVIDENCE_MAX_ITEMS);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S6-evidence] FAILED with seed=${seed}`);
      // eslint-disable-next-line no-console
      console.error(`[S6-evidence] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
