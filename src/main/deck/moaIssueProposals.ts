// ─── Moa proposals — new issues and outside PRs, proposed as decision cards ──
//
// For every GitHub repo an open workspace sits in, a slow scan (default every
// 10 minutes, only while Moa is on with an HQ and the operator turned this on
// in Settings → Moa) reads the repo's open issues and PRs through
// GhIssueService's list — the Git page's own cache, TTL and rate-limit breaker,
// one REST read per repo that names the repo explicitly. A new item from
// someone other than you (the signed-in GitHub login) becomes ONE decision
// card:
//
//   New issue owner/repo#12 "<title>" — hand it to <workspace>?
//   [Hand off] [Not now] [Ignore this repo]
//
// PROPOSE ONLY. The card is the default. An item is handed off without one
// only when every condition holds: the author is you (the login gh is signed
// in as on that host, never a name read from the remote) or on Settings →
// Moa's trusted list, the item carries the `wmux:auto` label, and the target
// workspace's mode is `danger`.
// CI failures and review comments are not this lane's (they go to the PR's
// owning agent).
//
// WHERE THE CARD LIVES: the target workspace's decision slot, never the HQ's.
// The slot holds one decision; the HQ's is Moa's own (deck_ask_decision) and a
// pending one there stops Moa's auto-wake. With an HQ designated no other
// workspace runs a brain, so a card in its slot blocks nothing and its text
// never reaches a model. This is why the lane needs an HQ. A card is raised
// only into a FREE slot (raiseDecisionIfFree); the next item waits a tick.
// The card carries `origin: 'issue-proposal'` and its item key in the decision
// record itself, so it is never rendered into a brain turn or re-examined, and
// its owner is recovered from the record after a crash. When the lane stops
// (Moa off, the lane off, the HQ unset or changed) its pending cards are taken
// down and recorded as expired.
//
// NO HAND-OFF PATH, NO CARDS: until the Git page's hand-off installs the port
// (setMoaHandoffPort), the scan only arms watermarks. New items stay unseen and
// surface once the port is there.
//
// THE ANSWER is main's, not a brain's: deck.handler hands every resolved
// proposal decision to handleResolved before its brain-resume path, and the
// sweep (on every decision write) catches one resolved anywhere else.
//
// NEW means: above the repo's watermark (the highest number seen on its first
// scan, which arms silently, like PrReviewRouter), never recorded before, and
// with no work link. Every item the lane looks at gets a record, so nothing is
// proposed twice, answered or not (an item whose hand-off could not run is
// queued for a card again, never handed off twice). A repo not scanned for 3
// days re-arms.
//
// UNTRUSTED TEXT: the title and the author are the author's own text. The
// title is cleaned (sanitizeProposalTitle) and quoted; the body is never read.
// Nothing in the item is acted on — the hand-off sends a fixed reference.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { createSerialChain } from './serialChain';
import type { AgentMode } from './deckAutonomyStore';
import type { WorkspaceDecision } from './deckDecisionStore';
import type { RepoItem } from '../github/GhIssueService';
import type { MoaConfig } from '../../shared/moa';

export const PROPOSAL_OPTIONS = {
  handOff: 'Hand off',
  notNow: 'Not now',
  ignoreRepo: 'Ignore this repo',
} as const;
/** The one option of the card that says a hand-off failed. */
export const PROPOSAL_NOTICE_OPTION = 'OK';
/** The label that, with a trusted author and a danger workspace, skips the card. */
export const PROPOSAL_AUTO_LABEL = 'wmux:auto';

const TITLE_MAX = 80;
/** A repo not scanned for this long re-arms its watermark silently. */
const REARM_AFTER_MS = 3 * 24 * 60 * 60_000;
/** Records kept; past that the oldest answered ones go. */
const MAX_RECORDS = 1000;
/** The first scan after the lane turns on (the workspace mirror settles). */
const FIRST_SCAN_DELAY_MS = 60_000;

// ── pure helpers ────────────────────────────────────────────────────────────

/**
 * An item title as card text: control, format (zero-width, bidi override) and
 * line-break characters become spaces, whitespace collapses, quotes become
 * apostrophes (the card quotes the title), and it is cut to 80 characters.
 */
