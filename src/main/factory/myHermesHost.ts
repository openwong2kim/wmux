// ─── My Hermes host — a bot on the owner's own Hermes profile ──────────────
//
// The own-mode counterpart of hermesHost.ts (wmux's managed Hermes). One host
// per Hermes profile (`getOwnHermesHost`), bound to the profile's folder
// (`~/.hermes` or `~/.hermes/profiles/<name>`). It never writes the profile
// and never stops its gateway: the owner's Hermes is the owner's. So there is
// no settings write (`applyHermesSettings`), no gateway restart before a spawn
// (`ensureOwnGateway`), and no gateway stop when a turn does not settle or the
// app quits; a turn is ended with ACP `session/cancel` and the bot stays
// blocked until Hermes says the turn ended (AcpBrainAdapter own mode), at most
// the adapter's cancel bound: past it wmux lets go of the `hermes acp` process
// it spawned for the bot, and the owner is told in the bot's 1:1 chat.
//
// Right before every agent spawn (`prepare`) all of these must hold:
// - the read-only readiness (myHermes.ts) answers ready, fresh: the install
//   is the profile's own, the version is in range, a model is set, approvals
//   are not off, no wmux MCP server is configured, and no messaging platform
//   would start (the profile's config and its .env NAMES);
// - no other bot is bound to the profile (the store refuses a second bind;
//   this catches a copied or hand-edited bots.json);
// - a gateway already running for the profile was not started with
//   `--yolo`, `--safe-mode` or `ignore_user_config` (attaching would hand the
//   bot that gateway's mode).
// After a session starts, the gateway's live platforms are checked again
// (gateway_state.json), as the managed host does.

import type { BotBinding } from '../../shared/bot';
import { HERMES_PROFILE_RE } from '../../shared/bot';
import { dmThreadId } from '../../shared/room';
import type { AcpBrainAdapter, AcpHermesPolicy } from '../deck/AcpBrainAdapter';
import { waitForCommanderTokenUse } from '../deck/commanderTrust';
import { getApprovalService, type ApprovalService } from './approvals';
import { runningWakeAttended } from './wakeTaint';
import { hermesEnv, hermesNotReadyMessage, readHermesGatewayState, type HermesGatewayState } from './hermesEngine';
import { defaultMyHermesDeps, myHermesProfileDir, myHermesReadiness, type MyHermesReadinessDeps } from './myHermes';
import { HERMES_PERMISSION_TIMEOUT_MS } from './hermesHost';
import { getBotStore } from './botStore';
import { noticeBot, type BotNoticePorts } from './botNotices';
import { getFactLog } from './factLog';
import { getWakeQueue } from './wakeQueue';

/** How long a new session's MCP child may take to call main. */
const MCP_READY_MS = 15_000;

/** The wmux tool a bot on My Hermes holds (its only wmux MCP tool). */
export const OWN_HERMES_WMUX_TOOL = 'room_post';

/** The room card of a cancelled turn that did not end within the adapter's
 *  bound (the English title; `turn.unsettled` words it in the reader's
 *  language). */
export const OWN_HERMES_UNSETTLED_TITLE = 'My Hermes did not stop the last turn cleanly, so wmux closed its connection to Hermes. Your next message reconnects, in a new conversation if this one cannot resume.';

/** Gateway launch flags that change what a bot attached to it may do. */
const GATEWAY_MODE_FLAGS = new Set(['yolo', 'safe_mode', 'ignore_user_config']);

/** The flags of `argv` that refuse an attach (`--yolo`, `--safe-mode`,
 *  `ignore_user_config` in any spelling). Pure. */
export function gatewayModeFlags(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    const name = arg.replace(/^-+/, '').split('=', 1)[0].replace(/-/g, '_').toLowerCase();
    if (GATEWAY_MODE_FLAGS.has(name) || /ignore[_-]user[_-]config/i.test(arg)) out.push(arg);
  }
  return out;
}

/** Whether a bot on My Hermes may hold the tool `name`: every tool of the
 *  owner's Hermes (its own tool set and approvals are the stated trust
 *  level), but of wmux's MCP tools only `room_post`. Pure. */
