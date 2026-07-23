// Verification rig — SIM S8: A2A full lifecycle + EPERM chaos (design §4 scenario S8)
//
// Contract (v1.1 §4): A2A task full lifecycle at **wire level** —
//   (a) send→working→completed happy path + verifiedItemCount emission (§6.M PR-C).
//   (b) Completion evidence gate rejection (§6.M PR-B) → retry success with valid evidence.
//   (c) Idempotent resend (same idempotencyKey = same result without log append).
//   (d) **Idempotency-authz order** (EVIDENCE tier-1 target): non-participant knowing key still
//       blocked by authz first — cannot replay commit snapshot (#354 `2264c4a` — daemon-side guard).
//   + EPERM chaos (unix): socket chmod 000 → client failure isolation, daemon survival, recovery.
//
// Canonical coordinates:
//   - transition authz: `A2aTaskService.transition` `src/daemon/a2a/A2aTaskService.ts:312-334`
//     (only receiver workspace can transition → idempotency hit is **after** authz).
//   - VALID_TRANSITIONS: `src/shared/types.ts:655` (submitted→working→completed).
//   - Completion evidence gate: `src/shared/completionEvidence.ts:75` validateCompletionEvidence.
//
// ── A2A workspaceId convention (differs from channel verifiedWorkspaceId — why harness doesn't block) ──
// A2A task RPC (create/update/cancel/query) `workspaceId` is **caller-claimed identity validated by daemon authz**
// (`daemon/index.ts:1991` callerWorkspaceId=workspaceId → transition's
// `to.workspaceId !== callerWorkspaceId` gate). Fundamentally different from channel's `verifiedWorkspaceId`
// (transport server pin, channelRpc stamps). So this value is sent via rpc(); G6 harness hygiene **deliberately**
// does not block this field — S8's #354 authz test **requires non-participant ws impersonation**
// (if harness blocked it, authz test itself would be impossible). Personas use only their own ws by convention,
// but `#354` test intentionally impersonates outsider ws.
//
// Execution model: RigDaemon.spawn → two personas (from/to) → lifecycle 4 stages → EPERM chaos.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import { assertTaskState, type RigTask } from '../harness/assert';
import { pickSeed } from '../harness/seed';

/** One valid completion evidence (minimal form passing completed gate — one command passed). */
const validEvidence = (summary: string) => ({
  summary,
  items: [{ kind: 'command' as const, status: 'passed' as const, summary, command: 'echo ok' }],
});

