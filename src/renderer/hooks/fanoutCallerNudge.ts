// One-line nudge to the pane that started a fan-out, when one of its workers
// moves and the owner workspace has no brain to hear it (main parks the event
// in the task ledger and sends a pointer here — main/deck/fanoutCallerNotify.ts).
//
// Accelerator only: the park is the record, nothing is acknowledged, and any
// doubt means no write. A pointer that arrives before this module is
// subscribed (startup, a renderer reload) is lost; the park still holds it.
//
// Address: the requester's stable {paneId, surfaceId} from the lineage stamp,
// re-resolved against the OWNER workspace's live leaves at receipt and again
// right before each write. A surface id must name that exact terminal surface
// (and sit in that pane when both ids are given); a pane id alone must hold
// exactly one terminal surface. Never the active tab, never another workspace.
// The queue holds those ids, never a PTY id. Each pointer is bound to the
// agent session (daemon incarnation) running in the pane when it arrived; a
// pointer whose session is gone is dropped.
//
// When: the pane must pass the A2A turn-end eligibility (detected agent known
// alive, not running / awaiting_input, not held at a usage limit). Idle → a
// short coalescing window, then one flush per pane. Busy → queued until the
// pane's agent ends a turn. Held (usage limit, a person typing) → retried on
// every sweep. A pane that is not an agent (or is gone) drops its pointers,
// and a pointer older than POINTER_TTL_MS is dropped.
//
// The write itself goes through main (fanoutCallerSubmit.ts): the delivery
// gate, the owner check, the session check, then a daemon-owned paste + Enter
// that waits while the composer holds a draft or a key was pressed in the last
// 10 s, and cancels the Enter if anything else reached the pane after the paste.
//
// What: a fixed template and the task short ids, zero bytes of worker text.
// One line per pane per flush. Each (pane, task, kind, seq) is accepted once
// per renderer session. A plain stop of a task told within STOP_COOLDOWN_MS is
// not told again (a multi-turn worker would otherwise nudge every turn);
// failures and ledger moves always are. A failure before the paste is retried;
// a paste whose Enter was withheld is never pasted again.
//
// PR owner pointers (main/deck/prOwnerNotify.ts) share this queue, so a pane
// gets ONE line however many fan-out and PR events are pending for it. Their
// address is the PR itself: the one agent pane of the workspace whose checkout
// shows that PR (recorded per PTY from the metadata poll, notePanePr). No such
// pane, only shell panes, or two agent panes on the same PR → nothing is
// written (the coalescer path in main still holds the event). The owner is
// re-resolved at receipt, at every evaluation and right before the write, and
// main checks the pane's PR once more before the daemon pastes. The
// per-workspace "Wake the agent on PR events" switches (checks passed has its
// own, off by default) are read at the same points. Each (workspace, PR,
// kind, head commit, occurrence) is accepted once, and only once it is queued.
//
// A pointer that arrives while a line is in flight never edits the item being
// sent: it replaces it with a new object, and the reply consumes only the
// objects that were actually sent.
import { useStore } from '../stores';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import {
  isFanoutCallerKind,
  moreSevereKind,
  type FanoutCallerKind,
} from '../../shared/fanoutCallerNudge';
import {
  buildCallerNudge,
  isPrNumber,
  isPrOwnerKind,
  prOwnerSlot,
  type PrOwnerKind,
} from '../../shared/prOwnerNudge';
import { eligibility } from './a2aTurnEndReminder';

export const FANOUT_NUDGE_COALESCE_MS = 750;
export const POINTER_TTL_MS = 30 * 60_000;
export const STOP_COOLDOWN_MS = 5 * 60_000;
const MAX_SEND_ATTEMPTS = 3;
const SEEN_CAP = 2000;

export interface FanoutCallerPointer {
  ownerWorkspaceId: string;
  taskId: string;
  kind: FanoutCallerKind;
  seq: number;
  origin: { paneId?: string; surfaceId?: string };
}

