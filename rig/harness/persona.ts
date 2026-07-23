// Verification rig — persona framework (design §4 / G7)
//
// Seed-injected persona runner. Promotes what S1 did inline (identity assignment → join → behavior script →
// recording) into a **minimal** frame reused by S2~S8. No over-abstraction (CLAUDE.md
// "no abstraction for one-off code"): only what 6 persona types actually share —
//   (1) persona = { ws, client(PipeClient) } — G6 honest-main binding (one identity, stamp that value only).
//       Reserved identities already rejected by PipeClient constructor — no re-validation here.
//   (2) Channel create / all-members join orchestration (common prologue for every scenario).
//   (3) Seed wiring (expose SeededRng for scenarios that need it).
//   (4) Teardown convenience (all client.close()).
//
// **rng is S1 flood-only** (honest declaration — review minor): S1 flood firing uses seed to pick per-persona
// counts·bodies deterministically (rng actually consumed). **v1 SIM S2~S8 are all fixed loops, deterministic,
// and do not consume rng** — ping-pong rounds·dead/hung setup·no-ack counts·boundary edge values·SIGKILL timing
// are all constants. So `runner.rng` is exposed but S2~S8 do not use it, and those scenarios omit
// "reproducible via WMUX_RIG_SEED" wording (avoids false reproducibility signal). rng for load variation is follow-up work.
//
// **Behavior scripts are owned by each scenario** — flood firing·ping-pong exchange·dead exit·
// hung no-response·no-ack receive·boundary cap edge are completely different logic; enumerating
// "behavior types" here would be over-abstraction. Frame manages identity·channel·seed·lifetime only;
// scripts run in scenario files with persona (+ `runner.rng` when needed).
//
// What this frame does not do (honest declaration): RigSession (real PTY)·nudge assertions are out of v1 SIM
// scope (design §4 — S2·S4 redefinition). So no PTY hooks on persona.

import { PipeClient, type PipeClientOptions } from './pipe';
import { SeededRng } from './seed';
import type { RigContext } from './isolation';

/** One persona = one G6-bound identity + one PipeClient that sends only as that identity. */
export interface Persona {
  /** This persona's workspaceId (= memberId reused — single seat per persona). */
  readonly ws: string;
  /** Pipe client bound to this persona identity (channelRpc stamps ws only). */
  readonly client: PipeClient;
}

export interface PersonaRunnerOptions {
  /** Persona workspaceId prefix (scenario identification). e.g. 's2' → ws-rig-s2-p0. */
  readonly idPrefix: string;
  /** Seed for this run (rng seed — S1 flood only; S2~S8 fixed loops, unused). */
  readonly seed: number;
  /** PipeClient options (timeouts etc.) — shared by all personas. */
  readonly clientOpts?: PipeClientOptions;
}

/**
 * Persona runner — manages scenario common prologue (identity assignment·channel create·all join) and seed wiring.
 * Behavior scripts are owned by scenarios via `forEach`/direct loops (frame stays uninvolved).
 *
 * Typical usage (S2~S8 — all fixed loops, deterministic, rng not consumed):
 *   const runner = new PersonaRunner(ctx, { idPrefix: 's2', seed });
 *   const [a, b] = runner.spawn(2);
 *   const { channelId } = await runner.openChannel('rig-s2', a, [b]);
 *   // ... scenario-specific behavior (constant loop — rng is S1 flood-only) ...
 *   runner.closeAll();  // in afterAll
 */
export class PersonaRunner {
  private readonly ctx: RigContext;
  private readonly idPrefix: string;
  private readonly clientOpts?: PipeClientOptions;
  private readonly personas: Persona[] = [];
  /** Shared PRNG for scenarios that need it (v1: S1 flood only; S2~S8 unused). */
  readonly rng: SeededRng;

  constructor(ctx: RigContext, opts: PersonaRunnerOptions) {
    this.ctx = ctx;
    this.idPrefix = opts.idPrefix;
    this.clientOpts = opts.clientOpts;
    this.rng = new SeededRng(opts.seed);
  }

  /** Read-only snapshot of all personas spawned so far. */
  get all(): readonly Persona[] {
    return this.personas;
  }

  /**
   * Creates N personas (each: one identity + one PipeClient). workspaceId is deterministic
   * `ws-rig-{idPrefix}-p{index}` — index accumulates (no collision across multiple spawn calls).
   * Return array order == creation order.
   */
  spawn(count: number): Persona[] {
    const created: Persona[] = [];
    for (let i = 0; i < count; i++) {
      const index = this.personas.length;
      const ws = `ws-rig-${this.idPrefix}-p${index}`;
      const client = new PipeClient(
        this.ctx.daemonPipePath,
        this.ctx.daemonTokenPath,
        ws,
        this.clientOpts ?? {},
      );
      const persona: Persona = { ws, client };
      this.personas.push(persona);
      created.push(persona);
    }
    return created;
  }

  /**
   * Creates a shared channel (creator auto seat) and joins all other members. Common prologue for every
   * scenario. Each call stamps only its own identity (G6 — channelRpc enforces).
   *
   * Source-of-truth contract (`ChannelService.create`): right after create `channel.nextSeq === 1` (first post's
   * seq is 1). Creator automatically becomes first member (`ChannelService.create` seats creator).
   * join is not idempotent — do not put creator in members again.
   *
   * @param name     Channel name (unique within company — scenario prefix recommended).
   * @param creator  Persona creating channel (automatically first member).
   * @param members  Additional personas to join (excluding creator). Joined in order.
   * @returns { channelId, nextSeq } — nextSeq is post-create value (baseline for full comparison).
   */
  async openChannel(
    name: string,
    creator: Persona,
    members: Persona[] = [],
  ): Promise<{ channelId: string; nextSeq: number }> {
    const created = await creator.client.channelRpc('a2a.channel.create', {
      name,
      visibility: 'public',
      createdBy: { workspaceId: creator.ws, memberId: creator.ws },
    });
    const channel = created['channel'] as { id: string; nextSeq: number } | undefined;
    if (!channel || !channel.id) {
      throw new Error(`[rig/persona] openChannel: create returned no channel (name=${name})`);
    }
    for (const m of members) {
      await m.client.channelRpc('a2a.channel.join', {
        channelId: channel.id,
        member: { workspaceId: m.ws, memberId: m.ws },
      });
    }
    return { channelId: channel.id, nextSeq: channel.nextSeq };
  }

  /** Closes all persona sockets (teardown — call in afterAll before daemon kill). */
  closeAll(): void {
    for (const p of this.personas) p.client.close();
  }
}
