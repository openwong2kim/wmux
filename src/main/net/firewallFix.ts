// === The firewall Fix and Remove, one human click at a time ===
//
// The renderer asks; main decides and runs. Main keeps the last probe each
// listener showed the person, and a Fix runs only for what that probe said:
// a fixable verdict, no refusal, and the same program and port the daemon
// reports at click time (read again here). That program must also be main's
// own: the packaged daemon runs wmux.exe itself, and an answer naming any
// other wmux.exe (a stale daemon, or something else on the pipe) is refused.
// Then:
//
//   build the script (netFirewallScripts.ts, every input validated)
//   → one elevation (Windows consent prompt / macOS admin sheet)
//   → re-probe, whatever the outcome, with a probe that starts now (never
//     one begun before the rules existed): the fresh probe, not the exit
//     code, is what the UI says about the rule
//   → record a rule the re-probe confirmed (firewall-rules.json), or forget
//     one a Remove took away.
//
// One elevation at a time across all listeners; a second click while one
// runs is refused as busy. An elevated child that outlives the wait keeps
// that slot until it exits.

import {
  elevationKind,
  elevationOutcome,
  isFixableVerdict,
  type ElevationOutcome,
  type FirewallActionResult,
  type FirewallListener,
  type InboundStatus,
  type InboundStatusView,
} from '../../shared/netFirewall';
import {
  FirewallInputError,
  buildFixScript,
  buildMacFixAppleScript,
  buildRemoveScript,
  firewallRuleIds,
  type PathFacts,
  type RuleScope,
} from '../../shared/netFirewallScripts';
import type { ListenProblemReport } from '../../shared/netListen';
import type { ShellRunResult } from './elevate';

/** The probe's 8 s deadline plus the powershell.exe spawn: above the control pipe's default. */
export const INBOUND_STATUS_RPC_TIMEOUT_MS = 12_000;
/** The holder lookup's 3 s per tool, two netstat reads and a tasklist, plus the trial binds. */
export const LISTEN_PROBLEM_RPC_TIMEOUT_MS = 12_000;

interface FirewallTarget {
  exe: string;
  platform: string;
  applicable: boolean;
  port: number | null;
  tailnet: boolean;
}

export interface FirewallFixDeps {
  /** The daemon control pipe. */
  rpc: (method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
  /** Windows: run the script through the consent prompt (elevate.ts). */
  elevateWindows: (script: string) => Promise<ShellRunResult>;
  /** macOS: run the AppleScript `with administrator privileges` (verify on Mac). */
  elevateMac: (appleScript: string) => Promise<ElevationOutcome>;
  facts: PathFacts;
  /** Read per action, not once: the data suffix is set after this module loads. */
  scope: () => RuleScope;
  /** Main's own program (process.execPath): one of the two a rule may name. */
  selfExe: string;
  /** The other: the copy of main's program this build's daemon runs from
   *  (daemonRuntimeStage.ts), or null where the daemon runs the install's. */
  stagedExe?: () => string | null;
  platform?: NodeJS.Platform;
  /** TOKEN_ELEVATION_TYPE and whether wmux itself runs elevated, for the hint's wording. */
  tokenType: () => number | null;
  selfElevated: () => boolean | null;
  log?: (msg: string) => void;
}

function isStatus(v: unknown): v is InboundStatus {
  return !!v && typeof v === 'object' && typeof (v as InboundStatus).verdict === 'string' && typeof (v as InboundStatus).listener === 'string';
}

export class FirewallFixer {
  private readonly seen = new Map<FirewallListener, InboundStatus>();
  /** Per listener, the newest status() call: an older answer arriving later is not what was shown last. */
  private readonly asked = new Map<FirewallListener, number>();
  private busy = false;
  /** The elevated child of the action in progress, when it outlived the wait. */
  private stillRunning: Promise<void> | null = null;

  constructor(private readonly deps: FirewallFixDeps) {}

  /**
   * Run the read-only probe and remember what it showed. `fresh`: a probe
   * that starts now, never one already running (Check firewall, a re-check,
   * the re-probe after an action).
   */
  async status(listener: FirewallListener, opts: { fresh?: boolean } = {}): Promise<InboundStatusView> {
    const params: Record<string, unknown> = opts.fresh ? { listener, fresh: true } : { listener };
    const n = (this.asked.get(listener) ?? 0) + 1;
    this.asked.set(listener, n);
    const raw = await this.deps.rpc('net.inboundStatus', params, { timeoutMs: INBOUND_STATUS_RPC_TIMEOUT_MS });
    if (!isStatus(raw)) throw new Error('net.inboundStatus: malformed daemon response');
    if (this.asked.get(listener) === n) this.seen.set(listener, raw);
    return { ...raw, elevation: elevationKind(this.deps.tokenType(), this.deps.selfElevated()) };
  }

