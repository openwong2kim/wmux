// Permission prompts in a linked pane, allowed or denied by the PC that sent
// the task (`kind: 'approval'`, A2A_FEATURE_APPROVAL), on the receiving PC.
//
// Nothing here runs for a PC whose approvals setting (approvalSwitchStore.ts)
// is off: no status, no read of the pane, no key. For a PC it is on for:
//   - the prompt is offered in the task's status (`detail.approval`) only
//     when decideRemoteApproval passes: the record is bound to the agent's
//     call, that call is in the turn this task's own prompt opened
//     (linkedTaskTurns.ts, C2), and no key reached the pane since the submit
//     but this channel's own (the key-revision chain, C3);
//   - an approval names a prompt this PC offered, and is typed under the
//     pane's delivery lock through the registry's remote branch
//     (REMOTE_* markers), which proves the dialog again and re-runs these
//     checks before the read and right before the key;
//   - a decision must be one the status that actually left this PC allowed;
//   - every outcome is stored per message id (a receipt, fsynced), a refusal
//     too, so a resend answers the stored outcome and a retry takes a new id;
//     a receipt is `in-flight` on disk before the key, and one a stop left in
//     flight is `uncertain` and never run again.
// What leaves this PC: the prompt id, the tool name, flags, the auto-deny
// time, and at exposure `command`, for a tool that can be allowed, the bound
// call's command, redacted and capped. Never screen rows, descriptions, the
// working folder or file bodies. Only tasks sent to a linked pane take part.

import crypto from 'node:crypto';
import {
  ANSWER_OUTCOMES_MAX,
  A2A_REMOTE_APPROVAL_COMMAND_MAX,
  approvalCommandText,
  capUtf8,
  type A2aApprovalExposure,
  type A2aRemoteApprovalDecision,
  type A2aRemoteApprovalOffer,
  type A2aRemoteApprovalOutcome,
  type A2aRemoteApprovalReason,
  type A2aRemoteApprovalV1,
  type A2aRemoteStatusV1,
  type HostId,
  parseA2aRemoteStatus,
} from '../../shared/a2aRemote';
import { localSideOf, remoteWorkspaceId, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import type { GatedSubmitProof } from '../../shared/ptyMessageDelivery';
import { redactSecretsCounted } from '../../shared/redactSecrets';
import { TERMINAL_STATES, type Task } from '../../shared/types';
import { AnswerReceiptStore, receiptHash } from '../approvals/AnswerReceiptStore';
import { PLAN_ACTION_APPROVE, type RemoteApprovalRecordFacts } from '../approvals/ApprovalRegistry';
import {
  REMOTE_DECISION_V2_ANSWER,
  REMOTE_TERMINAL_PROMPT_ANSWER,
  REMOTE_TERMINAL_PROMPT_DECLINE,
  type ApprovalResolveParams,
  type ApprovalResolveResult,
} from '../approvals/types';
import { HEADLESS_DELIVERY_TICK_MS, type HeadlessTaskStatus } from './headlessDelivery';
import { HeadlessStatusReporter } from './headlessStatus';
import type { LinkedTaskTurn } from './linkedTaskTurns';

/** Allow is offered for these tools' prompts (WebSearch: its query is the command). */
export const APPROVE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'WebSearch']);
/** Only deny is offered for these, and their command never leaves this PC. */
export const DENY_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'WebFetch', 'Edit', 'Write', 'NotebookEdit']);
/** The plan dialog: its manual-approve row and deny, only where it is answered by fenced keys. */
export const PLAN_TOOL = 'ExitPlanMode';
/**
 * The input fields an allow covers, per tool: what the other PC is shown (the
 * command, and a shell call's description, which the dialog draws). A call
 * with any other field is offered deny only.
 */
export const SHOWN_INPUT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  Bash: new Set(['command', 'description']),
  PowerShell: new Set(['command', 'description']),
  WebSearch: new Set(['query']),
  [PLAN_TOOL]: new Set(['plan']),
});
/** Prompts offered per task at most; later ones stay on this PC. */
export const APPROVAL_PROMPTS_PER_TASK_MAX = 60;
/** Statuses per task this producer sends at most: one per prompt and one per outcome. */
export const APPROVAL_STATUS_CHANGES_MAX = APPROVAL_PROMPTS_PER_TASK_MAX * 2;
/** Approvals one PC may send in a window; past it they are taken and dropped unread. */
export const APPROVALS_PER_WINDOW = 60;
/** Refusal audit lines per PC in a window; past it one line says how many were left out. */
export const APPROVAL_AUDIT_REFUSALS_PER_WINDOW = 30;
export const APPROVAL_WINDOW_MS = 60_000;
/** Outcomes kept in memory for message ids whose receipt could not be written. */
export const APPROVAL_TOMBSTONES_MAX = 4096;
/** The file the outcomes are stored in. */
export const APPROVAL_RECEIPTS_FILE = 'a2a-remote-approval-receipts.json';