describe('SIM S8 — A2A full lifecycle + EPERM chaos', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  let runner: PersonaRunner;
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
    // Create runner in beforeAll — each it draws **new personas** via runner.spawn() (auto-incrementing
    // index, task id unique via prefix) so tests are independent, and `-t` single-run always has runner
    // ready (removes test-order coupling).
    runner = new PersonaRunner(ctx, { idPrefix: 's8', seed });
  }, 120000);

  afterAll(async () => {
    runner?.closeAll();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('send→working→completed happy path + verifiedItemCount emission', async () => {
    // Fixed sequence so deterministic (no rng) — seed only used as PersonaRunner rng seed
    // and this scenario body does not consume it. No seed reproduction wording (avoids false signal).
    try {
      const [from, to] = runner.spawn(2);
      const taskId = `rig-s8-happy-${ctx.runId}`;

      // create (from→to). task.create/update use explicit from/to/workspaceId fields not identity stamps,
      // so sent via rpc() (G6 hygiene: from/to.workspaceId are identity-class keys but not reserved identity,
      // and not verifiedWorkspaceId smuggling, so pass).
      const created = (await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 happy path',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      })) as { ok?: boolean; taskId?: string };
      expect(created.ok, 'create ok').toBe(true);
      expect(created.taskId, 'create returns taskId').toBe(taskId);

      // submitted→working (receiver to's authz).
      const working = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'working',
      })) as { ok?: boolean };
      expect(working.ok, 'working transition ok').toBe(true);

      // working→completed (valid evidence → gate pass + verifiedItemCount=1).
      const completed = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 verified'),
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(completed.ok, 'completed transition ok').toBe(true);
      expect(completed.verifiedItemCount, 'verifiedItemCount=1 (command passed)').toBe(1);

      // query confirms canonical state (completed).
      const q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as {
        tasks?: RigTask[];
      };
      assertTaskState(q.tasks ?? [], taskId, 'completed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-happy] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  it('completion evidence gate rejection → retry succeeds with valid evidence', async () => {
    try {
      const [from, to] = runner.spawn(2);
      const taskId = `rig-s8-gate-${ctx.runId}`;
      await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 gate',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      });
      await to.client.rpc('a2a.task.update', { taskId, workspaceId: to.ws, status: 'working' });

      // completed with no evidence → gate rejection (completion_evidence_missing). no append.
      const rejected = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
      })) as { ok?: boolean; error?: string };
      expect(rejected.ok, 'completed without evidence is rejected').toBe(false);
      expect(String(rejected.error), 'canonical reason code completion_evidence_missing').toMatch(
        /completion_evidence_missing/,
      );

      // State still working (rejection doesn't change state — no append).
      let q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as { tasks?: RigTask[] };
      assertTaskState(q.tasks ?? [], taskId, 'working');

      // Retry with valid evidence → success.
      const retried = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 gate retry'),
      })) as { ok?: boolean };
      expect(retried.ok, 'retry with valid evidence succeeds').toBe(true);
      q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as { tasks?: RigTask[] };
      assertTaskState(q.tasks ?? [], taskId, 'completed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-gate] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  it('idempotent resend: same idempotencyKey returns same result without log append', async () => {
    try {
      const [from, to] = runner.spawn(2);
      const taskId = `rig-s8-idem-${ctx.runId}`;
      await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 idem',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      });
      await to.client.rpc('a2a.task.update', { taskId, workspaceId: to.ws, status: 'working' });

      const key = 'idem-key-s8';
      // 1st completed with key.
      const first = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 idem done'),
        idempotencyKey: key,
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(first.ok, 'first completed ok').toBe(true);

      // 2nd resend with same key → idempotency hit (same result without log append). completed is terminal so
      // normal resend would be invalid transition (completed→completed), but idempotency hit is
      // **before** validateTransition (2264c4a placement) so terminal retry absorbed into original result.
      const second = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 idem done'),
        idempotencyKey: key,
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(second.ok, 'idempotent resend ok (absorbs original result)').toBe(true);
      expect(second.verifiedItemCount, 'idempotent resend returns original verifiedItemCount').toBe(
        first.verifiedItemCount,
      );

      // State stable as single completed (no duplicate transition).
      const q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as {
        tasks?: RigTask[];
      };
      assertTaskState(q.tasks ?? [], taskId, 'completed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-idem] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  // ── EVIDENCE tier-1 target: idempotency-authz order (#354 `2264c4a`) ─────────────────────
  // This test is the red/green verdict point for revert reproduction (rig/EVIDENCE.md). main (after fix):
  // non-participant knowing key still blocked by authz first. revert (fix removed): idempotency hit
  // beats authz and replays commit snapshot → non-participant gets task state (authz bypass).
  it('idempotency-authz order: non-participant cannot replay commit snapshot even with key (#354)', async () => {
    try {
      const [from, to, outsider] = runner.spawn(3);
      const taskId = `rig-s8-authz-${ctx.runId}`;
      const sharedKey = 'shared-transition-key';

      await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 authz order',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      });
      // Receiver to legitimately transitions to working (plants idempotency record with sharedKey).
      const legit = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'working',
        idempotencyKey: sharedKey,
      })) as { ok?: boolean };
      expect(legit.ok, 'receiver legitimate transition ok').toBe(true);

      // Non-participant (outsider) attempts transition with **same taskId + same key**. main (fix) should
      // reject with authz first "is not the receiver" — if idempotency hit beats authz (revert), outsider
      // replays committed working snapshot (TransitionOk).
      const attack = (await outsider.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: outsider.ws, // non-participant identity.
        status: 'working',
        idempotencyKey: sharedKey,
      })) as { ok?: boolean; error?: string; task?: unknown };
      // main green condition: rejection + authz reason. (revert gives ok:true + task snapshot leak → red.)
      expect(attack.ok, 'non-participant transition must be rejected (idempotency must not beat authz)').toBe(false);
      expect(String(attack.error), 'authz rejection reason (is not the receiver)').toMatch(/is not the receiver/);
      expect(attack.task, 'non-participant must not receive task snapshot').toBeUndefined();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-authz] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  // ── EPERM chaos (unix only) — design G8 ──────────────────────────────────────
  // Daemon socket file chmod 000 → new connections fail with EACCES/EPERM (client failure
  // isolation). Daemon process must stay alive (socket permission strip ≠ daemon death), and
  // restoring permissions must allow reconnect and operation (recovery). win32 uses named pipe so no file chmod, skip.
  //
  // **root (uid 0) skip** (review MAJOR — Claude): root bypasses all DAC permission bits so
  // chmod 000 socket still connects → `denied` becomes null silently invalidating detection
  // (false-fail). CI SIM lane Linux containers often run as root so must skip.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const runEperm = process.platform !== 'win32' && !isRoot;
  if (isRoot) {
    // eslint-disable-next-line no-console
    console.log('[S8-eperm] EPERM chaos skipped under root — chmod bypassed by uid 0');
  }
  (runEperm ? it : it.skip)('EPERM chaos: socket chmod 000 → client isolation, daemon survival, recovery', async () => {
    try {
      const sockPath = ctx.daemonPipePath;
      // Pre-chaos: confirm normal connection. Also record pid (must match post-chaos = no restart).
      const probe = runner.spawn(1)[0];
      const before = (await probe.client.rpc('daemon.ping', {})) as { status?: string };
      expect(before.status, 'daemon responds before chaos').toBe('ok');
      const pidBefore = daemon.pid;
      expect(pidBefore, 'daemon pid exists before chaos').toBeDefined();

      // Save original permissions then strip socket permissions.
      const orig = fs.statSync(sockPath).mode;
      fs.chmodSync(sockPath, 0o000);
      try {
        // Attempt new connection with **fresh persona that never connected** — already-connected
        // sockets unaffected by chmod (permissions checked at connect time) so must be new client.
        // chmod 000 so connect fails with EACCES/EPERM (client-level isolated failure — daemon survives).
        const blocked = runner.spawn(1)[0];
        const denied = await blocked.client.rpc('daemon.ping', {}).then(
          () => null,
          (e: Error) => e,
        );
        expect(denied, 'new connection to chmod 000 socket must fail').toBeTruthy();
        expect(String(denied), 'isolated connection failure EACCES/EPERM').toMatch(/EACCES|EPERM/i);
      } finally {
        // Restore permissions (finally — restore even on assertion failure so daemon teardown isn't blocked).
        fs.chmodSync(sockPath, orig);
      }

      // Daemon survival + recovery: after permission restore, fresh client must respond again (daemon
      // stayed alive throughout chmod — socket permission strip doesn't kill process).
      const recovered = runner.spawn(1)[0];
      const after = (await recovered.client.rpc('daemon.ping', {})) as { status?: string };
      expect(after.status, 'daemon responds after permission restore (survival+recovery)').toBe('ok');
      // Daemon pid same pre/post chaos (no restart — stayed alive).
      expect(daemon.pid, 'same pid before/after EPERM chaos (daemon survival)').toBe(pidBefore);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-eperm] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