  async listenProblem(listener: FirewallListener): Promise<ListenProblemReport | null> {
    return (await this.deps.rpc('net.listenProblem', { listener }, { timeoutMs: LISTEN_PROBLEM_RPC_TIMEOUT_MS })) as ListenProblemReport | null;
  }

  fix(listener: FirewallListener): Promise<FirewallActionResult> {
    return this.once(listener, 'fix');
  }

  remove(listener: FirewallListener): Promise<FirewallActionResult> {
    return this.once(listener, 'remove');
  }

  private async once(listener: FirewallListener, action: 'fix' | 'remove'): Promise<FirewallActionResult> {
    if (this.busy) return { outcome: { kind: 'refused', refusal: 'busy' }, status: null };
    this.busy = true;
    this.stillRunning = null;
    try {
      return await this.run(listener, action);
    } finally {
      // Set by run(); TypeScript still narrows it to the null assigned above.
      const running = this.stillRunning as Promise<void> | null;
      if (running) void running.then(() => { this.busy = false; });
      else this.busy = false;
    }
  }

  /** The daemon's program is main's, or the copy of it this build stages
   *  (case-insensitive on Windows). */
  private isSelf(exe: string): boolean {
    const win = (this.deps.platform ?? process.platform) === 'win32';
    const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (same(exe, this.deps.selfExe)) return true;
    const staged = this.deps.stagedExe?.() ?? null;
    return staged !== null && same(exe, staged);
  }

  private async run(listener: FirewallListener, action: 'fix' | 'remove'): Promise<FirewallActionResult> {
    const shown = this.seen.get(listener);
    const refused = (refusal: Extract<FirewallActionResult['outcome'], { kind: 'refused' }>['refusal']): FirewallActionResult => ({
      outcome: { kind: 'refused', refusal },
      status: shown ?? null,
    });
    // Only what the person was shown: a Fix for a fixable verdict, a Remove for our covering rule.
    if (!shown || !shown.applicable || shown.port === null) return refused('changed');
    if (shown.refusal) return refused(shown.refusal);
    if (action === 'fix' ? !isFixableVerdict(shown.verdict) : shown.verdict !== 'covered') return refused('changed');

    const target = (await this.deps.rpc('net.firewallTarget', { listener })) as FirewallTarget;
    if (!target || !target.applicable || target.port !== shown.port || target.exe !== shown.exe) return refused('changed');
    if (!this.isSelf(target.exe)) return refused('changed');

    let outcome: ElevationOutcome;
    if (shown.platform === 'darwin') {
      if (action === 'remove') return refused('unsupported-platform');
      let script: string;
      try {
        script = buildMacFixAppleScript(target.exe);
      } catch (err) {
        if (err instanceof FirewallInputError) return refused(err.reason === 'bad-input' ? 'changed' : err.reason);
        throw err;
      }
      outcome = await this.deps.elevateMac(script);
    } else if (shown.platform === 'win32') {
      // The rule IDs the person saw must be the ones this script writes.
      const scope = this.deps.scope();
      const ids = firewallRuleIds(listener, target.exe, scope);
      if (shown.ruleIds?.allow !== ids.allow || shown.ruleIds?.pubblock !== ids.pubblock) return refused('changed');
      let script: string;
      try {
        script =
          action === 'fix'
            ? buildFixScript({ listener, port: target.port, exe: shown.exe, reportedExe: target.exe, tailnet: target.tailnet, scope, facts: this.deps.facts })
            : buildRemoveScript({ listener, exe: shown.exe, reportedExe: target.exe, scope, facts: this.deps.facts });
      } catch (err) {
        if (err instanceof FirewallInputError) return refused(err.reason === 'bad-input' ? 'changed' : err.reason);
        throw err;
      }
      const ran = await this.deps.elevateWindows(script);
      this.stillRunning = ran.stillRunning ?? null;
      outcome = elevationOutcome(ran);
    } else {
      return refused('unsupported-platform');
    }
    this.deps.log?.(`[net] firewall ${action} for ${listener}: ${outcome.kind}`);

    // Whatever happened, the probe says what is true now.
    let status: InboundStatus | null = null;
    try {
      status = await this.status(listener, { fresh: true });
    } catch (err) {
      this.deps.log?.(`[net] re-probe after ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (status && shown.platform === 'win32') {
      if (action === 'fix' && status.verdict === 'covered') await this.record(listener, 'set');
      if (action === 'remove' && status.verdict !== 'covered' && status.verdict !== 'unknown') await this.record(listener, 'clear');
    }
    return { outcome, status };
  }

  private async record(listener: FirewallListener, op: 'set' | 'clear'): Promise<void> {
    try {
      await this.deps.rpc('net.firewallRecord', { listener, op });
    } catch (err) {
      this.deps.log?.(`[net] could not ${op} the firewall record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
