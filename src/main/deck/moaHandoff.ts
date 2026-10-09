// ─── Moa's hand-offs — work for another workspace, approved by the operator ──
//
// Moa (the HQ brain) used to delegate by pasting an A2A envelope ("From: Moa")
// into another workspace's agent. A careful agent refuses that, rightly: it is
// not the operator's instruction. Now Moa calls `moa_propose_handoff`
// (deck.proposeHandoff) and main does the rest:
//
//   1. STORE. Main keeps the body (≤16 KB, and short enough for the A2A
//      message cap with the label), the target pane, its agent, and later the
//      task id. Moa's text never reaches the pane on Moa's say-so.
//   2. CARD. A decision card in the TARGET workspace's slot (raiseDecisionIfFree,
//      origin 'moa-handoff'): Hand off / Edit / Cancel. It shows in Moa's
//      "Waiting on you". A taken slot answers `busy`. The card says when the
//      agent takes one line only (newlines folded) or is mid-turn (it queues).
//      A main-owned card is never shown to a brain and no brain can resolve it.
//   3. DELIVERY on a human click, by card id only: main reads the body from
//      this store (an edited body is the operator's own input from the
//      renderer), then sends it as a new A2A task over the operator lane with
//      the gated delivery (handoff.ts deliverOperatorTask): the text lands as
//      the operator's own typing, no envelope, plus one provenance line
//      (buildHandoffLabel). That line is a LABEL for the worker, NOT an
//      authentication boundary: anyone who can type can type it.
//   4. FEEDBACK. The task is the operator's, so A2A events name the operator
//      as the sender; this store maps task id → HQ so deck.handler routes them
//      to Moa. A worker's Claude Stop hook that ends on a question or a refusal,
//      with the task still open, moves the task to input-required (its closing
//      words ride along as UNTRUSTED text); completion is only ever explicit.
//      Another stop is passed to Moa as a turn end. A closed pane or an agent
//      that left cancels the task.
//   5. FAILURE. An undelivered hand-off releases its task and link
//      (releaseUndelivered) and puts a notice card ([OK]) in the target slot.
//
// DANGER MODE (owner decision): with the TARGET workspace and the HQ both in
// `danger` mode, Settings › Moa › auto hand-off on, a body that did not come
// from outside sources, and fewer than HANDOFF_AUTO_PER_HOUR_DEFAULT auto
// hand-offs to that target in the last hour, main delivers at once, no card.
// Modes are read here from the stores, never taken from the brain, and read
// again right before the paste and before the Enter (a registered delivery
// check); any change falls back to the card. Every auto hand-off leaves a
// receipt (Moa's panel: Stop / Open pane) and a WorkLink with origin 'moa-auto'.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { createSerialChain } from './serialChain';
import type { AgentMode } from './deckAutonomyStore';
import type { DecisionOrigin, WorkspaceDecision } from './deckDecisionStore';
import { generateId, type AgentStatus } from '../../shared/types';
import { resolveAgentSlug } from '../../shared/ptyMessageDelivery';
import { isBrainPtyId } from '../../shared/constants';
import {
  HANDOFF_AUTO_PER_HOUR_DEFAULT,
  HANDOFF_LAST_MESSAGE_MAX_BYTES,
  HANDOFF_NOTICE_OPTION,
  HANDOFF_OPTIONS,
  HANDOFF_PREVIEW_CHARS,
  buildHandoffText,
  handoffBodyRefusal,
  type HandoffAskReason,
  type MoaAutoHandoffReceipt,
  type MoaHandoffCardInfo,
  type MoaHandoffResolveResult,
} from '../../shared/moaHandoff';
import type { WorkLink, WorkLinkReason, WorkLinkState } from '../../shared/workLink';
import type { WorkLinkUpsert } from '../workLink/workLinkStore';
import type { OperatorTaskDelivery } from '../git/handoff';
import type { HandoffTarget } from '../../shared/gitHandoff';
import { goalHardRuleHit } from '../../shared/moaGoal';
import type { DeliveryCheck } from '../pipe/deliveryGuards';

const TITLE_MAX = 80;
const MAX_RECORDS = 500;
/** How long an auto hand-off's receipt stays in Moa's panel. */
const RECEIPT_TTL_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Characters of the worker's closing words a wake quotes (its tail). */
const WAKE_QUESTION_CHARS = 280;
/** A delivery or a claimed card older than this is one the app did not finish. */
const STALE_DELIVERY_MS = 2 * 60_000;

export type HandoffState = 'pending' | 'delivering' | 'delivered' | 'canceled' | 'failed' | 'expired';

export interface HandoffRecord {
  id: string;
  hqWorkspaceId: string;
  target: HandoffTarget & { agentName: string };
  title: string;
  body: string;
  /** The body carries text from outside (GitHub, the web): it always asks. */
  externalSource: boolean;
  state: HandoffState;
  /** Delivered without a click (danger mode, or an approved goal). */
  auto?: boolean;
  /** Delivered without a click under this approved goal contract
   *  (moaGoalContract.ts): the target is a workspace the goal covers. */
  goalId?: string;
  /** The card (or the failure notice) in the target slot. */
  decisionId?: string;
  notice?: boolean;
  taskId?: string;
  linkId?: string;
  /** Last A2A state seen for the task. */
  taskState?: string;
  foldsNewlines: boolean;
  willQueue: boolean;
  /** Stop was pressed on its receipt. */
  stopped?: boolean;
  /** The worker's closing words when it last stopped on a question or a
   *  refusal (UNTRUSTED agent text, capped). */
  lastQuestion?: string;
  /** Turn ends to ignore: the agent was mid-turn at delivery, so the next
   *  Stop ends the turn it was already in, not the hand-off's. */
  skipStops?: number;
  /** The worker's last turn end on this task without a question: when, and
   *  its closing words (UNTRUSTED agent text, capped). What lets the HQ close
   *  the task, and what the task result carries. */
  lastStop?: { at: number; text: string };
  /** The HQ closed the task itself (requesterComplete). */
  closedByHq?: boolean;
  /** Why the card asks instead of delivering on its own. */
  askReason?: HandoffAskReason;
  /** The open task this card follows up (it answers that task's question):
   *  the card is moot once that task ends, and only then. */
  followsTaskId?: string;
  /** The worker was seen mid-turn (agent status) since its last turn end. */
  sawRunning?: boolean;
  /** wmux itself ended the task (not the operator): its pane closed or its
   *  agent left, or a newer hand-off to the same pane replaced it. */
  internalCancel?: 'pane-gone' | 'replaced';
  /** The target's repository (`git rev-parse --show-toplevel` of its pane,
   *  taken at delivery and vetted): the one place Moa's read gate may let it
   *  read without asking (moaReadGate.ts). Absent = unverifiable, it asks. */
  repoRoot?: string;
  /** When the task ended (completed, failed or canceled). */
  endedAt?: number;
  createdAt: number;
  at: number;
}

/** A target pane as main resolved it. */
export interface ResolvedTarget {
  workspaceId: string;
  paneId: string;
  surfaceId?: string;
  ptyId: string;
  agentName: string | null;
  agentStatus: AgentStatus | null;
}

