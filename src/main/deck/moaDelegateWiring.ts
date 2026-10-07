// ─── Moa's delegate — the app's wiring (main/index.ts) ───────────────────────
//
// Real ports for MoaAskService / MoaMergeExecutor: the owner's settings
// (deckHqStore), the policy book, the shadow judge's runner, GitHub through
// GhPrReviewService (the lane read is LANE_PR_QUERY, never the TTL cache), the
// pane's cwd and screen, and the asker's branches (its cwd and its task ledger
// rows).
//
// OFF BY DEFAULT. The service is constructed and registered
// (setMoaDelegateService) only while the owner's ask mode is on. With it off,
// nothing here reads or writes a file — except that an EXISTING moa-ask.json
// is set back to `enabled: false` so the MCP side drops the tools; a missing
// one is never created. A corrupt store refuses to start (logged), never
// crashes main.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import type { MoaAskMode, MoaAsker } from '../../shared/moaAsk';
import { moaAskSwitchPath, readMoaAskEnabled } from '../../shared/moaAskSwitch';
import type { DaemonClient } from '../DaemonClient';
import { detectRemote } from '../github/PrProvider';
import { ghPrReviewService } from '../github/GhPrReviewService';
import { ghIssueService } from '../github/GhIssueService';
import { getTaskLedger } from './taskLedgerHost';
import { getMoaConfig, onHqStoreWritten, setMoaAutoRules } from './deckHqStore';
import { loadPolicyBook } from './deckPolicy';
import { setMoaDelegateService } from './moaDelegatePorts';
import { MoaDecisionStore } from './moaDecisionStore';
import { MoaEffectStore } from './moaEffectStore';
import { MoaMergeExecutor } from './moaMergeExecutor';
import { MoaAskService, type MoaAskConfig } from './moaAskService';
import { findShadowJudgment, readPaneScreen, runMoaJudge } from './moaShadowHost';
import type { AskerPaneState, CourierSendResult } from './moaAnswerCourier';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { DEFAULT_MAX_SNAPSHOT_AGE_MS } from './stopGate';
import type { GatedSubmitResult } from '../../shared/ptyMessageDelivery';
import { registerDeliveryCheck } from '../pipe/deliveryGuards';

const execFileAsync = promisify(execFile);
/** Expire stale escalations and reconcile uncertain merges this often. */
const TICK_MS = 10 * 60 * 1000;
/** The audit of merges without a lane receipt. */
const AUDIT_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 5_000;

/** The ask mode in force: off unless Moa is on and the owner chose one. */
export function moaAskModeNow(): MoaAskMode {
  const cfg = getMoaConfig();
  return cfg.enabled ? cfg.askMode ?? 'off' : 'off';
}

/**
 * Keep moa-ask.json (read by the MCP server when it builds tools/list) in step
 * with the mode. On: `{enabled: true}`. Off: an existing file is set to false;
 * a missing one is never created (switches off ⇒ no new files).
 */
export function syncMoaAskSwitch(mode: MoaAskMode, switchPath: string = moaAskSwitchPath()): void {
  const on = mode !== 'off';
  if (!on && !fs.existsSync(switchPath)) return;
  if (readMoaAskEnabled(switchPath) === on && fs.existsSync(switchPath)) return;
  try {
    fs.mkdirSync(path.dirname(switchPath), { recursive: true });
    atomicWriteJSONSync(switchPath, { enabled: on });
  } catch (err) {
    console.warn(`[moa-ask] could not write ${switchPath}: ${String(err)}`);
  }
}

export interface MoaDelegateWiringDeps {
  getDaemonClient: () => DaemonClient | null;
  /** Main's gated paste-and-submit (input.rpc gatedSubmit with waitQuiet):
   *  how an answer reaches the asker's pane. Without it nothing is pasted. */
  submit?: (ptyId: string, text: string, agent: string, guardKey: string) => Promise<GatedSubmitResult>;
  wmuxDir?: string;
  log?: (line: string) => void;
}

interface Running {
  service: MoaAskService;
  timers: NodeJS.Timeout[];
}

let running: Running | null = null;
/** The stores, built once per data dir and kept across off → on: two
 *  instances of one store would each write their own map over the file. */