interface PendingBase {
  createdAt: number;
  /** The pane's agent session at receipt: undefined while the read is in
   *  flight, null when no verified agent session answered. */
  incarnation: string | null | undefined;
}

interface FanoutItem extends PendingBase {
  type: 'fanout';
  taskId: string;
  kind: FanoutCallerKind;
}

interface PrItem extends PendingBase {
  type: 'pr';
  prNumber: number;
  /** Identifies the PR across repos; never written into the pane. */
  url: string;
  kind: PrOwnerKind;
}

type PendingItem = FanoutItem | PrItem;

interface Target {
  ownerWorkspaceId: string;
  paneId?: string;
  surfaceId?: string;
  /** taskId (fan-out) or `pr|url|slot` → what to tell, in arrival order. */
  pending: Map<string, PendingItem>;
  /** A turn end (or a hold) was seen: sweeps may flush. */
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  attempts: number;
}

type SubmitReply = { result: string; pasted: boolean };
interface DeckBridge {
  fanoutCallerSession?: (ptyId: string) => Promise<{ incarnationId: string } | null>;
  fanoutCallerSubmit?: (p: {
    ptyId: string;
    ownerWorkspaceId: string;
    incarnationId: string;
    text: string;
    prs?: { number: number; url: string }[];
  }) => Promise<SubmitReply>;
}

const targets = new Map<string, Target>();
const seen = new Set<string>();
/** taskId → when a line about it was last written (the stop cooldown). */
const lastLineAt = new Map<string, number>();
/** ptyId → the url of the PR its checkout showed on the last metadata poll. */
const prOfPty = new Map<string, string>();

function deck(): DeckBridge | undefined {
  return (window as unknown as { electronAPI?: { deck?: DeckBridge } }).electronAPI?.deck;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;
}

function parsePointer(raw: unknown): FanoutCallerPointer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ownerWorkspaceId = str(r.ownerWorkspaceId);
  const taskId = str(r.taskId);
  const seq = r.seq;
  const o = r.origin && typeof r.origin === 'object' ? (r.origin as Record<string, unknown>) : null;
  if (!ownerWorkspaceId || !taskId || !isFanoutCallerKind(r.kind)) return null;
  if (typeof seq !== 'number' || !Number.isFinite(seq) || !o) return null;
  const paneId = str(o.paneId);
  const surfaceId = str(o.surfaceId);
  if (!paneId && !surfaceId) return null;
  return {
    ownerWorkspaceId,
    taskId,
    kind: r.kind,
    seq,
    origin: { ...(paneId ? { paneId } : {}), ...(surfaceId ? { surfaceId } : {}) },
  };
}

function isTerminal(s: { surfaceType?: string; ptyId?: string }): boolean {
  return (s.surfaceType === undefined || s.surfaceType === 'terminal') && typeof s.ptyId === 'string' && s.ptyId.length > 0;
}

/**
 * The PTY the origin names right now inside `ownerWorkspaceId`, or null.
 * Fail-closed: no fallback to an active tab, a sibling surface or another
 * workspace.
 */
export function resolveOriginPty(
  workspaces: ReturnType<typeof useStore.getState>['workspaces'],
  ownerWorkspaceId: string,
  origin: { paneId?: string; surfaceId?: string },
): string | null {
  const ws = workspaces.find((w) => w.id === ownerWorkspaceId);
  if (!ws) return null;
  const leaves = getWorkspaceLeafPanes(ws);
  if (origin.surfaceId) {
    for (const leaf of leaves) {
      const surface = leaf.surfaces.find((s) => s.id === origin.surfaceId);
      if (!surface) continue;
      if (origin.paneId && leaf.id !== origin.paneId) return null;
      return isTerminal(surface) ? (surface.ptyId as string) : null;
    }
    return null;
  }
  const leaf = leaves.find((l) => l.id === origin.paneId);
  if (!leaf) return null;
  const terminals = leaf.surfaces.filter(isTerminal);
  return terminals.length === 1 ? (terminals[0].ptyId as string) : null;
}