export type ProposeResult =
  | { ok: true; mode: 'card'; id: string }
  | { ok: true; mode: 'auto'; id: string; taskId: string }
  | {
      ok: false;
      error: 'moa_off' | 'not_hq' | 'busy' | 'task_open' | 'target_is_hq' | 'no_target' | 'no_agent' | 'body_empty' | 'body_too_long' | 'error';
      message?: string;
    };

export interface MoaHandoffPorts {
  hqWorkspaceId: () => string | null;
  /** Moa on, the HQ designated and present. */
  moaReady: () => boolean;
  modeOf: (workspaceId: string) => AgentMode;
  /** Settings › Moa › auto hand-off (absent = on). */
  autoHandoffEnabled: () => boolean;
  /** The operator asked Moa for something in this request (a live direct
   *  request), so the body is Moa's reading of the operator, not a relay of a
   *  wake's outside text. False ⇒ the auto path is not taken. */
  hqServesOperatorRequest: () => boolean;
  workspaceExists: (workspaceId: string) => boolean;
  workspaceName: (workspaceId: string) => string | undefined;
  resolveTarget: (sel: { ptyId?: string; paneId?: string }) => Promise<ResolvedTarget | null>;
  /** The pane's state in the workspace mirror: gone, a shell, or an agent.
   *  `unknown` when the mirror cannot tell (no fresh snapshot). */
  paneState: (workspaceId: string, ptyId: string) => 'gone' | 'shell' | 'agent' | 'unknown';
  /** The pane's agent is mid-turn right now (mirror status), when known. */
  agentBusy?: (workspaceId: string, ptyId: string) => boolean | undefined;
  /** The same reading with the moment it was sampled (the mirror snapshot's
   *  time), for the turn-end sweep. `blocked`: the agent sits on a permission
   *  prompt, which is mid-turn, never a turn end. Absent: agentBusy, read as
   *  sampled now. */
  agentSample?: (workspaceId: string, ptyId: string) => { busy: boolean; blocked?: boolean; at: number } | undefined;
  /** The operator canceled a card (no task exists to say so): tell the HQ. */
  onOperatorCancel?: (r: HandoffRecord) => void;
  decisions: {
    raiseIfFree: (
      workspaceId: string,
      card: { question: string; options: string[]; context: string; origin: DecisionOrigin; ref: string },
    ) => Promise<WorkspaceDecision | null>;
    load: (workspaceId: string) => WorkspaceDecision | null;
    resolve: (workspaceId: string, id: string, resolution: string) => Promise<WorkspaceDecision | null>;
    clearResolved: (workspaceId: string, id: string) => Promise<void>;
    clearPendingIfUnchanged: (workspaceId: string, expected: WorkspaceDecision) => Promise<boolean>;
  };
  links: {
    upsert: (input: WorkLinkUpsert) => Promise<WorkLink | null>;
    setState: (id: string, state: WorkLinkState, reason?: WorkLinkReason) => Promise<WorkLink | null>;
    setLastQuestion: (id: string, q: { text: string; at: number }) => Promise<void>;
  };
  /** The operator-lane RPC (main's own; never an external caller's). */
  invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  deliver: (args: {
    target: HandoffTarget;
    title: string;
    message: string;
    workLinkId?: string;
    guardKey?: string;
    presetTaskId?: string;
  }) => Promise<OperatorTaskDelivery>;
  release: (linkId: string | undefined, taskId: string | undefined) => Promise<void>;
  /** The vetted repository root of the pane (moaReadGate.resolveRepoRoot),
   *  or null when it cannot be verified. Read once, at delivery. */
  repoRootOf?: (workspaceId: string, ptyId: string) => Promise<string | null>;
  /** The canonical state of an A2A task (the operator's), null when it does
   *  not exist, undefined when it could not be read. */
  taskState?: (taskId: string) => Promise<string | null | undefined>;
  registerCheck: (key: string, check: DeliveryCheck) => () => void;
  /** Something Moa's panel shows moved (cards, receipts). */
  notify?: () => void;
  autoPerHour?: () => number;
  /** The active goal contract covering `workspaceId`, read at the moment of
   *  use (moaGoalContract.covers). Absent or null: no goal path. */
  goalCovers?: (workspaceId: string) => { goalId: string; humanOnly: readonly string[] } | null;
  now?: () => number;
  filePath?: string;
}

export function getMoaHandoffsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'moa-handoffs.json');
}

/** One line of card text: control and format characters become spaces. */
function oneLine(raw: string, max: number): string {
  const clean = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : clean;
}

/** The hand-off's title: the one Moa gave, else the body's first line. */
export function handoffTitle(title: unknown, body: string): string {
  const given = typeof title === 'string' ? oneLine(title, TITLE_MAX) : '';
  if (given) return given;
  const first = body.trim().split('\n').find((l) => l.trim()) ?? '';
  return oneLine(first, TITLE_MAX) || 'Task from Moa';
}

/** The agent takes no multi-line paste (the renderer folds newlines for an
 *  agent it cannot name as a known TUI). */
export function foldsNewlines(agentName: string | null): boolean {
  return !resolveAgentSlug(agentName ?? undefined);
}

/** Cut to `max` UTF-8 bytes on a character boundary. */
function capBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = enc.encode(ch).length;
    if (n + b > max - 3) break;
    out += ch;
    n += b;
  }
  return `${out}…`;
}