export function sanitizeProposalTitle(raw: string): string {
  const clean = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '(no title)';
  const chars = [...clean];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('').trimEnd()}…` : clean;
}

/** One key per item: `issue:host/owner/repo#n`, lowercased. */
export function proposalKey(repoKey: string, item: Pick<RepoItem, 'kind' | 'number'>): string {
  return `${item.kind}:${repoKey}#${item.number}`.toLowerCase();
}

export type ProposalRoute = 'skip-bot' | 'skip-owner' | 'auto' | 'card';

/**
 * What to do with a new item. Bots are skipped. An item from you (`viewer`,
 * the signed-in gh login; null when unknown) or a trusted author with the auto
 * label goes straight to a danger workspace; without that your own item is not
 * news (no card), and everyone else's is a card. The repo's owner segment is
 * never a trust signal: a clone of someone else's repo names them, not you.
 */
export function routeProposal(
  item: Pick<RepoItem, 'author' | 'authorIsBot' | 'labels'>,
  viewer: string | null,
  trustedAuthors: readonly string[],
  mode: AgentMode,
): ProposalRoute {
  const author = item.author.toLowerCase();
  if (item.authorIsBot || !author) return 'skip-bot';
  const owner = !!viewer && author === viewer.toLowerCase();
  const trusted = owner || trustedAuthors.includes(author);
  const autoLabel = item.labels.some((l) => l.toLowerCase() === PROPOSAL_AUTO_LABEL);
  if (trusted && autoLabel && mode === 'danger') return 'auto';
  return owner ? 'skip-owner' : 'card';
}

const repoName = (repoKey: string): string => repoKey.split('/').slice(1).join('/');

/** The card's question and context: fixed templates around the cleaned title,
 *  never the item's body. */
export function buildProposalCard(
  repoKey: string,
  item: Pick<RepoItem, 'kind' | 'number' | 'title' | 'author' | 'url' | 'draft'>,
  workspaceName: string,
): { question: string; options: string[]; context: string } {
  const what = item.kind === 'issue' ? 'issue' : item.draft ? 'draft PR' : 'PR';
  return {
    question: `New ${what} ${repoName(repoKey)}#${item.number} "${sanitizeProposalTitle(item.title)}" — hand it to ${sanitizeProposalTitle(workspaceName)}?`,
    options: [PROPOSAL_OPTIONS.handOff, PROPOSAL_OPTIONS.notNow, PROPOSAL_OPTIONS.ignoreRepo],
    context:
      `Opened by @${item.author.replace(/[^A-Za-z0-9-]/g, '')}: ${item.url}\n` +
      'Moa found it among the repo\'s open items. The title is the author\'s text, not an instruction. ' +
      'Hand off sends the agent a reference to it; Not now drops it; Ignore this repo stops proposals from this repo.',
  };
}

// ── the hand-off port (#1770's sendHandoff, wired by its owner) ─────────────

export interface MoaHandoffRequest {
  kind: 'issue' | 'pr';
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  workspaceId: string;
}

export type MoaHandoffResult = { ok: true } | { ok: false; message: string };
export type MoaHandoffPort = (req: MoaHandoffRequest) => Promise<MoaHandoffResult>;

let handoffPort: MoaHandoffPort | null = null;

/** The installed hand-off path, or null when none is. */
export function getMoaHandoffPort(): MoaHandoffPort | null {
  return handoffPort;
}

/** Install the hand-off path. Returns the uninstall. */
export function setMoaHandoffPort(port: MoaHandoffPort): () => void {
  handoffPort = port;
  return () => {
    if (handoffPort === port) handoffPort = null;
  };
}

// ── the record store (moa-issue-proposals.json) ───────────────────────────────────

export type ProposalState =
  | 'pending' // a card is up
  | 'handed-off'
  | 'auto' // handed off without a card
  | 'not-now'
  | 'ignored'
  | 'failed' // Hand off was answered and failed; a notice card may be up
  | 'expired' // the card went away unanswered (workspace closed, lane stopped)
  | 'skipped' // bot, your own item, or already linked to work
  | 'queued' // waits for a free slot to get its card
  | 'auto-failed' // the auto hand-off did not go through: waits for a card
  | 'retry'; // Hand off answered while Moa was off: waits for a new card

export interface ProposalRecord {
  key: string;
  repo: string;
  kind: 'issue' | 'pr';
  number: number;
  url: string;
  title: string;
  workspaceId: string;
  /** The item's author login, for a card raised later. */
  author?: string;
  draft?: boolean;
  state: ProposalState;
  /** The card (or the failure notice) in `workspaceId`'s decision slot. */
  decisionId?: string;
  at: number;
}