let stores: { dir: string; decisions: MoaDecisionStore; effects: MoaEffectStore } | null = null;
let guardSeq = 0;
let deps: MoaDelegateWiringDeps | null = null;
let settingsWatched = false;
/** Owner logins by GitHub host (the owner's own PRs are trusted authors). */
const ownerLogins = new Map<string, string>();

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The branches bound to an asker: the one checked out at `repoPath`, and
 *  the branches of the tasks whose workspace the asker is (task ledger). */
async function askerBranches(getDaemonClient: () => DaemonClient | null, asker: MoaAsker, repoPath: string): Promise<string[]> {
  const out = new Set<string>();
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  if (current && current !== 'HEAD') out.add(current);
  let rows: Array<{ id: string; ownerWorkspaceId: string }> = [];
  try {
    rows = getTaskLedger().list({}).filter((e) => e.taskWorkspaceId === asker.workspaceId);
  } catch {
    rows = [];
  }
  const dc = getDaemonClient();
  if (rows.length > 0 && dc?.isConnected) {
    for (const owner of new Set(rows.map((r) => r.ownerWorkspaceId))) {
      try {
        const res = (await dc.rpc('task.mission.list', { verifiedWorkspaceId: owner })) as { ok?: boolean; tasks?: Array<{ id?: unknown; branch?: unknown }> };
        for (const t of res?.tasks ?? []) {
          if (typeof t.branch === 'string' && t.branch && rows.some((r) => r.id === t.id)) out.add(t.branch);
        }
      } catch { /* the cwd branch still counts */ }
    }
  }
  return [...out];
}

/** The asker's pane as the fleet mirror sees it. A stale or missing
 *  snapshot is `unknown` (wait), never `gone`. */
export function askerPaneState(asker: MoaAsker): AskerPaneState {
  const snap = getWorkspaceMirror().getFleetSnapshot(asker.workspaceId);
  if (!snap || Date.now() - snap.ts > DEFAULT_MAX_SNAPSHOT_AGE_MS) return 'unknown';
  const pane = snap.panes.find((p) => p.ptyId === asker.ptyId);
  if (!pane) return 'gone';
  if (pane.isAgent === false) return 'gone';
  // Mid-turn, or a prompt in front of it: the paste would queue or land in
  // the dialog.
  return pane.agentStatus === 'running' || pane.agentStatus === 'awaiting_input' ? 'busy' : 'idle';
}

/** Refusals that wrote nothing (or took it back out): try again later. */
const RETRY_REASONS: ReadonlySet<string> = new Set([
  'approval_pending', 'gate_unavailable', 'usage_limited', 'user_typing', 'deadline', 'agent_unverified', 'fresh_context_busy',
]);

/** A gated submit's result, as the courier reads it. */
export function courierResultOf(r: GatedSubmitResult): CourierSendResult {
  if (r.ok) return { ok: true };
  // Pasted and not taken back out: a second paste would double it.
  const retry = RETRY_REASONS.has(r.reason) && (!r.pasted || r.cleared === true);
  return { ok: false, retry, reason: r.reason };
}

function configNow(): MoaAskConfig {
  const cfg = getMoaConfig();
  return {
    mode: cfg.enabled ? cfg.askMode ?? 'off' : 'off',
    autoRules: cfg.autoRules ?? [],
    trustedAuthors: [...new Set([...(cfg.trustedAuthors ?? []), ...ownerLogins.values()])],
    ...(cfg.autoDailyCap !== undefined ? { autoDailyCap: cfg.autoDailyCap } : {}),
    autoPaused: cfg.autoPaused === true,
  };
}