export function ownHermesToolAllowed(name: string): boolean {
  const m = /^mcp__editor_wmux_[a-z0-9]+__([A-Za-z0-9_]+)$/.exec(name);
  if (m) return m[1] === OWN_HERMES_WMUX_TOOL;
  return !/^mcp__editor_wmux/.test(name);
}

export interface OwnHermesHostDeps {
  profile: string;
  /** The read-only checks' inputs (default: the real home, PATH, runner). */
  readinessDeps?: () => MyHermesReadinessDeps;
  /** The bot other than `botId` bound to the profile, or null (default: the
   *  bot store's). */
  holder?: (profile: string, botId: string) => { id: string; name: string } | null;
  pidAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
  /** Whether the bot's running wake is attended (default: wakeTaint.ts
   *  runningWakeAttended). */
  attended?: (botId: string) => boolean;
  /** The approval store (default: getApprovalService). */
  approvals?: () => Pick<ApprovalService, 'askNativeTool'> | null;
  /** Tell the owner in the bot's 1:1 chat that its cancelled turn did not
   *  end in time (default: noteOwnHermesUnsettled). */
  unsettledNotice?: (binding: BotBinding) => void;
}

/** The owner's card for a bot on My Hermes whose cancelled turn did not end
 *  in time, in its 1:1 chat. */