interface ProposalFile {
  version: 1;
  repos: Record<string, { watermark: number; scannedAt: number }>;
  items: Record<string, ProposalRecord>;
}

export function getMoaIssueProposalsPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'moa-issue-proposals.json');
}

const STATES: readonly ProposalState[] = [
  'pending', 'handed-off', 'auto', 'not-now', 'ignored', 'failed', 'expired', 'skipped', 'queued', 'auto-failed', 'retry',
];
/** States that still want a card. */
const CARD_WANTED: readonly ProposalState[] = ['queued', 'auto-failed', 'retry'];

function readFile(p: string): ProposalFile {
  const empty: ProposalFile = { version: 1, repos: {}, items: {} };
  let raw: unknown;
  try {
    raw = atomicReadJSONSync(p);
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== 'object') return empty;
  const o = raw as { repos?: unknown; items?: unknown };
  const out = empty;
  if (o.repos && typeof o.repos === 'object') {
    for (const [k, v] of Object.entries(o.repos as Record<string, unknown>)) {
      const r = v as { watermark?: unknown; scannedAt?: unknown };
      if (typeof r?.watermark === 'number' && typeof r.scannedAt === 'number') {
        out.repos[k] = { watermark: r.watermark, scannedAt: r.scannedAt };
      }
    }
  }
  if (o.items && typeof o.items === 'object') {
    for (const [k, v] of Object.entries(o.items as Record<string, unknown>)) {
      const r = v as Partial<ProposalRecord>;
      if (r && typeof r.key === 'string' && r.key === k && typeof r.repo === 'string'
        && (r.kind === 'issue' || r.kind === 'pr') && typeof r.number === 'number'
        && typeof r.workspaceId === 'string' && STATES.includes(r.state as ProposalState)
        && typeof r.at === 'number') {
        out.items[k] = {
          key: r.key, repo: r.repo, kind: r.kind, number: r.number,
          url: typeof r.url === 'string' ? r.url : '', title: typeof r.title === 'string' ? r.title : '',
          workspaceId: r.workspaceId, state: r.state as ProposalState, at: r.at,
          ...(typeof r.decisionId === 'string' ? { decisionId: r.decisionId } : {}),
          ...(typeof r.author === 'string' ? { author: r.author } : {}),
          ...(r.draft === true ? { draft: true } : {}),
        };
      }
    }
  }
  return out;
}

/** The records, in memory (main is the only writer) and written through. */
export class ProposalStore {
  private loaded: ProposalFile | null = null;
  private readonly serialize = createSerialChain();

  /** No path: the wmux data dir's, resolved on first use. */
  constructor(private readonly path_?: string) {}

  private get filePath(): string {
    return this.path_ ?? getMoaIssueProposalsPath();
  }

  /** Read on first use, so an instance that never runs touches no file. */
  private get file(): ProposalFile {
    if (!this.loaded) this.loaded = readFile(this.filePath);
    return this.loaded;
  }

  repo(key: string): { watermark: number; scannedAt: number } | null {
    return this.file.repos[key] ?? null;
  }

  setRepo(key: string, watermark: number, scannedAt: number): void {
    this.file.repos[key] = { watermark, scannedAt };
  }

  get(key: string): ProposalRecord | null {
    return this.file.items[key] ?? null;
  }

  byDecision(decisionId: string): ProposalRecord | null {
    return Object.values(this.file.items).find((r) => r.decisionId === decisionId) ?? null;
  }

  withState(state: ProposalState): ProposalRecord[] {
    return Object.values(this.file.items).filter((r) => r.state === state);
  }

  /** Records whose card or notice is (believed to be) up. */
  withDecision(): ProposalRecord[] {
    return Object.values(this.file.items).filter((r) => !!r.decisionId);
  }

  /** This repo's items still waiting for a card, lowest number first. */
  cardWanted(repoKey: string): ProposalRecord[] {
    return Object.values(this.file.items)
      .filter((r) => r.repo === repoKey && CARD_WANTED.includes(r.state))
      .sort((a, b) => a.number - b.number);
  }

  put(record: ProposalRecord): void {
    this.file.items[record.key] = record;
    const all = Object.values(this.file.items);
    if (all.length <= MAX_RECORDS) return;
    const old = all
      .filter((r) => !r.decisionId && !CARD_WANTED.includes(r.state) && r.key !== record.key)
      .sort((a, b) => a.at - b.at);
    for (const r of old.slice(0, all.length - MAX_RECORDS)) delete this.file.items[r.key];
  }