function keyOf(ownerWorkspaceId: string, paneId?: string, surfaceId?: string): string {
  return `${ownerWorkspaceId}|${paneId ?? ''}|${surfaceId ?? ''}`;
}

function targetKey(p: FanoutCallerPointer): string {
  return keyOf(p.ownerWorkspaceId, p.origin.paneId, p.origin.surfaceId);
}

/** The metadata poll's PR for a PTY (payload.pr); null/absent clears it. */
export function notePanePr(ptyId: string, pr: { url?: unknown } | null | undefined): void {
  if (!ptyId) return;
  const url = pr && typeof pr.url === 'string' && pr.url.length > 0 && pr.url.length <= 512 ? pr.url : undefined;
  if (url) prOfPty.set(ptyId, url);
  else prOfPty.delete(ptyId);
}

/**
 * The one agent pane in `workspaceId` whose checkout shows the PR `url`, or
 * null. Fail-closed: no pane, only shell panes (no detected agent) or two
 * agent panes on the same PR all answer null.
 */
export function resolvePrOwner(
  workspaces: ReturnType<typeof useStore.getState>['workspaces'],
  surfaceAgent: ReturnType<typeof useStore.getState>['surfaceAgent'],
  workspaceId: string,
  url: string,
): { paneId: string; surfaceId: string; ptyId: string } | null {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const found: { paneId: string; surfaceId: string; ptyId: string }[] = [];
  for (const leaf of getWorkspaceLeafPanes(ws)) {
    for (const s of leaf.surfaces) {
      if (!isTerminal(s)) continue;
      const ptyId = s.ptyId as string;
      if (prOfPty.get(ptyId) === url && surfaceAgent[ptyId]) found.push({ paneId: leaf.id, surfaceId: s.id, ptyId });
    }
  }
  return found.length === 1 ? found[0] : null;
}

function prWakeEnabled(workspaceId: string, kind?: PrOwnerKind): boolean {
  const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!ws || ws.metadata?.wakeOnPrEvents === false) return false;
  return kind !== 'pr.checks_passed' || ws.metadata?.wakeOnPrChecksPassed === true;
}

/** Drop PR items this pane no longer owns, or whose workspace turned the
 *  switch off. */
function dropStalePr(t: Target, ptyId: string): void {
  for (const [key, item] of t.pending) {
    if (item.type !== 'pr') continue;
    const s = useStore.getState();
    if (
      !prWakeEnabled(t.ownerWorkspaceId, item.kind)
      || resolvePrOwner(s.workspaces, s.surfaceAgent, t.ownerWorkspaceId, item.url)?.ptyId !== ptyId
    ) {
      t.pending.delete(key);
    }
  }
}

function resolve(t: Target): string | null {
  return resolveOriginPty(useStore.getState().workspaces, t.ownerWorkspaceId, t);
}

function isBusy(ptyId: string): boolean {
  const status = useStore.getState().surfaceAgent[ptyId]?.status;
  return status === 'running' || status === 'awaiting_input';
}

function drop(key: string, t: Target): void {
  if (t.timer) clearTimeout(t.timer);
  t.timer = null;
  if (targets.get(key) === t) targets.delete(key);
}