// Refusal phrasing, read only when the turn ended without a question mark.
const REFUSAL_RE =
  /\b(?:I\s+(?:can(?:not|'t|’t)|won(?:'|’)t|will\s+not|am\s+not\s+(?:able|going)\s+to|(?:must|have\s+to)\s+decline|decline)|I'm\s+not\s+(?:able|going)\s+to|not\s+(?:an?\s+)?(?:instruction|request)\s+from\s+(?:you|the\s+(?:user|operator)))\b/i;

/** Did the worker's closing words end on a refusal? A heuristic on agent
 *  text: it only decides whether to ask Moa to look, never anything else. */
export function looksLikeRefusal(text: string): boolean {
  return REFUSAL_RE.test(text.slice(-HANDOFF_PREVIEW_CHARS * 2));
}

/** The card's question and context. Fixed templates around Moa's text. */
export function buildHandoffCard(r: Pick<HandoffRecord, 'title' | 'body' | 'target' | 'foldsNewlines' | 'willQueue'>, workspaceName: string): {
  question: string;
  options: string[];
  context: string;
} {
  const agent = oneLine(r.target.agentName || 'the agent', 40);
  // By code point, so a cut never splits a surrogate pair.
  const chars = [...r.body];
  const preview = chars.length > HANDOFF_PREVIEW_CHARS ? `${chars.slice(0, HANDOFF_PREVIEW_CHARS).join('')}… (the whole text is in Moa's panel)` : r.body;
  const notes: string[] = [];
  if (r.foldsNewlines) notes.push(`${agent} takes one line: line breaks will be joined with " — ".`);
  if (r.willQueue) notes.push(`${agent} is working right now: the hand-off will queue behind its current turn.`);
  return {
    question: `Moa proposes handing "${r.title}" to ${agent} in ${oneLine(workspaceName, 60)}. Hand it off as your instruction?`,
    options: [HANDOFF_OPTIONS.handOff, HANDOFF_OPTIONS.edit, HANDOFF_OPTIONS.cancel],
    context: [...notes, `Moa wrote: ${preview}`].join('\n'),
  };
}

interface HandoffFile {
  version: 1;
  items: Record<string, HandoffRecord>;
}

function readFile(p: string): HandoffFile {
  const empty: HandoffFile = { version: 1, items: {} };
  let raw: unknown;
  try {
    raw = atomicReadJSONSync(p);
  } catch {
    return empty;
  }
  const items = (raw as { items?: unknown } | null)?.items;
  if (!items || typeof items !== 'object') return empty;
  for (const [k, v] of Object.entries(items as Record<string, unknown>)) {
    const r = v as Partial<HandoffRecord> | null;
    if (r && r.id === k && typeof r.hqWorkspaceId === 'string' && r.target && typeof r.target.ptyId === 'string'
      && typeof r.target.workspaceId === 'string' && typeof r.target.paneId === 'string'
      && typeof r.target.agentName === 'string' && typeof r.title === 'string'
      && typeof r.body === 'string' && typeof r.state === 'string' && typeof r.createdAt === 'number') {
      empty.items[k] = r as HandoffRecord;
    }
  }
  return empty;
}

let service: MoaHandoffService | null = null;
/** The running service (deck.handler installs it), or null. */
export function getMoaHandoffService(): MoaHandoffService | null {
  return service;
}
export function setMoaHandoffService(s: MoaHandoffService | null): void {
  service = s;
}

export class MoaHandoffService {
  private loaded: HandoffFile | null = null;
  private readonly serialize = createSerialChain();
  private readonly answering = new Set<string>();

  constructor(private readonly ports: MoaHandoffPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private get file(): HandoffFile {
    if (!this.loaded) this.loaded = readFile(this.ports.filePath ?? getMoaHandoffsPath());
    return this.loaded;
  }

  private notify(): void {
    try {
      this.ports.notify?.();
    } catch {
      /* best-effort */
    }
  }

  private put(r: HandoffRecord): void {
    const ended = isEnded(r.taskState) && r.endedAt === undefined ? { endedAt: this.now() } : {};
    this.file.items[r.id] = { ...r, ...ended, at: this.now() };
    const all = Object.values(this.file.items);
    if (all.length <= MAX_RECORDS) return;
    const old = all
      .filter((x) => x.id !== r.id && (x.state === 'canceled' || x.state === 'failed' || x.state === 'expired' || (x.state === 'delivered' && isEnded(x.taskState))))
      .sort((a, b) => a.at - b.at);
    for (const x of old.slice(0, all.length - MAX_RECORDS)) delete this.file.items[x.id];
  }

  /** Persist. A failed write is logged and reported (false); memory stays the truth. */
  save(): Promise<boolean> {
    return this.serialize(async () => {
      try {
        await atomicWriteJSON(this.ports.filePath ?? getMoaHandoffsPath(), this.file);
        return true;
      } catch (err) {
        console.warn(`[moa:handoff] could not save: ${String(err)}`);
        return false;
      }
    });
  }

  /** One proposal at a time: the hourly auto count is read and taken in one
   *  step, and two calls can never deliver side by side. */
  private readonly proposals = createSerialChain();

  get(id: string): HandoffRecord | null {
    return this.file.items[id] ?? null;
  }

  byDecision(decisionId: string): HandoffRecord | null {
    return Object.values(this.file.items).find((r) => r.decisionId === decisionId) ?? null;
  }

  byTask(taskId: string): HandoffRecord | null {
    return Object.values(this.file.items).find((r) => r.taskId === taskId) ?? null;
  }

  /** Panes holding an open hand-off task: ptyId → where, and the agent. */
  openTargets(): Map<string, { workspaceId: string; agentName: string }> {
    const out = new Map<string, { workspaceId: string; agentName: string }>();
    for (const r of Object.values(this.file.items)) {
      if (r.state === 'delivered' && r.taskId && !isEnded(r.taskState)) {
        out.set(r.target.ptyId, { workspaceId: r.target.workspaceId, agentName: r.target.agentName });
      }
    }
    return out;
  }

  /** What Moa's read roots are made of (moaReadGate.computeReadRoots): the
   *  current HQ's delivered hand-offs that carry a vetted repository. */
  readRootSources(): Array<{ repoRoot?: string; taskId?: string; open: boolean; endedAt?: number; paneGone?: boolean }> {
    const hq = this.ports.hqWorkspaceId();
    return Object.values(this.file.items)
      .filter((r) => r.hqWorkspaceId === hq && r.state === 'delivered' && r.taskId && r.repoRoot)
      .map((r) => ({
        repoRoot: r.repoRoot,
        taskId: r.taskId,
        open: !isEnded(r.taskState),
        ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
        ...(r.internalCancel === 'pane-gone' ? { paneGone: true } : {}),
      }));
  }

  /** The HQ closed this hand-off task itself (requesterComplete). */
  closedByHq(taskId: string): boolean {
    return this.byTask(taskId)?.closedByHq === true;
  }

  /** The HQ a hand-off task reports to, or null when the task is not one. */
  hqForTask(taskId: string): string | null {
    const hq = this.byTask(taskId)?.hqWorkspaceId ?? null;
    // An HQ that is no longer the HQ runs no brain: report to the current one.
    return hq && hq === this.ports.hqWorkspaceId() ? hq : null;
  }

  /** What Moa's wake for a hand-off task carries, or null when the task is
   *  not one. The question is the worker's own text: untrusted. */
  handoffDetail(taskId: string): { question?: string; internalCancel?: 'pane-gone' | 'replaced'; goalId?: string } | null {
    const r = this.byTask(taskId);
    if (!r) return null;
    if (r.internalCancel) return { internalCancel: r.internalCancel };
    // Delivered under a goal the operator approved: the wake may say so.
    const goal = r.goalId ? { goalId: r.goalId } : {};
    if (!r.lastQuestion || r.taskState !== 'input-required') return goal;
    // The question is where the worker ended: keep the END of its closing
    // words, which the wake's quote would otherwise cut off.
    const chars = [...r.lastQuestion];
    return { question: chars.length > WAKE_QUESTION_CHARS ? `…${chars.slice(-WAKE_QUESTION_CHARS).join('')}` : r.lastQuestion, ...goal };
  }

  /** The HQ is waiting on a hand-off it proposed: a card the operator has not
   *  answered, or a delivered task still open. Its Stop gate lets it end the
   *  turn (it is woken when that changes), the way a pending decision does,
   *  without the decision that would hold back its wakes. */
  waitingOnHandoff(hqWorkspaceId: string): boolean {
    return Object.values(this.file.items).some(
      (r) => r.hqWorkspaceId === hqWorkspaceId
        && ((r.state === 'pending' && !r.notice && !!r.decisionId) || r.state === 'delivering' || (r.state === 'delivered' && !isEnded(r.taskState))),
    );
  }

  /** A hand-off task's state for deck_complete_work: 'open', 'settled' (it
   *  ended: completed, or failed/canceled — the operator's task, ended by the
   *  worker or the operator), or null when the task is not a hand-off. */
  handoffTaskStatus(taskId: string): 'open' | 'settled' | null {
    const r = this.byTask(taskId);
    if (!r) return null;
    if (r.state === 'failed' || r.state === 'canceled' || r.state === 'expired') return 'settled';
    return isEnded(r.taskState) ? 'settled' : 'open';
  }

  /** What the card in `decisionId` needs beyond the decision, or null. */
  cardInfo(decisionId: string): MoaHandoffCardInfo | null {
    const r = this.byDecision(decisionId);
    if (!r || r.state !== 'pending' || r.notice) return null;
    return {
      id: r.id,
      body: r.body,
      title: r.title,
      agentName: r.target.agentName,
      targetPaneId: r.target.paneId,
      targetPtyId: r.target.ptyId,
      foldsNewlines: r.foldsNewlines,
      // Live: "working right now" is about this moment, not when Moa proposed.
      willQueue: this.ports.agentBusy?.(r.target.workspaceId, r.target.ptyId) === true,
      ...(r.askReason ? { askReason: r.askReason } : {}),
    };
  }

  receipts(): MoaAutoHandoffReceipt[] {
    const since = this.now() - RECEIPT_TTL_MS;
    return Object.values(this.file.items)
      .filter((r) => r.auto && r.taskId && r.state === 'delivered' && !isEnded(r.taskState) && r.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        id: r.id,
        taskId: r.taskId as string,
        title: r.title,
        targetWorkspaceId: r.target.workspaceId,
        ...(this.ports.workspaceName(r.target.workspaceId) ? { targetWorkspaceName: this.ports.workspaceName(r.target.workspaceId) } : {}),
        targetPaneId: r.target.paneId,
        at: r.createdAt,
        ...(r.stopped ? { stopped: true } : {}),
      }));
  }

  // ── propose ───────────────────────────────────────────────────────────────

  propose(
    callerWorkspaceId: string,
    params: { ptyId?: unknown; paneId?: unknown; body?: unknown; title?: unknown; externalSource?: unknown },
  ): Promise<ProposeResult> {
    return this.proposals(() => this.proposeNow(callerWorkspaceId, params));
  }

  private async proposeNow(
    callerWorkspaceId: string,
    params: { ptyId?: unknown; paneId?: unknown; body?: unknown; title?: unknown; externalSource?: unknown },
  ): Promise<ProposeResult> {
    if (!this.ports.moaReady()) return { ok: false, error: 'moa_off' };
    const hq = this.ports.hqWorkspaceId();
    if (!hq || callerWorkspaceId !== hq) return { ok: false, error: 'not_hq' };
    const refusal = handoffBodyRefusal(params.body);
    if (refusal) return { ok: false, error: refusal };
    const body = (params.body as string).trim();
    const sel = {
      ...(typeof params.ptyId === 'string' && params.ptyId ? { ptyId: params.ptyId } : {}),
      ...(typeof params.paneId === 'string' && params.paneId ? { paneId: params.paneId } : {}),
    };
    if (!sel.ptyId && !sel.paneId) return { ok: false, error: 'no_target' };
    if (sel.ptyId && isBrainPtyId(sel.ptyId)) return { ok: false, error: 'target_is_hq' };
    const t = await this.ports.resolveTarget(sel).catch(() => null);
    if (!t) {
      console.warn(`[moa:handoff] no pane with an agent matches ${sel.ptyId ?? sel.paneId}`);
      return { ok: false, error: 'no_target' };
    }
    // A card in the HQ's own slot would stop Moa's own wake loop.
    if (t.workspaceId === hq || isBrainPtyId(t.ptyId)) return { ok: false, error: 'target_is_hq' };
    if (!t.agentName) return { ok: false, error: 'no_agent' };
    // One hand-off at a time per pane: while the agent is still working on the
    // last one, a second card would only repeat it. A task waiting on input is
    // different: a follow-up is how its question gets answered.
    // Another (former) HQ's open task blocks it outright: delivery would not
    // replace it, and two open tasks make every turn end ambiguous.
    const open = this.openTaskOnPty(t.ptyId);
    if (open && (open.hqWorkspaceId !== hq || open.taskState !== 'input-required')) {
      return {
        ok: false,
        error: 'task_open',
        message: `the agent is still working on "${open.title}"; you are woken when its turn ends`,
      };
    }
    const now = this.now();
    const follows = open?.taskId;
    const record: HandoffRecord = {
      id: randomUUID(),
      hqWorkspaceId: hq,
      target: {
        workspaceId: t.workspaceId,
        paneId: t.paneId,
        ptyId: t.ptyId,
        agentName: t.agentName,
        ...(t.surfaceId ? { surfaceId: t.surfaceId } : {}),
        ...(resolveAgentSlug(t.agentName) ? { agentSlug: resolveAgentSlug(t.agentName) } : {}),
      },
      title: handoffTitle(params.title, body),
      body,
      // Unsure counts as outside: only an explicit false from a call made
      // while the operator's own request is live is taken as Moa's text.
      externalSource: params.externalSource === true || !this.ports.hqServesOperatorRequest(),
      state: 'pending',
      foldsNewlines: foldsNewlines(t.agentName),
      willQueue: t.agentStatus === 'running',
      ...(follows ? { followsTaskId: follows } : {}),
      createdAt: now,
      at: now,
    };
    // GOAL PATH: a workspace an approved goal covers takes the hand-off without
    // a card, unless Moa itself said the body carries outside text or the body
    // asks for something that stays the operator's (shared/moaGoal.ts). The
    // operator's turn is not required here: approving the goal is the grant
    // to follow it through on wakes. Anything short of a delivery falls back
    // to the card, exactly like the danger path.
    const goal = params.externalSource === true ? null : this.goalAllows(record);
    if (goal) {
      const res = await this.deliver({ ...record, goalId: goal }, body, true);
      if (res.delivered && res.taskId) return { ok: true, mode: 'auto', id: record.id, taskId: res.taskId };
      console.warn(`[moa:handoff] goal hand-off to ${t.workspaceId} did not go through (${res.why}); asking with a card`);
      record.state = 'pending';
      record.auto = undefined;
      record.goalId = undefined;
      record.taskId = undefined;
      record.linkId = undefined;
      record.id = randomUUID();
      record.askReason = 'delivery-failed';
      return this.raiseCard(record);
    }
    if (this.autoAllowed(record)) {
      const res = await this.deliver(record, body, true);
      if (res.delivered && res.taskId) return { ok: true, mode: 'auto', id: record.id, taskId: res.taskId };
      // Anything short of a delivery (a mode flipped mid-way, the agent
      // left, someone typed) falls back to the card.
      console.warn(`[moa:handoff] auto hand-off to ${t.workspaceId} did not go through (${res.why}); asking with a card`);
      record.state = 'pending';
      record.auto = undefined;
      record.taskId = undefined;
      record.linkId = undefined;
      // The failed try is kept as what it was (a canceled task, no receipt)
      // under its own id; the card below is a new record.
      record.id = randomUUID();
      record.askReason = 'delivery-failed';
    } else {
      record.askReason = this.askReasonOf(record);
    }
    return this.raiseCard(record);
  }

  private async raiseCard(record: HandoffRecord): Promise<ProposeResult> {
    const ws = record.target.workspaceId;
    const card = buildHandoffCard(record, this.ports.workspaceName(ws) ?? ws);
    const decision = await this.ports.decisions
      .raiseIfFree(ws, { ...card, origin: 'moa-handoff', ref: record.id })
      .catch(() => null);
    if (!decision) return { ok: false, error: 'busy' };
    this.put({ ...record, state: 'pending', decisionId: decision.id });
    if (!(await this.save())) {
      // A card whose body is not on disk could not be answered after a restart.
      await this.ports.decisions.clearPendingIfUnchanged(ws, decision).catch(() => false);
      delete this.file.items[record.id];
      return { ok: false, error: 'error', message: 'the hand-off could not be saved' };
    }
    this.notify();
    return { ok: true, mode: 'card', id: record.id };
  }

  // ── danger-mode auto path ───────────────────────────────────────────────────

  /** The auto rule, from the stores at this moment. Never a brain's word. */
  private autoRuleHolds(r: Pick<HandoffRecord, 'hqWorkspaceId' | 'target' | 'externalSource'>): boolean {
    return (
      this.ports.autoHandoffEnabled()
      && !r.externalSource
      && this.ports.hqWorkspaceId() === r.hqWorkspaceId
      && this.ports.modeOf(r.target.workspaceId) === 'danger'
      && this.ports.modeOf(r.hqWorkspaceId) === 'danger'
    );
  }

  /** Which part of the auto rule sends this hand-off to a card. */
  private askReasonOf(r: HandoffRecord): HandoffAskReason {
    // Moa moved to another workspace since this was proposed.
    if (this.ports.hqWorkspaceId() !== r.hqWorkspaceId) return 'hq-moved';
    // The most basic reason first: outside danger mode nothing goes on its own.
    if (this.ports.modeOf(r.target.workspaceId) !== 'danger' || this.ports.modeOf(r.hqWorkspaceId) !== 'danger') return 'not-danger';
    if (!this.ports.autoHandoffEnabled()) return 'auto-off';
    if (r.externalSource) return 'external';
    return 'hourly-cap';
  }

  /** The goal rule, from the stores at this moment: the id of the active goal
   *  that covers the target, when the body passes its hard rules and the
   *  target's hourly auto cap has room. Never a brain's word. */
  private goalAllows(r: HandoffRecord): string | null {
    if (this.ports.hqWorkspaceId() !== r.hqWorkspaceId) return null;
    const cover = this.goalRuleHolds(r);
    if (!cover) return null;
    return this.autoCapRoom(r) ? cover : null;
  }

  private goalRuleHolds(r: Pick<HandoffRecord, 'hqWorkspaceId' | 'target' | 'body'>): string | null {
    const cover = this.ports.goalCovers?.(r.target.workspaceId) ?? null;
    if (!cover || this.ports.hqWorkspaceId() !== r.hqWorkspaceId) return null;
    return goalHardRuleHit(r.body, cover.humanOnly) ? null : cover.goalId;
  }

  private autoCapRoom(r: HandoffRecord): boolean {
    const since = this.now() - HOUR_MS;
    const limit = this.ports.autoPerHour?.() ?? HANDOFF_AUTO_PER_HOUR_DEFAULT;
    const recent = Object.values(this.file.items).filter(
      (x) => x.auto && (x.state === 'delivered' || x.state === 'delivering') && x.target.workspaceId === r.target.workspaceId && x.createdAt >= since,
    ).length;
    return recent < limit;
  }

  private autoAllowed(r: HandoffRecord): boolean {
    if (!this.autoRuleHolds(r)) return false;
    const since = this.now() - HOUR_MS;
    const limit = this.ports.autoPerHour?.() ?? HANDOFF_AUTO_PER_HOUR_DEFAULT;
    const recent = Object.values(this.file.items).filter(
      (x) => x.auto && (x.state === 'delivered' || x.state === 'delivering') && x.target.workspaceId === r.target.workspaceId && x.createdAt >= since,
    ).length;
    return recent < limit;
  }

  // ── delivery ──────────────────────────────────────────────────────────────

  private async deliver(
    record: HandoffRecord,
    body: string,
    auto: boolean,
  ): Promise<{ delivered: boolean; taskId?: string; why: string; note?: string }> {
    const taskId = generateId('task');
    const link = await this.ports.links.upsert({
      origin: auto ? 'moa-auto' : 'moa',
      owner: { workspaceId: record.target.workspaceId, paneId: record.target.paneId },
      requester: { workspaceId: record.hqWorkspaceId },
      title: record.title,
      ...(record.target.agentSlug ? { agent: record.target.agentSlug } : {}),
    }).catch(() => null);
    // Recorded before the send: the task's first events must already route to Moa.
    const busy = this.ports.agentBusy?.(record.target.workspaceId, record.target.ptyId) === true;
    const sending: HandoffRecord = {
      ...record, body, state: 'delivering', taskId, at: this.now(),
      ...(link ? { linkId: link.id } : {}), ...(auto ? { auto: true } : {}), ...(busy ? { skipStops: 1 } : {}),
    };
    this.put(sending);
    if (!(await this.save())) {
      // Without the record on disk, a restart mid-delivery could not tell
      // whose task this is: deliver nothing.
      await this.ports.release(link?.id, undefined).catch(() => undefined);
      this.put({ ...record, state: 'failed' });
      return { delivered: false, why: 'the hand-off could not be saved' };
    }
    let unregister = (): void => undefined;
    let guardKey: string | undefined;
    if (auto) {
      guardKey = `moa-auto-${record.id}`;
      const check = (): string | null =>
        record.goalId
          ? this.goalRuleHolds({ ...record, body }) === record.goalId ? null : 'the goal ended or no longer covers this workspace'
          : this.autoRuleHolds(record) ? null : 'a workspace mode or the auto hand-off setting changed';
      unregister = this.ports.registerCheck(guardKey, { beforePaste: check, beforeEnter: check });
    }
    let sent: OperatorTaskDelivery;
    try {
      sent = await this.ports.deliver({
        target: record.target,
        title: `Moa: ${record.title}`,
        message: buildHandoffText(body, taskId, auto, record.goalId),
        ...(link ? { workLinkId: link.id } : {}),
        ...(guardKey ? { guardKey } : {}),
        presetTaskId: taskId,
      });
    } catch (err) {
      sent = { ok: false, code: 'error', message: err instanceof Error ? err.message : String(err) };
    } finally {
      unregister();
    }
    if (!sent.ok || !sent.delivered) {
      await this.ports.release(link?.id, sent.ok ? (sent.taskId ?? taskId) : taskId).catch(() => undefined);
      this.put({ ...sending, state: 'failed' });
      await this.save();
      const why = sent.ok ? (sent.reason ?? sent.note ?? 'not delivered') : sent.message;
      return { delivered: false, why, ...(sent.ok && sent.note ? { note: sent.note } : {}) };
    }
    // Re-read: the task's own events (a fast completion, a question) may have
    // landed while the send was still answering; never roll them back.
    const latest = this.get(record.id) ?? sending;
    const delivered: HandoffRecord = {
      ...latest, state: 'delivered', taskId: sent.taskId ?? taskId,
      taskState: latest.taskState ?? 'submitted',
    };
    this.put(delivered);
    // A new hand-off to the same pane replaces the one still open there (a
    // follow-up answers it): end the older task so the pane holds one, and a
    // turn end is never ambiguous between two.
    for (const old of this.openTasksOnPty(record.target.ptyId)) {
      if (old.id === delivered.id || old.hqWorkspaceId !== delivered.hqWorkspaceId) continue;
      await this.cancelTask(old, 'replaced');
    }
    // The worker is a TUI agent that may never report its own state: the task
    // is under way once the text landed, and only from 'working' can a later
    // question move it to input-required.
    if (delivered.taskState === 'submitted') await this.moveTask(delivered, 'working');
    // Where Moa may later read the result without a prompt. Unverifiable
    // (no repository, $HOME, …) leaves it out: those reads keep asking.
    const repoRoot = await this.ports.repoRootOf?.(record.target.workspaceId, record.target.ptyId).catch(() => null);
    if (repoRoot) this.put({ ...(this.get(record.id) ?? delivered), repoRoot });
    if (!(await this.save()) && !(await this.save())) {
      // The text landed; the disk still says "delivering". Memory holds the
      // truth for this run, and after a restart reconcile() settles the record
      // from the task's canonical state instead of assuming either outcome.
      console.warn(`[moa:handoff] ${record.id} was delivered but could not be saved; it is settled from the task state after a restart`);
    }
    this.notify();
    return { delivered: true, taskId: delivered.taskId, why: 'delivered', ...(sent.note ? { note: sent.note } : {}) };
  }

  // ── the operator's answer ─────────────────────────────────────────────────

  /**
   * The operator answered card `decisionId` in `workspaceId`. By id only: the
   * body is this store's, unless the operator edited it (`editedBody`, their
   * own input). Returns null when the decision is not a hand-off card.
   */
  async resolve(
    workspaceId: string,
    decisionId: string,
    action: 'handoff' | 'cancel' | 'ack',
    editedBody?: string,
  ): Promise<MoaHandoffResolveResult | null> {
    const r = this.byDecision(decisionId);
    if (!r || r.target.workspaceId !== workspaceId) return null;
    const d = this.ports.decisions.load(workspaceId);
    if (!d || d.id !== decisionId || d.status !== 'pending') return { ok: false, code: 'not_pending' };
    if (this.answering.has(decisionId)) return { ok: false, code: 'not_pending' };
    let body = r.body;
    if (action === 'handoff' && editedBody !== undefined) {
      const refusal = handoffBodyRefusal(editedBody);
      if (refusal) return { ok: false, code: refusal };
      body = editedBody.trim();
    }
    this.answering.add(decisionId);
    try {
      const label = r.notice ? HANDOFF_NOTICE_OPTION : action === 'handoff' ? HANDOFF_OPTIONS.handOff : HANDOFF_OPTIONS.cancel;
      // Claim the card first: a second click (or another window) finds it gone.
      const claimed = await this.ports.decisions.resolve(workspaceId, decisionId, label).catch(() => null);
      if (!claimed) return { ok: false, code: 'not_pending' };
      await this.ports.decisions.clearResolved(workspaceId, decisionId).catch(() => undefined);
      if (r.notice) {
        this.put({ ...r, decisionId: undefined, notice: undefined });
        await this.save();
        this.notify();
        return { ok: true, delivered: false };
      }
      if (action !== 'handoff') {
        this.put({ ...r, state: 'canceled', decisionId: undefined });
        await this.save();
        this.notify();
        try {
          this.ports.onOperatorCancel?.(r);
        } catch {
          /* best-effort */
        }
        return { ok: true, delivered: false };
      }
      const res = await this.deliver({ ...r, decisionId: undefined }, body, false);
      if (!res.delivered) {
        await this.raiseNotice(this.get(r.id) ?? r, res.why);
        return { ok: true, delivered: false, note: res.why };
      }
      return { ok: true, delivered: true, ...(res.taskId ? { taskId: res.taskId } : {}), ...(res.note ? { note: res.note } : {}) };
    } finally {
      this.answering.delete(decisionId);
    }
  }

  /** A notice card in the target slot saying the hand-off did not go through.
   *  Only while the workspace exists: never in the HQ's slot. */
  private async raiseNotice(r: HandoffRecord, why: string): Promise<void> {
    const ws = r.target.workspaceId;
    if (!this.ports.workspaceExists(ws) || ws === this.ports.hqWorkspaceId()) return;
    const d = await this.ports.decisions
      .raiseIfFree(ws, {
        question: `Could not hand off "${r.title}" to ${oneLine(r.target.agentName, 40)}: ${oneLine(why, 200)}`,
        options: [HANDOFF_NOTICE_OPTION],
        context: 'Nothing was submitted, and the task was canceled. Ask Moa again, or give the agent the work yourself.',
        origin: 'moa-handoff',
        ref: r.id,
      })
      .catch(() => null);
    if (d) {
      this.put({ ...r, decisionId: d.id, notice: true });
      await this.save();
    }
    this.notify();
  }

  // ── feedback ──────────────────────────────────────────────────────────────

  /** An A2A state for a task: kept on the record. Returns the HQ to route the
   *  event to, or null when the task is not a hand-off. */
  noteTaskState(taskId: string, state: string): string | null {
    const r = this.byTask(taskId);
    if (!r) return null;
    if (r.taskState !== state) {
      this.put({ ...r, taskState: state });
      void this.save();
      // Ended any way (done, failed, canceled): a follow-up card for it is moot.
      if (isEnded(state)) void this.closeMootCards(r.hqWorkspaceId, { taskId });
    }
    return this.hqForTask(taskId);
  }

  /** The open hand-off task in this pane (the newest), or null. */
  openTaskOnPty(ptyId: string): HandoffRecord | null {
    return this.openTasksOnPty(ptyId)[0] ?? null;
  }

  private openTasksOnPty(ptyId: string): HandoffRecord[] {
    return Object.values(this.file.items)
      .filter((r) => r.target.ptyId === ptyId && r.state === 'delivered' && r.taskId && !isEnded(r.taskState))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * A worker turn ended in a pane holding an open hand-off task. Claude's Stop
   * hook gives the closing words (`lastMessage`, UNTRUSTED). A question or a
   * refusal, with the task still submitted/working, moves the task to
   * input-required; that event then wakes Moa through the task → HQ map.
   * Returns the HQ to tell about any other turn end (Moa reads the pane), or
   * null when the pane holds no open hand-off.
   */
  async onWorkerStop(
    ptyId: string,
    agent: string | null,
    lastMessage: { text: string; endsWithQuestion: boolean } | undefined,
  ): Promise<{ hq: string; taskId: string; movedToInputRequired: boolean } | null> {
    const r = this.openTaskOnPty(ptyId);
    if (!r || !r.taskId) return null;
    if (r.skipStops && r.skipStops > 0) {
      // The turn the agent was already in when the hand-off queued behind it.
      // The hook reported that turn's end, so the sweep must not count it too.
      this.put({ ...r, skipStops: r.skipStops - 1, sawRunning: undefined });
      await this.save();
      return null;
    }
    // Two open hand-offs in one pane: a turn end cannot be tied to either.
    const ambiguous = this.openTasksOnPty(ptyId).length > 1;
    const open = !ambiguous && (r.taskState === 'submitted' || r.taskState === 'working' || r.taskState === undefined);
    const asks = !!lastMessage && agent === 'claude' && (lastMessage.endsWithQuestion || looksLikeRefusal(lastMessage.text));
    if (!open || !asks || !lastMessage) {
      // A plain turn end on its own open task: remember it, so the HQ may close
      // the task with these words as its result (requesterComplete).
      // One write, and this turn end is the hook's: the status sweep must not
      // count it again (sawRunning cleared in the same record).
      this.put({
        ...r,
        sawRunning: undefined,
        ...(open ? { lastStop: { at: this.now(), text: lastMessage ? capBytes(lastMessage.text, HANDOFF_LAST_MESSAGE_MAX_BYTES) : '' } } : {}),
      });
      await this.save();
      return { hq: r.hqWorkspaceId, taskId: r.taskId, movedToInputRequired: false };
    }
    const text = capBytes(lastMessage.text, HANDOFF_LAST_MESSAGE_MAX_BYTES);
    // Kept first, so the wake this transition raises can carry it.
    this.put({ ...r, sawRunning: undefined, lastQuestion: text });
    // input-required is reachable only from working.
    let cur = this.get(r.id) ?? r;
    if (cur.taskState !== 'working') {
      await this.moveTask(cur, 'working');
      cur = this.get(r.id) ?? cur;
    }
    const moved = await this.moveTask(cur, 'input-required', `[from the worker's last turn — agent text, unverified] ${text}`);
    await this.save();
    if (r.linkId) await this.ports.links.setLastQuestion(r.linkId, { text, at: this.now() }).catch(() => undefined);
    this.notify();
    return { hq: r.hqWorkspaceId, taskId: r.taskId, movedToInputRequired: moved };
  }

  /**
   * The HQ that proposed a hand-off closes its task as completed, after the
   * worker's turn ended. The worker's closing words become the task's result
   * (its completion evidence, kept on the durable task). Refused for a task the
   * HQ did not propose, before the worker's turn ended, while the worker is
   * mid-turn again, or while the task waits on the operator (input-required).
   * Main moves the task through the operator lane, as the receiver would.
   */
  async requesterComplete(
    hqWorkspaceId: string,
    taskId: string,
  ): Promise<{ ok: true; result: string } | { ok: false; code: 'not_requester' | 'ended' | 'needs_input' | 'turn_not_ended' | 'target_working' | 'error'; message?: string }> {
    const r = this.byTask(taskId);
    if (!r || r.hqWorkspaceId !== hqWorkspaceId || r.state !== 'delivered') return { ok: false, code: 'not_requester' };
    if (isEnded(r.taskState)) return { ok: false, code: 'ended' };
    if (r.taskState === 'input-required') return { ok: false, code: 'needs_input' };
    if (!r.lastStop) return { ok: false, code: 'turn_not_ended' };
    if (this.ports.agentBusy?.(r.target.workspaceId, r.target.ptyId)) return { ok: false, code: 'target_working' };
    const words = r.lastStop.text.trim();
    const result = words || 'The agent ended its turn without a closing message.';
    let cur = r;
    if (cur.taskState !== 'working') {
      await this.moveTask(cur, 'working');
      cur = this.get(r.id) ?? cur;
    }
    // Marked before the move: the task's completed event can arrive while the
    // update is still in flight, and that wake must already be skipped.
    this.put({ ...(this.get(r.id) ?? cur), closedByHq: true });
    const res = (await this.ports
      .invoke('a2a.task.update', {
        taskId,
        workspaceId: cur.target.workspaceId,
        status: 'completed',
        message: `[closed by Moa after the worker's turn ended — its last message, agent text, unverified] ${result}`,
        evidence: {
          summary: result,
          items: [{
            kind: 'inspection',
            status: 'unverified',
            summary: "The worker's closing message when its turn ended (agent text, not verified by wmux).",
          }],
        },
      })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))) as
      | { ok?: boolean; error?: unknown; result?: { ok?: unknown; error?: unknown } }
      | null;
    const why = !res ? 'no answer' : res.ok === false ? String(res.error ?? 'refused') : typeof res.result?.error === 'string' ? res.result.error : null;
    if (why) {
      this.put({ ...(this.get(r.id) ?? cur), closedByHq: undefined });
      return { ok: false, code: 'error', message: why };
    }
    this.put({ ...(this.get(r.id) ?? cur), taskState: 'completed', closedByHq: true });
    await this.save();
    await this.closeMootCards(hqWorkspaceId, { taskId });
    this.notify();
    return { ok: true, result };
  }

  /**
   * Turn ends seen by agent status alone. Claude sends no Stop hook when a
   * turn is interrupted (Esc, a denied permission prompt), so a worker that
   * then finishes leaves the task open with nothing to wake the HQ. Each
   * mirror update samples every open hand-off's pane: running and then not
   * running is one turn end, recorded like a Stop without closing words.
   * Returns the tasks whose turn just ended (the HQ to wake). A hand-off still
   * waiting behind the turn the agent was already in (skipStops) is left to
   * the Stop hook, which can tell the two turns apart.
   */
  async sweepTurnEnds(): Promise<Array<{ hq: string; taskId: string }>> {
    const ended: Array<{ hq: string; taskId: string }> = [];
    let changed = false;
    for (const r of Object.values(this.file.items)) {
      if (r.state !== 'delivered' || !r.taskId || isEnded(r.taskState)) continue;
      if (r.taskState === 'input-required') continue;
      if (this.openTasksOnPty(r.target.ptyId).length > 1) continue;
      const sample = this.ports.agentSample?.(r.target.workspaceId, r.target.ptyId)
        ?? ((busy): { busy: boolean; blocked?: boolean; at: number } | undefined => (busy === undefined ? undefined : { busy, at: this.now() }))(this.ports.agentBusy?.(r.target.workspaceId, r.target.ptyId));
      if (!sample) continue;
      // Waiting on a permission prompt is mid-turn: never a turn end, but
      // evidence of a turn under way (the first sample after delivery can be
      // the prompt itself).
      if (sample.busy || sample.blocked) {
        // Running evidence older than the last turn end is about that turn.
        if (!r.sawRunning && (!r.lastStop || sample.at > r.lastStop.at)) { this.put({ ...r, sawRunning: true }); changed = true; }
        continue;
      }
      if (!r.sawRunning) continue;
      if (r.skipStops && r.skipStops > 0) {
        // The turn the agent was in when the hand-off queued behind it ended
        // with no Stop (interrupted): it is that turn's end, not the hand-off's.
        this.put({ ...r, sawRunning: undefined, skipStops: r.skipStops - 1 });
        changed = true;
        continue;
      }
      this.put({ ...r, sawRunning: undefined, lastStop: { at: this.now(), text: '' } });
      changed = true;
      ended.push({ hq: r.hqWorkspaceId, taskId: r.taskId });
    }
    if (changed) await this.save();
    return ended;
  }

  /** Move the hand-off's task as its receiver would (main, operator lane).
   *  Returns whether it moved; a refusal is logged, never thrown. */
  private async moveTask(r: HandoffRecord, status: 'working' | 'input-required', message?: string): Promise<boolean> {
    if (!r.taskId) return false;
    const res = (await this.ports
      .invoke('a2a.task.update', {
        taskId: r.taskId,
        workspaceId: r.target.workspaceId,
        status,
        ...(message ? { message } : {}),
      })
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))) as
      | { ok?: boolean; error?: unknown; result?: { ok?: unknown; error?: unknown } }
      | null;
    const why = !res ? 'no answer' : res.ok === false ? String(res.error ?? 'refused') : typeof res.result?.error === 'string' ? res.result.error : null;
    if (why) {
      console.warn(`[moa:handoff] could not move task ${r.taskId} to ${status}: ${why}`);
      return false;
    }
    this.put({ ...(this.get(r.id) ?? r), taskState: status });
    return true;
  }

  /** Stop an auto hand-off from its receipt: interrupt the worker and cancel
   *  the task. */
  async stop(id: string): Promise<{ ok: boolean }> {
    const r = this.get(id);
    if (!r || !r.taskId) return { ok: false };
    // An ended task's pane may be running something else now: never interrupt it.
    if (r.state !== 'delivered' || isEnded(r.taskState) || r.stopped) return { ok: false };
    await this.ports.invoke('input.sendKey', { ptyId: r.target.ptyId, key: 'escape', workspaceId: r.target.workspaceId }).catch(() => null);
    await this.cancelTask(r);
    this.put({ ...this.get(id)!, stopped: true });
    await this.save();
    this.notify();
    return { ok: true };
  }

  private async cancelTask(r: HandoffRecord, internal?: HandoffRecord['internalCancel']): Promise<void> {
    if (!r.taskId || isEnded(r.taskState)) return;
    // Marked before the release: the canceled event that wakes the HQ can
    // arrive while it is in flight, and its wording depends on who ended it.
    if (internal) this.put({ ...r, internalCancel: internal });
    await this.ports.release(r.linkId, r.taskId).catch(() => undefined);
    this.put({ ...(this.get(r.id) ?? r), taskState: 'canceled' });
  }

  /**
   * Take down the HQ's unanswered hand-off cards: the follow-up cards of one
   * task when that task ended (another job's card on the same pane stays), or
   * all of them (`scope` absent) when the HQ finished the job
   * (deck_complete_work). They would only sit in "Waiting on you". Returns
   * how many were closed.
   */
  async closeMootCards(hqWorkspaceId: string, scope?: { taskId: string }): Promise<number> {
    let closed = 0;
    for (const r of Object.values(this.file.items)) {
      if (r.hqWorkspaceId !== hqWorkspaceId || r.state !== 'pending' || r.notice || !r.decisionId) continue;
      if (scope && r.followsTaskId !== scope.taskId) continue;
      if (this.answering.has(r.decisionId)) continue;
      const ws = r.target.workspaceId;
      const d = this.ports.decisions.load(ws);
      if (d && d.id === r.decisionId && d.status === 'pending') {
        // Compare-and-clear: a click that won the race keeps its answer.
        if (!(await this.ports.decisions.clearPendingIfUnchanged(ws, d).catch(() => false))) continue;
      }
      this.put({ ...r, state: 'expired', decisionId: undefined });
      closed += 1;
    }
    if (closed > 0) {
      await this.save();
      this.notify();
    }
    return closed;
  }

  /**
   * Match the records to the panes (run on every workspace mirror push): a
   * card whose pane closed or whose agent left is taken down; an open task
   * whose pane closed or whose agent left is canceled.
   */
  async reconcile(): Promise<void> {
    let changed = false;
    for (const r of Object.values(this.file.items)) {
      // A delivery the app stopped in the middle of: its outcome is unknown,
      // so its task is released and the operator told.
      if (r.state === 'delivering' && this.now() - r.at > STALE_DELIVERY_MS) {
        // Settle from the task's canonical state: a task that exists and is
        // open was delivered; one that ended stays ended; only a task that
        // never came to be is released with a notice.
        const canonical = r.taskId && this.ports.taskState ? await this.ports.taskState(r.taskId).catch(() => undefined) : undefined;
        if (canonical === undefined && r.taskId && this.ports.taskState) continue; // unreadable now: try again later
        if (typeof canonical === 'string') {
          this.put({ ...r, state: 'delivered', taskState: canonical });
          changed = true;
          continue;
        }
        await this.ports.release(r.linkId, r.taskId).catch(() => undefined);
        this.put({ ...r, state: 'failed', taskState: 'canceled' });
        await this.raiseNotice(this.get(r.id)!, 'wmux stopped while it was delivering it');
        changed = true;
        continue;
      }
      // A card answered by a click that the app did not live to deliver: the
      // decision is gone and the record still pending. Ask again.
      if (r.state === 'pending' && !r.notice && r.decisionId) {
        const d = this.ports.decisions.load(r.target.workspaceId);
        if ((!d || d.id !== r.decisionId) && !this.answering.has(r.decisionId) && this.now() - r.at > STALE_DELIVERY_MS) {
          const res = await this.raiseCard({ ...r, decisionId: undefined });
          if (!res.ok) this.put({ ...r, state: 'expired', decisionId: undefined });
          changed = true;
          continue;
        }
      }
      const live = r.state === 'pending' && !r.notice ? 'card' : r.state === 'delivered' && !isEnded(r.taskState) ? 'task' : null;
      if (!live) continue;
      const ws = r.target.workspaceId;
      const pane = this.ports.workspaceExists(ws) ? this.ports.paneState(ws, r.target.ptyId) : 'gone';
      if (pane === 'agent' || pane === 'unknown') continue;
      if (live === 'card') {
        const d = r.decisionId ? this.ports.decisions.load(ws) : null;
        if (d && d.id === r.decisionId && d.status === 'pending') {
          await this.ports.decisions.clearPendingIfUnchanged(ws, d).catch(() => false);
        }
        this.put({ ...r, state: 'expired', decisionId: undefined });
      } else {
        await this.cancelTask(r, 'pane-gone');
      }
      changed = true;
    }
    if (changed) {
      await this.save();
      this.notify();
    }
  }
}

function isEnded(state: string | undefined): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}