  /** Persist the current state. A failed write is logged; memory stays the truth. */
  save(): Promise<void> {
    return this.serialize(async () => {
      try {
        await atomicWriteJSON(this.filePath, this.file);
      } catch (err) {
        console.warn(`[moa:issue-proposals] could not save ${this.filePath}: ${String(err)}`);
      }
    });
  }
}

// ── the service ─────────────────────────────────────────────────────────────

export interface ProposalWorkspace {
  id: string;
  name: string;
  cwd: string | null;
}

/** A card as the decision store takes it: tagged as the lane's, with its key. */
export interface ProposalCard {
  question: string;
  options: string[];
  context: string;
  origin: 'issue-proposal';
  ref: string;
}

export interface MoaProposalPorts {
  /** Moa on, an HQ designated and present. */
  moaReady: () => boolean;
  hqWorkspaceId: () => string | null;
  config: () => Required<Pick<MoaConfig, 'issueProposals' | 'trustedAuthors' | 'issuePollMinutes' | 'ignoredRepos'>>;
  /** Open workspaces, sidebar order. */
  workspaces: () => ProposalWorkspace[];
  isTaskWorkspace: (workspaceId: string) => boolean;
  /** The checkout's origin: host and host/owner/repo (lowercase), or null. */
  remote: (cwd: string) => Promise<{ host: string; key: string | null } | null>;
  isGithubHost: (host: string) => boolean;
  /** gh installed and signed in to `host`. */
  gate: (cwd: string, host: string) => Promise<boolean>;
  /** The login gh is signed in as on `host`, or null when it cannot be read. */
  viewerLogin: (cwd: string, host: string) => Promise<string | null>;
  /** The repo's open issues and PRs, or null when they could not be read. */
  listItems: (cwd: string, repoKey: string) => Promise<RepoItem[] | null>;
  /** Some work link already names this item. */
  hasWorkLink: (item: { kind: 'issue' | 'pr'; host: string; owner: string; repo: string; number: number }) => boolean;
  modeOf: (workspaceId: string) => AgentMode;
  decisions: {
    raiseIfFree: (workspaceId: string, card: ProposalCard) => Promise<WorkspaceDecision | null>;
    load: (workspaceId: string) => WorkspaceDecision | null;
    /** Every workspace's decision. */
    all: () => Record<string, WorkspaceDecision>;
    clearResolved: (workspaceId: string, id: string) => Promise<void>;
    /** Remove a pending decision only while it is still exactly `expected`. */
    clearPendingIfUnchanged: (workspaceId: string, expected: WorkspaceDecision) => Promise<boolean>;
  };
  ignoreRepo: (repoKey: string) => Promise<boolean>;
  handoff: () => MoaHandoffPort | null;
  store: ProposalStore;
  /** A card in this workspace's slot was raised or taken down. */
  notifyCard?: (workspaceId: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface RepoTarget {
  key: string;
  host: string;
  cwd: string;
  workspaceId: string;
  workspaceName: string;
}

const REF_RE = /^(issue|pr):([a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+)#(\d{1,9})$/;

const isNotice = (d: Pick<WorkspaceDecision, 'options'>): boolean =>
  d.options.length === 1 && d.options[0] === PROPOSAL_NOTICE_OPTION;

export class MoaProposalService {
  private timer: unknown = null;
  private timerMs = 0;
  /** Bumped by stop(): a scan from an older generation stops at its next step. */
  private generation = 0;
  private scanning: Promise<void> | null = null;
  private readonly answering = new Set<string>();
  /** What the last sync saw; undefined before the first one. */
  private last: { on: boolean; hq: string | null } | undefined;

  constructor(private readonly ports: MoaProposalPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private notify(workspaceId: string): void {
    try {
      this.ports.notifyCard?.(workspaceId);
    } catch {
      /* best-effort */
    }
  }

  /** On, Moa ready, and the lane switched on. */
  enabled(): boolean {
    return this.ports.moaReady() && this.ports.hqWorkspaceId() !== null && this.ports.config().issueProposals === true;
  }

  /**
   * Match the scan to the settings, the switch and the HQ. Call it on every
   * settings write and workspace mirror push (a cold boot learns the HQ is
   * present only from the mirror). Off = no timer, no gh call. An observed
   * turn-off, or the HQ changing, takes the lane's pending cards down. The
   * first sync never does: at a cold boot the HQ is not visible yet, and a
   * card left from the last run is inert to every brain anyway.
   */
  sync(): void {
    const on = this.enabled();
    const hq = this.ports.hqWorkspaceId();
    const prev = this.last;
    this.last = { on, hq };
    const hqChanged = prev !== undefined && prev.hq !== hq;
    if (!on || hqChanged) {
      this.stop();
      if (hqChanged || (prev?.on === true && !on)) void this.retireCards();
      if (!on) return;
    }
    const ms = this.ports.config().issuePollMinutes * 60_000;
    if (this.timer !== null && this.timerMs === ms) return;
    this.stop();
    this.timerMs = ms;
    this.arm(Math.min(FIRST_SCAN_DELAY_MS, ms));
  }

  stop(): void {
    if (this.timer !== null) (this.ports.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    this.timerMs = 0;
    this.generation += 1;
  }

  private arm(ms: number): void {
    const set = this.ports.setTimer ?? ((fn: () => void, d: number) => {
      const t = setTimeout(fn, d);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    const gen = this.generation;
    this.timer = set(() => {
      void this.scan().finally(() => {
        if (gen === this.generation) this.arm(this.timerMs);
      });
    }, ms);
  }

  /** One scan of every open repo. Overlapping calls share one run. */
  scan(): Promise<void> {
    if (!this.scanning) {
      this.scanning = this.runScan().finally(() => {
        this.scanning = null;
      });
    }
    return this.scanning;
  }

  private async targets(): Promise<RepoTarget[]> {
    const hq = this.ports.hqWorkspaceId();
    const ignored = new Set(this.ports.config().ignoredRepos);
    const byRepo = new Map<string, RepoTarget>();
    for (const ws of this.ports.workspaces()) {
      if (!ws.cwd || ws.id === hq || this.ports.isTaskWorkspace(ws.id)) continue;
      const remote = await this.ports.remote(ws.cwd).catch(() => null);
      if (!remote?.key || !this.ports.isGithubHost(remote.host) || ignored.has(remote.key)) continue;
      // The repo's main workspace: the first one on it, in sidebar order.
      if (!byRepo.has(remote.key)) {
        byRepo.set(remote.key, { key: remote.key, host: remote.host, cwd: ws.cwd, workspaceId: ws.id, workspaceName: ws.name });
      }
    }
    return [...byRepo.values()];
  }

  private async runScan(): Promise<void> {
    const gen = this.generation;
    // Every await below can outlast a switch-off: re-check before each step.
    const live = (): boolean => gen === this.generation && this.enabled();
    if (!live()) return;
    if (this.recover()) await this.ports.store.save();
    this.sweep();
    for (const t of await this.targets()) {
      if (!live()) break;
      if (!(await this.ports.gate(t.cwd, t.host).catch(() => false)) || !live()) continue;
      const viewer = await this.ports.viewerLogin(t.cwd, t.host).catch(() => null);
      if (!live()) break;
      const items = await this.ports.listItems(t.cwd, t.key).catch(() => null);
      if (!items || !live()) continue;
      await this.scanRepo(t, items, viewer, live);
      await this.ports.store.save();
    }
  }

  private async scanRepo(t: RepoTarget, items: RepoItem[], viewer: string | null, live: () => boolean): Promise<void> {
    const { store } = this.ports;
    const now = this.now();
    const max = items.reduce((m, i) => Math.max(m, i.number), 0);
    const seen = store.repo(t.key);
    if (!seen || now - seen.scannedAt > REARM_AFTER_MS) {
      store.setRepo(t.key, Math.max(max, seen?.watermark ?? 0), now);
      return;
    }
    // No hand-off path yet: leave new items unseen until there is one.
    if (!this.ports.handoff()) {
      store.setRepo(t.key, seen.watermark, now);
      return;
    }
    const fresh = items
      .filter((i) => i.number > seen.watermark && !store.get(proposalKey(t.key, i)))
      .sort((a, b) => a.number - b.number);
    const cfg = this.ports.config();
    const [host, owner, repo] = t.key.split('/');
    let watermark = seen.watermark;
    for (const item of fresh) {
      if (!live()) break;
      const key = proposalKey(t.key, item);
      const base = {
        key, repo: t.key, kind: item.kind, number: item.number, url: item.url,
        title: sanitizeProposalTitle(item.title), workspaceId: t.workspaceId,
        author: item.author, ...(item.draft ? { draft: true } : {}), at: now,
      };
      if (this.ports.hasWorkLink({ kind: item.kind, host, owner, repo, number: item.number })) {
        store.put({ ...base, state: 'skipped' });
      } else {
        const route = routeProposal(item, viewer, cfg.trustedAuthors, this.ports.modeOf(t.workspaceId));
        if (route === 'skip-bot' || route === 'skip-owner') {
          store.put({ ...base, state: 'skipped' });
        } else if (route === 'auto') {
          if (!live()) break;
          // Recorded (and saved) before and after: a hand-off is never tried twice.
          store.put({ ...base, state: 'auto-failed' });
          await store.save();
          const res = await this.handOff(base);
          if (res.ok) store.put({ ...base, state: 'auto' });
          else console.warn(`[moa:issue-proposals] auto hand-off of ${key} did not go through; it waits for a card: ${res.message}`);
        } else {
          store.put({ ...base, state: 'queued' });
        }
      }
      watermark = Math.max(watermark, item.number);
    }
    store.setRepo(t.key, watermark, now);
    if (live()) await this.raiseNext(t);
  }

  /** Raise a card for this repo's lowest queued item, when its slot is free. */
  private async raiseNext(t: RepoTarget): Promise<void> {
    const { store } = this.ports;
    const next = store.cardWanted(t.key)[0];
    if (!next) return;
    const [host, owner, repo] = t.key.split('/');
    if (this.ports.hasWorkLink({ kind: next.kind, host, owner, repo, number: next.number })) {
      store.put({ ...next, state: 'skipped', at: this.now() });
      return;
    }
    const card = buildProposalCard(
      t.key,
      { kind: next.kind, number: next.number, title: next.title, author: next.author ?? '', url: next.url, draft: next.draft === true },
      t.workspaceName,
    );
    const decision = await this.ports.decisions.raiseIfFree(t.workspaceId, { ...card, origin: 'issue-proposal', ref: next.key });
    if (!decision) return;
    store.put({ ...next, workspaceId: t.workspaceId, state: 'pending', decisionId: decision.id, at: this.now() });
    await store.save();
    this.notify(t.workspaceId);
  }

  private async handOff(r: Pick<ProposalRecord, 'kind' | 'repo' | 'number' | 'url' | 'title' | 'workspaceId'>): Promise<MoaHandoffResult> {
    const port = this.ports.handoff();
    if (!port) return { ok: false, message: 'the hand-off path is not available in this build' };
    const [host, owner, repo] = r.repo.split('/');
    try {
      return await port({ kind: r.kind, host, owner, repo, number: r.number, url: r.url, title: r.title, workspaceId: r.workspaceId });
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Re-own lane cards the records lost (the card was written, the app stopped
   * before its record was). The card carries its item key. Returns whether a
   * record changed.
   */
  recover(): boolean {
    const { store } = this.ports;
    let changed = false;
    let all: Record<string, WorkspaceDecision>;
    try {
      all = this.ports.decisions.all();
    } catch {
      return false;
    }
    for (const [workspaceId, d] of Object.entries(all)) {
      if (d.origin !== 'issue-proposal' || !d.ref || store.byDecision(d.id)) continue;
      const m = REF_RE.exec(d.ref);
      if (!m) continue;
      const known = store.get(d.ref);
      const base: ProposalRecord = known ?? {
        key: d.ref, repo: m[2], kind: m[1] as 'issue' | 'pr', number: Number(m[3]),
        url: '', title: '', workspaceId, state: 'pending', at: this.now(),
      };
      store.put({ ...base, workspaceId, state: isNotice(d) ? 'failed' : 'pending', decisionId: d.id, at: this.now() });
      changed = true;
    }
    return changed;
  }

  /** Is this decision one of the lane's cards? */
  owns(workspaceId: string, decisionId: string): boolean {
    const r = this.ports.store.byDecision(decisionId);
    return !!r && r.workspaceId === workspaceId;
  }

  /**
   * A resolved decision: when it is one of the lane's cards, act on the answer,
   * clear the decision and return true (the caller must not resume a brain
   * with it). Otherwise false.
   */
  async handleResolved(workspaceId: string, decision: WorkspaceDecision): Promise<boolean> {
    if (decision.status !== 'resolved') return false;
    if (decision.origin === 'issue-proposal' && !this.ports.store.byDecision(decision.id) && this.recover()) {
      await this.ports.store.save();
    }
    const r = this.ports.store.byDecision(decision.id);
    if (!r || r.workspaceId !== workspaceId) return false;
    if (this.answering.has(decision.id)) return true;
    this.answering.add(decision.id);
    try {
      await this.ports.decisions.clearResolved(workspaceId, decision.id).catch(() => undefined);
      this.notify(workspaceId);
      if (r.state !== 'pending') {
        // The failure notice, acknowledged.
        this.ports.store.put({ ...r, decisionId: undefined, at: this.now() });
        await this.ports.store.save();
        return true;
      }
      const answer = (decision.resolution ?? '').trim();
      let state: ProposalState = 'not-now';
      let notice: string | null = null;
      if (answer === PROPOSAL_OPTIONS.ignoreRepo) {
        state = 'ignored';
        if (!(await this.ports.ignoreRepo(r.repo).catch(() => false))) {
          notice = 'the repo could not be added to Settings › Moa › Ignored repos';
        }
      } else if (answer === PROPOSAL_OPTIONS.handOff) {
        if (!this.ports.moaReady()) {
          // Nothing was sent: the item waits for a new card once Moa is back.
          state = 'retry';
          console.warn(`[moa:issue-proposals] ${r.key}: Hand off answered while Moa is off; it will be proposed again`);
        } else {
          const res = await this.handOff(r);
          state = res.ok ? 'handed-off' : 'failed';
          if (!res.ok) {
            console.warn(`[moa:issue-proposals] hand-off of ${r.key} failed: ${res.message}`);
            notice = res.message;
          }
        }
      }
      this.ports.store.put({ ...r, state, decisionId: undefined, at: this.now() });
      if (notice !== null) {
        const what = r.kind === 'issue' ? 'issue' : 'PR';
        const verb = state === 'ignored' ? 'ignore the repo of' : 'hand off';
        const d = await this.ports.decisions.raiseIfFree(workspaceId, {
          question: `Could not ${verb} ${what} ${repoName(r.repo)}#${r.number} "${r.title}": ${sanitizeProposalTitle(notice)}`,
          options: [PROPOSAL_NOTICE_OPTION],
          context: state === 'ignored'
            ? `${r.url}\nAdd it to Settings › Moa › Ignored repos by hand.`
            : `${r.url}\nMoa will not propose it again. Open it from the Git page to hand it off by hand.`,
          origin: 'issue-proposal',
          ref: r.key,
        }).catch(() => null);
        if (d) {
          this.ports.store.put({ ...r, state, decisionId: d.id, at: this.now() });
          this.notify(workspaceId);
        }
      }
      await this.ports.store.save();
      return true;
    } finally {
      this.answering.delete(decision.id);
    }
  }

  /**
   * Reconcile the lane's cards with the decision store (run on every decision
   * write): a lost card is re-owned, an answered card is handled, a card that
   * is gone is expired.
   */
  sweep(): void {
    const { store, decisions } = this.ports;
    let changed = this.recover();
    for (const r of store.withDecision()) {
      const id = r.decisionId as string;
      const d = decisions.load(r.workspaceId);
      if (d && d.id === id) {
        if (d.status === 'resolved') void this.handleResolved(r.workspaceId, d);
        continue;
      }
      if (this.answering.has(id)) continue;
      store.put({ ...r, state: r.state === 'pending' ? 'expired' : r.state, decisionId: undefined, at: this.now() });
      changed = true;
    }
    if (changed) void store.save();
  }

  /** Take the lane's pending cards down (the lane stopped or the HQ changed):
   *  each is recorded as expired, a failure notice simply goes. */
  private async retireCards(): Promise<void> {
    const { store, decisions } = this.ports;
    let changed = this.recover();
    for (const r of store.withDecision()) {
      const id = r.decisionId as string;
      const d = decisions.load(r.workspaceId);
      // A resolved card is an answer, which handleResolved still owes.
      if (d && d.id === id && d.status === 'resolved') continue;
      if (d && d.id === id && !(await decisions.clearPendingIfUnchanged(r.workspaceId, d).catch(() => false))) continue;
      store.put({ ...r, state: r.state === 'pending' ? 'expired' : r.state, decisionId: undefined, at: this.now() });
      changed = true;
      this.notify(r.workspaceId);
    }
    if (changed) await store.save();
  }
}