function build(d: MoaDelegateWiringDeps): MoaAskService {
  const dir = d.wmuxDir ?? getWmuxDir();
  const log = d.log ?? ((l: string) => console.log(l));
  if (!stores || stores.dir !== dir) stores = { dir, decisions: new MoaDecisionStore(dir), effects: new MoaEffectStore(dir) };
  const { decisions, effects } = stores;
  const submit = d.submit;
  const facts = {
    readFresh: async (repoPath: string, key: string, n: number) => {
      const r = await ghPrReviewService.laneFacts(repoPath, key, n);
      if (!r.ok) throw new Error(r.message);
      return r.value;
    },
  };
  let service: MoaAskService | null = null;
  const executor = new MoaMergeExecutor({
    effects,
    facts,
    merge: async (e) => {
      // The subject GitHub would give a squash: the title and the number.
      const head = await ghPrReviewService.checks(e.repoPath, e.repoKey, e.prNumber, true);
      const title = head.ok ? head.value.head.title.trim() : '';
      return ghPrReviewService.merge(e.repoPath, e.repoKey, e.prNumber, {
        expectHead: e.expectHead, subject: `${title || `Pull request #${e.prNumber}`} (#${e.prNumber})`, body: '',
      });
    },
    laneContext: (e) => (service as MoaAskService).laneContext(e),
    authorize: (e) => (service as MoaAskService).authorize(e),
    emit: (e) => service?.emitEffect(e),
    log,
  });
  service = new MoaAskService({
    decisions,
    effects,
    executor,
    facts,
    getConfig: configNow,
    setAutoRules: (ids) => setMoaAutoRules(ids),
    loadBook: () => loadPolicyBook(),
    judge: runMoaJudge,
    readScreen: (ptyId) => readPaneScreen(d.getDaemonClient, ptyId),
    resolveRepo: async (cwd) => {
      const remote = await detectRemote(cwd);
      if (!remote?.key) return null;
      if (!ownerLogins.has(remote.host)) {
        const login = await ghIssueService.signedInLogin(remote.host, cwd).catch(() => null);
        if (login) ownerLogins.set(remote.host, login);
      }
      return { key: remote.key, path: cwd };
    },
    askerBranches: (asker, repoPath) => askerBranches(d.getDaemonClient, asker, repoPath),
    priorJudgment: findShadowJudgment,
    ...(submit
      ? {
          answerPane: {
            state: askerPaneState,
            send: async (asker: MoaAsker, text: string, wanted: () => boolean) => {
              // Asked right before the paste and the Enter (input.rpc), so a
              // poll that read the answer meanwhile stops the paste.
              const key = `moa-answer:${++guardSeq}`;
              const check = () => (wanted() ? null : 'the asker already read this answer');
              const unregister = registerDeliveryCheck(key, { beforePaste: check, beforeEnter: check });
              try {
                return courierResultOf(await submit(asker.ptyId, text, asker.agent, key));
              } finally {
                unregister();
              }
            },
          },
        }
      : {}),
    mergedSince: async (repo, sinceIso) => {
      const r = await ghPrReviewService.mergedSince(repo.path, repo.key, sinceIso);
      return r.ok ? r.value.map((m) => ({ prNumber: m.number, title: m.title, mergedAt: m.mergedAt, headRefOid: m.headRefOid })) : null;
    },
    log,
  });
  return service;
}

/**
 * Start the delegate when the owner's ask mode is on; otherwise register
 * nothing. Safe to call again (refreshMoaDelegate). Returns the service or null.
 */
export function startMoaDelegate(next: MoaDelegateWiringDeps): MoaAskService | null {
  deps = next;
  // Every save of Moa's settings (mode, kill switch, cap, Moa's own switch)
  // re-reads the mode: on registers the service and the MCP switch, off
  // unregisters both, without waiting for the next daemon connect.
  if (!settingsWatched) {
    settingsWatched = true;
    onHqStoreWritten(() => { refreshMoaDelegate(); });
  }
  return refreshMoaDelegate();
}

/** Re-read the mode (the owner changed it): start, keep or stop the service,
 *  and keep moa-ask.json in step. */
export function refreshMoaDelegate(): MoaAskService | null {
  if (!deps) return null;
  const mode = moaAskModeNow();
  syncMoaAskSwitch(mode);
  if (mode === 'off') {
    if (running) {
      running.service.stop();
      for (const t of running.timers) clearInterval(t);
      running = null;
      setMoaDelegateService(null);
    }
    return null;
  }
  if (running) return running.service;
  let service: MoaAskService;
  try {
    service = build(deps);
  } catch (err) {
    // A corrupt store: the delegate stays off rather than guessing.
    (deps.log ?? console.warn)(`[moa-ask] the delegate did not start: ${String(err)}`);
    return null;
  }
  const tick = setInterval(() => { void service.tick().catch(() => undefined); }, TICK_MS);
  const audit = setInterval(() => { void service.audit().catch(() => undefined); }, AUDIT_MS);
  tick.unref?.();
  audit.unref?.();
  running = { service, timers: [tick, audit] };
  setMoaDelegateService(service);
  void service.start().then(() => service.audit()).catch((err) => (deps?.log ?? console.warn)(`[moa-ask] startup reconcile failed: ${String(err)}`));
  return service;
}