/**
 * The receipts store, fsynced on every write. A file that is there but cannot
 * be read or parsed leaves it null: every approval is then refused until a
 * person repairs or removes the file.
 */
export function openApprovalReceipts(dir: string, log: (level: 'error', msg: string) => void, now: () => number = Date.now): AnswerReceiptStore | null {
  try {
    return new AnswerReceiptStore(dir, now, undefined, APPROVAL_RECEIPTS_FILE, { durable: true, strictRead: true });
  } catch (err) {
    log('error', `[a2a-remote] ${APPROVAL_RECEIPTS_FILE} could not be read; approvals from other PCs are refused until it is repaired or removed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** What decideRemoteApproval decides on. Every field is read fresh by the caller. */
export interface RemoteApprovalFacts {
  /** The task's sender's setting here; null: off. */
  exposure: A2aApprovalExposure | null;
  task: { open: boolean; inbound: boolean; fromHost: boolean; linkActive: boolean };
  /** The turn this task's latest delivery opened, and whether its proof names the record's session as it is now; null: unknown. */
  turn: { opened: boolean; closed: boolean; toolUseIds: readonly string[]; sameSession: boolean } | null;
  /** The key-revision chain: the revision the next prompt must have been made at, or broken for the rest of the task. */
  chain: { baseline: number | null; broken: boolean };
  record: Pick<RemoteApprovalRecordFacts, 'native' | 'answered' | 'matched' | 'toolUseId' | 'promptFingerprint' | 'keyRevisionAtCreate' | 'risk' | 'yesKey' | 'fencedPlan'> & {
    /** The bound call's tool. */
    tool?: string;
    /** The keys of the bound call's whole input. */
    inputKeys?: readonly string[];
  };
  /** The command as it would be offered: shown at all, cut at the cap, changed by redaction. */
  command: { shown: boolean; cut: boolean; redacted: boolean };
}

export type RemoteApprovalVerdict = { ok: true; allowed: A2aRemoteApprovalDecision[] } | { ok: false; reason: A2aRemoteApprovalReason };

/** Whether the command of a call of this tool may leave this PC (exposure `command`): only one that can be allowed. */
export function carriesCommand(tool: string | undefined): boolean {
  return tool !== undefined && (APPROVE_TOOLS.has(tool) || tool === PLAN_TOOL);
}

/**
 * Whether a prompt may be offered to (and answered by) the PC that sent the
 * task, and what it may answer. Deny and allow both need the setting on, the
 * task open and from that PC on an active link, a record bound to the agent's
 * call, that call in this task's turn, and the chain unbroken at the record's
 * revision. Allow also needs a tool that takes it, exposure `command`, the
 * command shown whole and unredacted, no input field it does not show
 * (SHOWN_INPUT_KEYS), and no `critical` hint.
 */
export function decideRemoteApproval(f: RemoteApprovalFacts): RemoteApprovalVerdict {
  const no = (reason: A2aRemoteApprovalReason): RemoteApprovalVerdict => ({ ok: false, reason });
  if (f.exposure === null) return no('approvals-off');
  if (!f.task.open || !f.task.inbound || !f.task.fromHost) return no('not-open');
  if (!f.task.linkActive) return no('link-not-active');
  const r = f.record;
  if (r.native) return no('unsupported-tool');
  if (r.answered) return no('not-offered');
  if (!r.matched || !r.toolUseId || !r.promptFingerprint || r.keyRevisionAtCreate === undefined || !r.tool) return no('unbound');
  const t = f.turn;
  if (!t || !t.sameSession || !t.opened || t.closed || !t.toolUseIds.includes(r.toolUseId)) return no('turn-unproven');
  if (f.chain.broken || f.chain.baseline === null || r.keyRevisionAtCreate !== f.chain.baseline) return no('chain-broken');
  const shown = SHOWN_INPUT_KEYS[r.tool];
  const nothingHidden = !!shown && !!r.inputKeys && r.inputKeys.every((k) => shown.has(k));
  const shownWhole = f.exposure === 'command' && f.command.shown && !f.command.cut && !f.command.redacted && nothingHidden && r.risk !== 'critical';
  if (r.tool === PLAN_TOOL) {
    if (!r.fencedPlan) return no('unsupported-tool');
    return { ok: true, allowed: shownWhole ? ['allow', 'deny'] : ['deny'] };
  }
  if (APPROVE_TOOLS.has(r.tool)) return { ok: true, allowed: shownWhole && r.yesKey !== undefined ? ['allow', 'deny'] : ['deny'] };
  if (DENY_ONLY_TOOLS.has(r.tool)) return { ok: true, allowed: ['deny'] };
  return no('unsupported-tool');
}

/**
 * The id a prompt is offered under: its record, its dialog's hash (a plan's
 * form hash), and what the offer says: the exposure, the decisions it allows
 * and the command it shows. An offer that changes in any of these is another
 * id, so an answer names the offer it was given, never a later one.
 */
export function promptIdOf(
  facts: Pick<RemoteApprovalRecordFacts, 'id' | 'promptFingerprint' | 'formFingerprint' | 'fencedPlan'>,
  offer: { exposure: A2aApprovalExposure; allowed: readonly A2aRemoteApprovalDecision[]; command?: string },
): string | null {
  const fp = facts.fencedPlan ? facts.formFingerprint : facts.promptFingerprint;
  if (!fp) return null;
  const command = offer.command === undefined ? '-' : crypto.createHash('sha256').update(offer.command, 'utf8').digest('hex');
  return crypto.createHash('sha256').update([facts.id, fp, offer.exposure, offer.allowed.join(','), command].join('\0')).digest('hex').slice(0, 16);
}

/**
 * The bound call's command as offered at exposure `command`: redacted first,
 * then cleaned as the other PC reads it (approvalCommandText), then capped.
 * `redacted`: what is shown is not the call's own text (a secret masked, or a
 * character the other PC would drop, a carriage return included).
 */
export function offeredCommand(command: string): { text: string; redacted: boolean; cut: boolean } {
  const { text, masked } = redactSecretsCounted(command);
  const clean = approvalCommandText(text);
  const capped = capUtf8(clean, A2A_REMOTE_APPROVAL_COMMAND_MAX);
  return { text: capped.text, redacted: masked > 0 || clean !== command, cut: capped.cut };
}

export interface RemoteApprovalsDeps {
  /** The approvals setting (approvalSwitchStore.ts). */
  exposure(hostId: HostId): A2aApprovalExposure | null;
  anyOn(): boolean;
  tasks: { get(taskId: string): Task | undefined; remote(): Task[] };
  /** The task was sent to a linked pane here (not a headless start's, not a spawn link's). */
  linkedPane(task: Task): boolean;
  /** The link's state is `active`. */
  linkActive(linkId: string): boolean;
  /** The PC's display name, for the audit (`remote:<PC>/<hostId>`). */
  hostName(hostId: HostId): string | undefined;
  /** linkedTaskTurns.ts `latestTurn`. */
  turn(taskId: string): { turn: Exclude<LinkedTaskTurn, 'unknown'>; proof: GatedSubmitProof; taskItself: boolean } | null;
  /** The live session: its incarnation and key epoch; null when it is gone. */
  session(ptyId: string): { incarnation: string | null; keyEpoch: string } | null;
  registry: {
    /** Ids of the pending `terminal_prompt` records on a pane. */
    pendingPrompts(sessionId: string): string[];
    facts(id: string): RemoteApprovalRecordFacts | null;
    resolve(params: ApprovalResolveParams): Promise<ApprovalResolveResult>;
  };
  /** The pane's delivery lock (paneDeliveryLock.ts): its token, or null when another writer kept it. */
  lock(sessionId: string): Promise<string | null>;
  unlock(sessionId: string, token: string): void;
  /** Receipts (openApprovalReceipts); null: it could not be loaded, and nothing is typed. */
  receipts: AnswerReceiptStore | null;
  /** Where this producer's statuses go (A2aRemoteDelivery.statusPeer / sendStatus), behind its own reporter. */
  status: {
    peer(taskId: string): { connected: boolean; takesStatus: boolean; epoch: string | null } | null;
    send(taskId: string, status: A2aRemoteStatusV1): { ok: true } | { ok: false; error: string };
  };
  log(level: 'info' | 'warn', msg: string): void;
  now?: () => number;
  /** Test seam: no timer is started. */
  manualTick?: boolean;
}

interface Chain {
  /** The task's own delivery proof the chain started from (proofKey); null until it is seen. */
  base: string | null;
  baseline: number | null;
  broken: boolean;
}

function proofKey(p: GatedSubmitProof): string {
  return [p.ptyId, p.incarnation, p.keyEpoch, p.submitRevision, p.promptHash].join('\0');
}

interface Tracked {
  /** What left this PC for each prompt id, as last sent: the decisions it allowed. At most APPROVAL_PROMPTS_PER_TASK_MAX. */
  sent: Map<string, { allowed: A2aRemoteApprovalDecision[]; command: boolean }>;
  capLogged: boolean;
  outcomes: A2aRemoteApprovalOutcome[];
}

/** One offerable prompt on a task, with what it was decided from. */
interface Offer {
  facts: RemoteApprovalRecordFacts;
  promptId: string;
  offer: A2aRemoteApprovalOffer;
}

/** A per-PC count in a window. */
class Window {
  private readonly counts = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number) {}
  /** This one's number in the current window (1 for the first). */
  count(key: string): number {
    const at = this.now();
    let w = this.counts.get(key);
    if (!w || at - w.start >= APPROVAL_WINDOW_MS) {
      w = { start: at, count: 0 };
      this.counts.delete(key);
      this.counts.set(key, w);
      while (this.counts.size > 1000) this.counts.delete(this.counts.keys().next().value as string);
    }
    w.count += 1;
    return w.count;
  }
}

export class RemoteApprovals {
  private readonly deps: RemoteApprovalsDeps;
  private readonly now: () => number;
  private readonly chains = new Map<string, Chain>();
  private readonly tracked = new Map<string, Tracked>();
  /** Tasks with an approval being carried out now: one at a time each. */
  private readonly busy = new Set<string>();
  /**
   * Outcomes told for a message id whose receipt could not be written (the
   * store failed or is full): answered the same to a resend while this
   * daemon runs. Oldest dropped past APPROVAL_TOMBSTONES_MAX.
   */
  private readonly tombstones = new Map<string, A2aRemoteApprovalOutcome>();
  private readonly reporter: HeadlessStatusReporter;
  private readonly admitted: Window;
  private readonly audited: Window;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: RemoteApprovalsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.admitted = new Window(this.now);
    this.audited = new Window(this.now);
    this.reporter = new HeadlessStatusReporter({
      peer: (taskId) => deps.status.peer(taskId),
      send: (taskId, status) => deps.status.send(taskId, status),
      // An offer carries no menu labels.
      labels: () => 'send',
      log: deps.log,
      now: this.now,
      changesMax: APPROVAL_STATUS_CHANGES_MAX,
      sent: (taskId, status) => this.noteSent(taskId, status),
    });
  }

  start(): void {
    this.tick();
  }

  /** The setting may have changed: the timer runs only while it is on for some PC. */
  wake(): void {
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One more approval from `hostId` may be taken now (APPROVALS_PER_WINDOW); false: dropped unread, one log line per window. */
  admit(hostId: HostId): boolean {
    const n = this.admitted.count(hostId);
    if (n <= APPROVALS_PER_WINDOW) return true;
    if (n === APPROVALS_PER_WINDOW + 1) this.deps.log('warn', `[a2a-remote] ${hostId}: more than ${APPROVALS_PER_WINDOW} approvals in a minute; the rest are dropped unread`);
    return false;
  }

  /** One pass: what each task whose sender has the setting on offers now. Nothing is read while it is on for no PC. */
  tick(): void {
    if (!this.deps.anyOn()) {
      this.stop();
      this.tracked.clear();
      // A chain broken stays broken until its task ends; one that is not is started again from its proof.
      for (const [id, chain] of [...this.chains]) if (!chain.broken) this.chains.delete(id);
      this.reporter.tick([]);
      return;
    }
    if (!this.timer && this.deps.manualTick !== true) {
      this.timer = setInterval(() => this.tick(), HEADLESS_DELIVERY_TICK_MS);
      this.timer.unref?.();
    }
    const statuses: HeadlessTaskStatus[] = [];
    const live = new Set<string>();
    let tasks: Task[] = [];
    try {
      tasks = this.deps.tasks.remote();
    } catch (err) {
      this.deps.log('warn', `[a2a-remote] approvals: the task list: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const task of tasks) {
      const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
      if (marker?.direction !== 'inbound' || (TERMINAL_STATES as readonly string[]).includes(task.status.state)) continue;
      live.add(task.id);
      if (this.deps.exposure(marker.hostId) === null || !this.deps.linkedPane(task)) continue;
      try {
        const status = this.statusOf(task);
        if (status) statuses.push(status);
      } catch (err) {
        this.deps.log('warn', `[a2a-remote] approvals: task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const id of [...this.chains.keys()]) if (!live.has(id)) this.chains.delete(id);
    for (const id of [...this.tracked.keys()]) if (!live.has(id)) this.tracked.delete(id);
    this.reporter.tick(statuses);
  }

  /**
   * The sender's approval of a prompt this PC offered. Never throws; how it
   * went is stored per message id, kept for the task's status (a linked pane's
   * task only) and logged. `running`: a resend of one still being carried out.
   */
  async take(hostId: HostId, taskId: string, messageId: string, approval: A2aRemoteApprovalV1): Promise<A2aRemoteApprovalOutcome | 'running'> {
    const outcome = await this.carryOut(hostId, taskId, messageId, approval).catch((err: unknown): A2aRemoteApprovalOutcome => {
      this.deps.log('warn', `[a2a-remote] approval task=${taskId} message=${messageId}: ${err instanceof Error ? err.message : String(err)}`);
      return { messageId, outcome: 'not-done', reason: 'unavailable' };
    });
    // A resend of one still running: its own outcome is recorded when it ends. Only a linked pane's task has a status here.
    const task = this.deps.tasks.get(taskId);
    if (outcome !== 'running' && task && this.deps.linkedPane(task)) this.record(taskId, outcome);
    return outcome;
  }

  private async carryOut(hostId: HostId, taskId: string, messageId: string, approval: A2aRemoteApprovalV1): Promise<A2aRemoteApprovalOutcome | 'running'> {
    const receipts = this.deps.receipts;
    if (!receipts) {
      this.audit(hostId, taskId, messageId, approval, 'not-done:unavailable');
      return { messageId, outcome: 'not-done', reason: 'unavailable' };
    }
    const owner = `remote:${hostId}`;
    const approvalId = `${taskId}:${approval.promptId}:${approval.decision}`;
    const bodyHash = receiptHash([taskId, approval.promptId, approval.decision]);
    const seen = receipts.peek(owner, messageId, approvalId, bodyHash);
    if (seen?.kind === 'in-flight') return 'running';
    const tombKey = `${owner}\0${messageId}`;
    const stored = this.storedOutcome(seen, messageId) ?? this.tombstones.get(tombKey) ?? null;
    if (stored) {
      this.audit(hostId, taskId, messageId, approval, `stored:${stored.outcome}${stored.reason ? `:${stored.reason}` : ''}`);
      return stored;
    }
    /** An outcome told without a receipt on disk: kept for a resend while this daemon runs. */
    const tombstone = (out: A2aRemoteApprovalOutcome): A2aRemoteApprovalOutcome => {
      this.tombstones.delete(tombKey);
      this.tombstones.set(tombKey, out);
      while (this.tombstones.size > APPROVAL_TOMBSTONES_MAX) this.tombstones.delete(this.tombstones.keys().next().value as string);
      return out;
    };
    /** A refusal: stored for this message id first, so a resend answers it again. */
    const refuse = async (reason: A2aRemoteApprovalReason, fp?: string): Promise<A2aRemoteApprovalOutcome | 'running'> => {
      this.audit(hostId, taskId, messageId, approval, `not-done:${reason}`, fp);
      try {
        const begun = await receipts.begin(owner, messageId, approvalId, bodyHash);
        if (begun.kind === 'new') {
          await receipts.finish(owner, messageId, 'refused', { status: 409, body: { outcome: 'not-done', reason } });
          return { messageId, outcome: 'not-done', reason };
        }
        if (begun.kind === 'in-flight') return 'running';
        if (begun.kind !== 'full') return this.storedOutcome(begun, messageId) ?? tombstone({ messageId, outcome: 'not-done', reason });
      } catch {
        // Not written: kept in memory below.
      }
      return tombstone({ messageId, outcome: 'not-done', reason });
    };
    if (this.deps.exposure(hostId) === null) return refuse('approvals-off');
    const task = this.deps.tasks.get(taskId);
    const marker = task?.metadata.remote as A2aRemoteTaskState | undefined;
    if (!task || marker?.hostId !== hostId) return refuse('not-open');
    if (!this.deps.linkedPane(task)) return refuse('not-linked');
    if (this.busy.has(taskId)) return refuse('lock-busy');
    this.busy.add(taskId);
    try {
      const found = this.currentOffer(task);
      if ('reason' in found) return await refuse(found.reason);
      const fp8 = found.facts.promptFingerprint?.slice(0, 8);
      if (found.promptId !== approval.promptId) return await refuse('not-offered', fp8);
      const wire = this.tracked.get(taskId)?.sent.get(found.promptId);
      if (!wire) return await refuse('not-offered', fp8);
      // In what left this PC and in what holds now.
      if (!wire.allowed.includes(approval.decision) || !found.offer.allowed.includes(approval.decision)) return await refuse('deny-only', fp8);
      const sessionId = found.facts.sessionId;
      let token: string | null = null;
      try {
        token = await this.deps.lock(sessionId);
      } catch {
        token = null;
      }
      if (!token) return await refuse('lock-busy', fp8);
      try {
        let begun: Awaited<ReturnType<AnswerReceiptStore['begin']>>;
        try {
          begun = await receipts.begin(owner, messageId, approvalId, bodyHash);
        } catch {
          this.audit(hostId, taskId, messageId, approval, 'not-done:unavailable', fp8);
          return tombstone({ messageId, outcome: 'not-done', reason: 'unavailable' });
        }
        if (begun.kind === 'in-flight') return 'running';
        if (begun.kind !== 'new') {
          return this.storedOutcome(begun.kind === 'full' ? null : begun, messageId) ?? tombstone({ messageId, outcome: 'not-done', reason: 'unavailable' });
        }
        let result: ApprovalResolveResult;
        try {
          result = await this.deps.registry.resolve(this.resolveParams(hostId, task, messageId, approval, found));
        } catch (err) {
          // Whether its key landed is not known: said so, and never run again.
          await receipts.finish(owner, messageId, 'uncertain', { status: 500, body: { outcome: 'uncertain' } });
          this.audit(hostId, taskId, messageId, approval, `uncertain:${err instanceof Error ? err.message : String(err)}`, fp8);
          return { messageId, outcome: 'uncertain' };
        }
        const out: A2aRemoteApprovalOutcome = result.ok ? { messageId, outcome: 'done' } : { messageId, outcome: 'not-done', reason: 'refused' };
        await receipts.finish(owner, messageId, result.ok ? 'done' : 'refused', {
          status: result.ok ? 200 : 409,
          body: { outcome: out.outcome, ...(out.reason ? { reason: out.reason } : {}) },
        });
        this.audit(hostId, taskId, messageId, approval, result.ok ? 'done' : `not-done:refused:${result.reason}`, fp8);
        return out;
      } finally {
        this.deps.unlock(sessionId, token);
      }
    } finally {
      this.busy.delete(taskId);
    }
  }

  /** What a receipt already stands for, as an outcome; null when the message id is unused. */
  private storedOutcome(seen: ReturnType<AnswerReceiptStore['peek']>, messageId: string): A2aRemoteApprovalOutcome | null {
    if (!seen) return null;
    if (seen.kind === 'reused') return { messageId, outcome: 'not-done', reason: 'id-reused' };
    if (seen.kind === 'in-flight' || seen.kind === 'uncertain') return { messageId, outcome: 'uncertain' };
    const body = seen.response.body;
    if (body['outcome'] === 'done') return { messageId, outcome: 'done' };
    if (body['outcome'] === 'uncertain') return { messageId, outcome: 'uncertain' };
    return { messageId, outcome: 'not-done', reason: typeof body['reason'] === 'string' ? body['reason'] as A2aRemoteApprovalReason : 'refused' };
  }

  private resolveParams(hostId: HostId, task: Task, messageId: string, approval: A2aRemoteApprovalV1, found: Offer): ApprovalResolveParams {
    const { facts } = found;
    const name = (this.deps.hostName(hostId) ?? '').slice(0, 64);
    const resolvedBy = `remote:${name}/${hostId}`;
    const recheck = (record: { id: string }): boolean => {
      const now = this.offerFor(task.id, record.id);
      const wire = this.tracked.get(task.id)?.sent.get(approval.promptId);
      return !('reason' in now) && now.promptId === approval.promptId && now.offer.allowed.includes(approval.decision)
        && !!wire && wire.allowed.includes(approval.decision);
    };
    const common = {
      id: facts.id,
      resolvedBy,
      authorize: async (record: { id: string }): Promise<'ok' | 'expired'> => (recheck(record) ? 'ok' : 'expired'),
      authorizeNow: (record: { id: string }): boolean => recheck(record),
      // decide() offered it only with a revision at creation.
      onKeyWritten: (revision: number | null): void => this.advance(task.id, facts.keyRevisionAtCreate ?? -1, revision),
    };
    if (approval.decision === 'deny') {
      return { ...common, decision: 'deny', terminalPromptDecline: REMOTE_TERMINAL_PROMPT_DECLINE, ...(facts.promptFingerprint ? { promptFingerprint: facts.promptFingerprint } : {}) };
    }
    if (facts.fencedPlan) {
      return {
        ...common,
        decision: 'approve',
        decisionV2Answer: REMOTE_DECISION_V2_ANSWER,
        decisionAnswer: { formFingerprint: facts.formFingerprint ?? '', clientAnswerId: messageId, action: PLAN_ACTION_APPROVE },
      };
    }
    return {
      ...common,
      decision: 'approve',
      choiceKey: facts.yesKey ?? '',
      ...(facts.promptFingerprint ? { promptFingerprint: facts.promptFingerprint } : {}),
      terminalPromptAnswer: REMOTE_TERMINAL_PROMPT_ANSWER,
    };
  }

  /** This channel's own key landed: the chain moves to it only when it is the next revision; anything else breaks it. */
  private advance(taskId: string, from: number, revision: number | null): void {
    const chain = this.chains.get(taskId);
    if (!chain) return;
    if (!chain.broken && chain.baseline === from && revision === from + 1) {
      chain.baseline = revision;
      return;
    }
    this.breakChain(taskId, chain, 'a key revision after this channel\'s write that is not the next one');
  }

  private breakChain(taskId: string, chain: Chain, why: string): void {
    if (chain.broken) return;
    chain.broken = true;
    this.deps.log('info', `[a2a-remote] approvals: task ${taskId}: answered on this PC from now on (${why})`);
  }

  /**
   * The task's chain, started at its own delivery's submit. Any other write
   * breaks it for the rest of the task, a later delivery included: a follow-up
   * typed into the pane, or the task delivered again under another proof.
   */
  private chainOf(taskId: string, latest: ReturnType<RemoteApprovalsDeps['turn']>): Chain {
    let chain = this.chains.get(taskId);
    if (!chain) {
      chain = { base: null, baseline: null, broken: false };
      this.chains.set(taskId, chain);
    }
    if (!latest || chain.broken) return chain;
    if (!latest.taskItself) {
      this.breakChain(taskId, chain, 'a later message was delivered into the pane');
    } else if (chain.base === null) {
      chain.base = proofKey(latest.proof);
      chain.baseline = latest.proof.submitRevision;
    } else if (chain.base !== proofKey(latest.proof)) {
      this.breakChain(taskId, chain, 'the task was delivered again');
    }
    return chain;
  }

  /** The offer for one record of the task, decided from facts read now. */
  private offerFor(taskId: string, recordId: string): Offer | { reason: A2aRemoteApprovalReason } {
    const task = this.deps.tasks.get(taskId);
    if (!task) return { reason: 'not-open' };
    if (!this.deps.linkedPane(task)) return { reason: 'not-linked' };
    const facts = this.deps.registry.facts(recordId);
    if (!facts) return { reason: 'not-offered' };
    return this.decide(task, facts);
  }

  private decide(task: Task, facts: RemoteApprovalRecordFacts): Offer | { reason: A2aRemoteApprovalReason } {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    const hostId = marker?.hostId ?? '';
    const exposure = marker ? this.deps.exposure(hostId) : null;
    const ptyId = task.metadata[localSideOf(task)].ptyId;
    const latest = this.deps.turn(task.id);
    const chain = this.chainOf(task.id, latest);
    const live = latest ? this.deps.session(latest.proof.ptyId) : null;
    const sameSession = !!latest && !!live && facts.sessionId === latest.proof.ptyId && facts.sessionId === ptyId
      && live.incarnation === latest.proof.incarnation && live.keyEpoch === latest.proof.keyEpoch;
    // The command leaves this PC only for a call that can be allowed.
    const command = exposure === 'command' && facts.call && carriesCommand(facts.call.name) ? offeredCommand(facts.call.command) : null;
    const verdict = decideRemoteApproval({
      exposure,
      task: {
        open: !(TERMINAL_STATES as readonly string[]).includes(task.status.state),
        inbound: marker?.direction === 'inbound',
        // Sent from that PC's end of this link (the check inbound.ts makes for an answer).
        fromHost: !!marker && task.metadata.from.workspaceId === remoteWorkspaceId(marker.linkId),
        linkActive: !!marker && this.deps.linkActive(marker.linkId),
      },
      turn: latest ? { ...latest.turn, sameSession } : null,
      chain,
      record: { ...facts, ...(facts.call ? { tool: facts.call.name, inputKeys: facts.call.inputKeys } : {}) },
      // An empty command (a plan call without its text) shows nothing to allow.
      command: { shown: command !== null && command.text.trim() !== '', cut: command?.cut ?? false, redacted: command?.redacted ?? false },
    });
    if (!verdict.ok) {
      // A prompt in this task's turn made at another revision: some other key reached the pane.
      if (verdict.reason === 'chain-broken' && !chain.broken && chain.baseline !== null) this.breakChain(task.id, chain, 'the pane took a key that was not this channel\'s');
      return { reason: verdict.reason };
    }
    const shownCommand = command && command.text.trim() !== '' ? command.text : undefined;
    const promptId = exposure ? promptIdOf(facts, { exposure, allowed: verdict.allowed, ...(shownCommand !== undefined ? { command: shownCommand } : {}) }) : null;
    if (!promptId || !facts.call) return { reason: 'unbound' };
    return {
      facts,
      promptId,
      offer: {
        promptId,
        tool: facts.call.name,
        ...(shownCommand !== undefined ? { command: shownCommand } : {}),
        redacted: command?.redacted ?? false,
        cut: command?.cut ?? false,
        ...(facts.autoDenyAt ? { autoDenyAt: facts.autoDenyAt } : {}),
        allowed: verdict.allowed,
      },
    };
  }

  /** The prompt the task offers now: the newest pending record on its pane that passes; else why none. */
  private currentOffer(task: Task): Offer | { reason: A2aRemoteApprovalReason } {
    const ptyId = task.metadata[localSideOf(task)].ptyId;
    if (!ptyId) return { reason: 'not-offered' };
    let best: Offer | null = null;
    let why: A2aRemoteApprovalReason = 'not-offered';
    for (const id of this.deps.registry.pendingPrompts(ptyId)) {
      const facts = this.deps.registry.facts(id);
      if (!facts) continue;
      const found = this.decide(task, facts);
      if ('reason' in found) {
        why = found.reason;
        continue;
      }
      best = found;
    }
    return best ?? { reason: why };
  }

  private trackedOf(taskId: string): Tracked {
    let t = this.tracked.get(taskId);
    if (!t) {
      t = { sent: new Map(), capLogged: false, outcomes: [] };
      this.tracked.set(taskId, t);
    }
    return t;
  }

  private statusOf(task: Task): HeadlessTaskStatus | null {
    let t = this.tracked.get(task.id);
    // Nothing offered yet and no open turn of the task's own: the pane's prompts are not read.
    const latest = this.deps.turn(task.id);
    if (!t && (!latest || !latest.turn.opened || latest.turn.closed)) return null;
    const found = this.currentOffer(task);
    if (!('reason' in found)) {
      t = this.trackedOf(task.id);
      if (!t.sent.has(found.promptId) && t.sent.size >= APPROVAL_PROMPTS_PER_TASK_MAX) {
        if (!t.capLogged) {
          t.capLogged = true;
          this.deps.log('info', `[a2a-remote] approvals: task ${task.id}: ${APPROVAL_PROMPTS_PER_TASK_MAX} prompts offered; later ones are answered on this PC`);
        }
      } else {
        return {
          taskId: task.id,
          kind: 'question',
          detail: {
            question: found.facts.fencedPlan ? 'plan' : 'permission',
            approval: found.offer,
            ...(t.outcomes.length > 0 ? { approvals: [...t.outcomes] } : {}),
          },
        };
      }
    }
    // Nothing offered on this task yet: it says nothing (a linked pane has no status otherwise).
    if (!t) return null;
    const turn = latest?.turn;
    return {
      taskId: task.id,
      kind: turn && turn.opened && !turn.closed ? 'working' : 'waiting-input',
      ...(t.outcomes.length > 0 ? { detail: { approvals: [...t.outcomes] } } : {}),
    };
  }

  /** A status was queued for the PC: what it offers is what an answer is held to, as read on the other side. */
  private noteSent(taskId: string, status: A2aRemoteStatusV1): void {
    const offer = parseA2aRemoteStatus(status)?.detail?.approval;
    if (!offer) return;
    const t = this.trackedOf(taskId);
    if (!t.sent.has(offer.promptId) && t.sent.size >= APPROVAL_PROMPTS_PER_TASK_MAX) return;
    t.sent.set(offer.promptId, { allowed: [...offer.allowed], command: offer.command !== undefined });
  }

  /** Kept for the task's status while its sender has the setting on. */
  private record(taskId: string, outcome: A2aRemoteApprovalOutcome): void {
    const t = this.trackedOf(taskId);
    // A message id reused for another decision does not overwrite what that message did.
    if (outcome.reason === 'id-reused' && t.outcomes.some((o) => o.messageId === outcome.messageId)) return;
    const list = [...t.outcomes.filter((o) => o.messageId !== outcome.messageId), outcome];
    t.outcomes = list.slice(-ANSWER_OUTCOMES_MAX);
  }

  /**
   * One line per approval: ids, decision and outcome, the dialog hash's first
   * 8 characters; never the command. Refusals: at most
   * APPROVAL_AUDIT_REFUSALS_PER_WINDOW lines per PC in a window, then one line.
   */
  private audit(hostId: HostId, taskId: string, messageId: string, approval: A2aRemoteApprovalV1, outcome: string, fp8?: string): void {
    if (outcome.startsWith('not-done') || outcome.startsWith('stored:not-done')) {
      const n = this.audited.count(hostId);
      if (n > APPROVAL_AUDIT_REFUSALS_PER_WINDOW) {
        if (n === APPROVAL_AUDIT_REFUSALS_PER_WINDOW + 1) this.deps.log('info', `[a2a-remote] approvals: ${hostId}: more refusals in this minute are not logged`);
        return;
      }
    }
    this.deps.log('info', `[a2a-remote] approval task=${taskId} message=${messageId} prompt=${approval.promptId} decision=${approval.decision} outcome=${outcome} fp=${fp8 || '-'}`);
  }
}