export function noteOwnHermesUnsettled(
  binding: BotBinding,
  ports: BotNoticePorts = { factLog: getFactLog, wakes: getWakeQueue },
  botExists: (botId: string) => boolean = (id) => !!getBotStore()?.get(id),
): void {
  // A bot deleted meanwhile has no chat to tell.
  if (!botExists(binding.botId)) return;
  noticeBot(ports, {
    // A wake would be refused (no owner words): the card is the owner's.
    quiet: true,
    card: true,
    botId: binding.botId,
    workspaceId: binding.workspaceId,
    key: `my-hermes-unsettled:${binding.botId}:${Date.now()}`,
    topic: 'turn.unsettled',
    title: OWN_HERMES_UNSETTLED_TITLE,
    threadId: dmThreadId(binding.botId),
    notice: { code: 'turn.unsettled' },
  });
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultHolder(profile: string, botId: string): { id: string; name: string } | null {
  return getBotStore()?.ownHermesHolder(profile, botId) ?? null;
}

export class OwnHermesHost {
  private readonly adapters = new Set<AcpBrainAdapter>();
  private readonly log: (line: string) => void;
  private readonly pidAlive: (pid: number) => boolean;
  private stopping: Promise<void> | null = null;
  /** The profile's turn gate: a new session of its bot waits for the last
   *  turn of the one before (one bot per profile). */
  private readonly turnGate: { ended: Promise<void> | null } = { ended: null };

  constructor(private readonly deps: OwnHermesHostDeps) {
    if (!HERMES_PROFILE_RE.test(deps.profile)) throw new Error('not a Hermes profile name');
    this.log = deps.log ?? ((l) => console.log(l));
    this.pidAlive = deps.pidAlive ?? defaultPidAlive;
  }

  get profile(): string {
    return this.deps.profile;
  }

  private readiness(): MyHermesReadinessDeps {
    return (this.deps.readinessDeps ?? defaultMyHermesDeps)();
  }

  /** The profile's folder. */
  root(): string {
    return myHermesProfileDir(this.readiness().home, this.deps.profile);
  }

  /** The gateway already running for the profile, when one is. */
  private liveGateway(): HermesGatewayState | null {
    const state = readHermesGatewayState(this.root());
    return state && this.pidAlive(state.pid) ? state : null;
  }

  /** Every start condition, checked right before a spawn: null and the
   *  spawn's exe/env/args when they all hold, else why not. */
  async prepareSpawn(botId: string): Promise<{ ok: true; exe: string; env: Record<string, string>; args: string[] } | { ok: false; message: string }> {
    const deps = this.readiness();
    const r = await myHermesReadiness(this.deps.profile, deps);
    if (!r.ready) return { ok: false, message: hermesNotReadyMessage({ ready: false, reason: 'config-mismatch', message: r.message ?? r.reason ?? 'unknown reason' }) };
    const holder = (this.deps.holder ?? defaultHolder)(this.deps.profile, botId);
    if (holder) return { ok: false, message: hermesNotReadyMessage({ ready: false, reason: 'config-mismatch', message: `${holder.name} already uses this Hermes profile; one bot can use a Hermes profile at a time.` }) };
    const gateway = this.liveGateway();
    const flags = gateway ? gatewayModeFlags(gateway.argv) : [];
    if (flags.length > 0) {
      return { ok: false, message: hermesNotReadyMessage({ ready: false, reason: 'config-mismatch', message: `its running gateway was started with ${flags.slice(0, 3).join(', ')}; stop it and start it without that to use it in wmux.` }) };
    }
    const exe = deps.resolveExe();
    if (!exe) return { ok: false, message: hermesNotReadyMessage({ ready: false, reason: 'not-installed', message: 'Hermes is not installed (no hermes executable found).' }) };
    const dir = this.root();
    return { ok: true, exe, env: hermesEnv(dir, deps.baseEnv ?? process.env, deps.platform, deps.home), args: ['-p', this.deps.profile, 'acp'] };
  }

  /** The policy of one bot's adapter in own mode. */
  policyFor(binding: BotBinding): AcpHermesPolicy {
    return {
      mode: 'own',
      prepare: () => this.prepareSpawn(binding.botId),
      sessionStarted: () => {
        // A state file a gone gateway left behind does not refuse.
        const state = this.liveGateway();
        const platforms = state ? Object.keys(state.platforms).filter((p) => p !== 'local') : [];
        return platforms.length > 0
          ? hermesNotReadyMessage({ ready: false, reason: 'config-mismatch', message: `its gateway runs messaging platforms (${platforms.slice(0, 3).join(', ')}).` })
          : null;
      },
      askOwner: async (req, signal) => {
        // A run no one is present for (an owner routine's slot) is denied at
        // once, with no card: an unanswered card would only hold the turn.
        if (!(this.deps.attended ?? runningWakeAttended)(binding.botId)) return false;
        const approvals = (this.deps.approvals ?? getApprovalService)();
        if (!approvals) return false;
        return approvals.askNativeTool(binding, req, { timeoutMs: HERMES_PERMISSION_TIMEOUT_MS, signal });
      },
      toolAllowed: ownHermesToolAllowed,
      mcpReady: (token, since) => waitForCommanderTokenUse(token, since, MCP_READY_MS),
      // The owner's gateway is never stopped: the cancelled turn did not
      // end within the bound and the adapter let go of its own agent
      // process; the owner is told.
      unsettled: async () => {
        this.log(`[hermes:own] ${binding.botId}'s cancelled turn did not end in time; wmux closed its own Hermes ACP process (the owner's gateway is not stopped)`);
        try {
          (this.deps.unsettledNotice ?? noteOwnHermesUnsettled)(binding);
        } catch (err) {
          this.log(`[hermes:own] the unsettled-turn note of ${binding.botId} was not posted: ${String(err)}`);
        }
      },
      disposed: (adapter) => {
        this.adapters.delete(adapter);
      },
      turnGate: this.turnGate,
    };
  }

  register(adapter: AcpBrainAdapter): void {
    this.adapters.add(adapter);
  }

  /** App quit: every turn on this profile is cancelled (no gateway stop). */
  shutdown(): Promise<void> {
    this.stopping ??= Promise.allSettled([...this.adapters].map((a) => a.shutdown())).then(() => undefined);
    return this.stopping;
  }
}

const hosts = new Map<string, OwnHermesHost>();

/** The app's host for `profile` (made on first use). */
export function getOwnHermesHost(profile: string, make: (profile: string) => OwnHermesHost = (p) => new OwnHermesHost({ profile: p })): OwnHermesHost {
  let h = hosts.get(profile);
  if (!h) {
    h = make(profile);
    hosts.set(profile, h);
  }
  return h;
}

/** App quit: cancel every own-mode turn. */
export function shutdownOwnHermesHosts(): Promise<void> {
  return Promise.allSettled([...hosts.values()].map((h) => h.shutdown())).then(() => undefined);
}

/** Forget the hosts (tests). */
export function clearOwnHermesHosts(): void {
  hosts.clear();
}