function rememberSeen(k: string): void {
  seen.add(k);
  while (seen.size > SEEN_CAP) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

function inStopCooldown(taskId: string, now: number): boolean {
  const at = lastLineAt.get(taskId);
  return at !== undefined && now - at < STOP_COOLDOWN_MS;
}

/** Drop pointers that expired, lost their session binding or are in the
 *  stop cooldown. */
function prune(t: Target, now: number): void {
  for (const [id, item] of t.pending) {
    if (
      now - item.createdAt >= POINTER_TTL_MS ||
      item.incarnation === null ||
      (item.type === 'fanout' && item.kind === 'agent.stop' && inStopCooldown(id, now))
    ) {
      t.pending.delete(id);
    }
  }
}

/** Decide what to do with a target now: drop, schedule, wait or arm. */
function evaluate(key: string, t: Target): void {
  prune(t, Date.now());
  const ptyId = resolve(t);
  if (ptyId) dropStalePr(t, ptyId);
  if (t.pending.size === 0 || !ptyId) {
    drop(key, t);
    return;
  }
  const verdict = eligibility(ptyId);
  if (verdict === 'never') {
    drop(key, t);
    return;
  }
  if (verdict === 'write') {
    if (!t.timer && !t.inFlight) {
      t.timer = setTimeout(() => {
        t.timer = null;
        void flush(key);
      }, FANOUT_NUDGE_COALESCE_MS);
    }
    return;
  }
  // 'wait': busy waits for a turn end; a usage-limit hold is retried by sweeps.
  if (!isBusy(ptyId)) t.armed = true;
}

function bindSession(item: PendingItem, ptyId: string): void {
  const read = deck()?.fanoutCallerSession;
  if (typeof read !== 'function') {
    item.incarnation = null;
    return;
  }
  read(ptyId)
    .then((s) => {
      item.incarnation = s?.incarnationId ?? null;
    })
    .catch(() => {
      item.incarnation = null;
    });
}

async function flush(key: string): Promise<void> {
  const t = targets.get(key);
  if (!t || t.inFlight) return;
  if (t.timer) {
    clearTimeout(t.timer);
    t.timer = null;
  }
  prune(t, Date.now());
  const ptyId = resolve(t);
  if (ptyId) dropStalePr(t, ptyId);
  if (!ptyId || t.pending.size === 0) {
    drop(key, t);
    return;
  }
  const verdict = eligibility(ptyId);
  if (verdict === 'never') {
    drop(key, t);
    return;
  }
  if (verdict === 'wait') {
    // Never disarm: a turn end is often seen while the pane still reads
    // 'running', and the sweep that follows must keep it.
    if (!isBusy(ptyId)) t.armed = true;
    return;
  }
  const items = [...t.pending.values()];
  if (items.some((i) => i.incarnation === undefined)) {
    t.armed = true; // the session read is still in flight
    return;
  }
  const api = deck();
  if (typeof api?.fanoutCallerSession !== 'function' || typeof api.fanoutCallerSubmit !== 'function') {
    drop(key, t);
    return;
  }
  t.inFlight = true;
  t.armed = false;
  let reply: SubmitReply;
  let sent: PendingItem[] = [];
  try {
    const session = await api.fanoutCallerSession(ptyId).catch(() => null);
    if (!session) {
      drop(key, t);
      return;
    }
    // Pointers bound to an earlier agent session in this pane are not this
    // conversation's business.
    for (const [k, i] of t.pending) if (i.incarnation !== session.incarnationId) t.pending.delete(k);
    if (resolve(t) === ptyId) dropStalePr(t, ptyId);
    sent = [...t.pending.values()];
    if (sent.length === 0 || resolve(t) !== ptyId || eligibility(ptyId) !== 'write') {
      if (sent.length > 0) t.armed = true;
      return;
    }
    reply = await api
      .fanoutCallerSubmit({
        ptyId,
        ownerWorkspaceId: t.ownerWorkspaceId,
        incarnationId: session.incarnationId,
        text: buildCallerNudge(
          sent.flatMap((i) => (i.type === 'fanout' ? [{ taskId: i.taskId, kind: i.kind }] : [])),
          sent.flatMap((i) => (i.type === 'pr' ? [{ prNumber: i.prNumber, kind: i.kind }] : [])),
        ),
        ...prClaims(sent),
      })
      .catch((): SubmitReply => ({ result: 'error', pasted: true }));
  } finally {
    t.inFlight = false;
  }
  const now = Date.now();
  const consume = (): void => {
    for (const [k, i] of [...t.pending]) if (sent.includes(i)) t.pending.delete(k);
    for (const i of sent) if (i.type === 'fanout') lastLineAt.set(i.taskId, now);
    t.attempts = 0;
  };
  if (reply.result === 'sent' || reply.pasted) {
    if (reply.result !== 'sent') {
      console.warn(`[fanout-nudge] line pasted but not submitted (${reply.result}); not pasted again`);
    }
    consume();
  } else if (reply.result === 'held') {
    t.armed = true;
    return;
  } else if (reply.result === 'approval_pending') {
    return; // nothing written; the pane's next turn end re-arms it
  } else if (reply.result === 'pr_changed') {
    // The pane moved off a PR the line named: drop those PR clauses only
    // and send the rest again (fan-out pointers, other PR events).
    for (const [k, i] of [...t.pending]) if (i.type === 'pr' && sent.includes(i)) t.pending.delete(k);
  } else if (reply.result === 'gone' || reply.result === 'session_changed') {
    drop(key, t);
    return;
  } else if (++t.attempts >= MAX_SEND_ATTEMPTS) {
    console.warn(`[fanout-nudge] gave up after ${t.attempts} attempts (${reply.result})`);
    drop(key, t);
    return;
  } else {
    t.armed = true;
    return;
  }
  // Pointers that arrived mid-flight start their own window.
  if (targets.get(key) === t) evaluate(key, t);
}

/** A pointer from main (DECK_FANOUT_CALLER). Malformed input is ignored. */
export function receiveFanoutCallerEvent(raw: unknown): void {
  const p = parsePointer(raw);
  if (!p) return;
  const key = targetKey(p);
  const dedup = `${key}|${p.taskId}|${p.kind}|${p.seq}`;
  if (seen.has(dedup)) return;
  rememberSeen(dedup);
  const now = Date.now();
  if (p.kind === 'agent.stop' && inStopCooldown(p.taskId, now)) return;
  const t = targetFor(key, p.ownerWorkspaceId, p.origin.paneId, p.origin.surfaceId);
  const existing = t.pending.get(p.taskId);
  if (existing?.type === 'fanout') {
    // A new object, never an edit: the old one may be the line in flight.
    replaceItem(t, p.taskId, { ...existing, kind: moreSevereKind(existing.kind, p.kind) });
  } else {
    addItem(t, p.taskId, { type: 'fanout', taskId: p.taskId, kind: p.kind, createdAt: now, incarnation: undefined });
  }
  if (!t.inFlight) evaluate(key, t);
}

function targetFor(key: string, ownerWorkspaceId: string, paneId?: string, surfaceId?: string): Target {
  let t = targets.get(key);
  if (!t) {
    t = {
      ownerWorkspaceId,
      ...(paneId ? { paneId } : {}),
      ...(surfaceId ? { surfaceId } : {}),
      pending: new Map(),
      armed: false,
      timer: null,
      inFlight: false,
      attempts: 0,
    };
    targets.set(key, t);
  }
  return t;
}

function addItem(t: Target, key: string, item: PendingItem): void {
  t.pending.set(key, item);
  const ptyId = resolve(t);
  if (ptyId) bindSession(item, ptyId);
  else item.incarnation = null;
}

/** Swap in a new version of a queued item. A binding still being read
 *  landed on the old object, so the new one reads its own. */
function replaceItem(t: Target, key: string, next: PendingItem): void {
  if (next.incarnation === undefined) addItem(t, key, next);
  else t.pending.set(key, next);
}

/** The PRs a line names, with the url each owner was resolved by. */
function prClaims(items: readonly PendingItem[]): { prs?: { number: number; url: string }[] } {
  const prs = new Map<string, { number: number; url: string }>();
  for (const i of items) if (i.type === 'pr') prs.set(i.url, { number: i.prNumber, url: i.url });
  return prs.size > 0 ? { prs: [...prs.values()] } : {};
}

/** A PR owner pointer from main (DECK_PR_OWNER). Malformed input is ignored. */
export function receivePrOwnerEvent(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const r = raw as Record<string, unknown>;
  const workspaceId = str(r.workspaceId);
  const url = str(r.url);
  const headSha = typeof r.headSha === 'string' && /^[0-9a-f]{7,64}$/i.test(r.headSha) ? r.headSha : undefined;
  const episode = typeof r.episode === 'string' && /^[\w:.#+-]{1,80}$/.test(r.episode) ? r.episode : undefined;
  const seq = r.seq;
  if (!workspaceId || !url || !isPrNumber(r.prNumber) || !isPrOwnerKind(r.kind)) return;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return;
  const prNumber = r.prNumber;
  const kind = r.kind;
  if (!prWakeEnabled(workspaceId, kind)) return;
  // The occurrence (CI transition, review batch, conflict episode) is part of
  // the key: fail → pass → fail on one head, or a second review batch, is a
  // new event. Without either, the pointer's own seq stands in.
  const dedup = `pr|${workspaceId}|${url}|${kind}|${headSha ?? ''}|${episode ?? (headSha ? '' : `#${seq}`)}`;
  if (seen.has(dedup)) return;
  const s = useStore.getState();
  const owner = resolvePrOwner(s.workspaces, s.surfaceAgent, workspaceId, url);
  if (!owner) return; // no single agent pane owns it: main's coalescer path keeps the event
  const key = keyOf(workspaceId, owner.paneId, owner.surfaceId);
  const t = targetFor(key, workspaceId, owner.paneId, owner.surfaceId);
  const itemKey = `pr|${url}|${prOwnerSlot(kind)}`;
  const existing = t.pending.get(itemKey);
  if (existing?.type === 'pr') {
    // The newer answer wins (checks passed after CI failed) — as a new object,
    // so a line already in flight with the old one does not consume it.
    replaceItem(t, itemKey, { ...existing, kind, createdAt: Date.now() });
  } else {
    addItem(t, itemKey, { type: 'pr', prNumber, url, kind, createdAt: Date.now(), incarnation: undefined });
  }
  // Consumed only now that it is queued: an owner that did not resolve
  // leaves the key free.
  rememberSeen(dedup);
  if (!t.inFlight) evaluate(key, t);
}

/** An agent turn ended on `ptyId` (hook / detector stop or failed stop, not osc133). */
export function noteFanoutCallerTurnEnd(ptyId: string): void {
  if (!ptyId) return;
  for (const t of targets.values()) {
    if (t.pending.size > 0 && resolve(t) === ptyId) t.armed = true;
  }
}

/** A lifecycle event of any pane: an agent turn end (a stop or a failed stop
 *  from a hook or the detector) arms the nudges queued behind it. An osc133
 *  stop is a shell command ending, not a turn end. */
export function noteFanoutCallerLifecycle(ev: { kind: string; source: string; ptyId: string }): void {
  if ((ev.kind === 'agent.stop' || ev.kind === 'agent.stop_failure') && ev.source !== 'osc133') {
    noteFanoutCallerTurnEnd(ev.ptyId);
  }
}

/** Flush armed targets whose pane is writable now and drop dead ones. Call on
 *  every event poll. */
export async function sweepFanoutCallerNudges(): Promise<void> {
  for (const [key, t] of [...targets]) {
    if (t.inFlight) continue;
    if (!t.armed) {
      // A pane that closed, moved away or stopped running an agent takes its
      // pointers with it; so does age.
      prune(t, Date.now());
      const ptyId = resolve(t);
      if (t.pending.size === 0 || !ptyId || eligibility(ptyId) === 'never') drop(key, t);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- one write per pane, in order
    await flush(key);
  }
}

/** Test-only. */
export function resetFanoutCallerNudgesForTest(): void {
  for (const t of targets.values()) if (t.timer) clearTimeout(t.timer);
  targets.clear();
  seen.clear();
  lastLineAt.clear();
  prOfPty.clear();
}
