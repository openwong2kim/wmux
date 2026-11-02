// ─── The act executor — runs the acts the owner approved ───────────────────
//
// One try of an approved act (a comment, a new issue, closing an issue or a
// PR), from its row in the act outbox (actEffectStore.ts), under the same
// gates the merge executor puts a merge through:
//
//   reconcile   a row that may have run (uncertain, or pending after an
//               earlier try) is read on GitHub first — by the marker in the
//               body, or the target's state and who closed it — and nothing
//               is sent while that read cannot say;
//   claim       journaled inFlight before anything is sent;
//   authorize   the approval store: the request is approved now, by the
//               owner, with the same payload, its Undo window over, its bot
//               still there on the same repository. Taken back (Undo) or
//               not due: the row returns to pending, nothing written;
//   identity    the gh login is the one the request recorded;
//   pins        the repository still answers as the full name, node id and
//               numeric id the request read (writes go to `repos/<owner>/
//               <repo>`: GitHub's `repositories/<id>` paths answer reads but
//               are undocumented, so no write goes through them), the target
//               is the same node, open, and on
//               a PR still at the head the card showed;
//   late gate   authorize again, right before the write;
//   write       gh api with a JSON body main built (GhActService.ts); the
//               answer must be what the act makes (a comment by the owner's
//               login holding the marker, …), else the try is uncertain.
//
// GitHub's 4xx is a refusal (nothing was written); a rate limit or a gh that
// did not start gives the try back; anything else is uncertain and settled
// by a read no sooner than RECONCILE_AFTER_MS later. A refusal is final for
// its request: the bot asks again with a new request. A row no try of which
// started (actRowClaimed) a day after its approval is refused
// `approval-stale` before it is claimed (approvals.ts authorizeAct): a try
// whose reads keep failing gives itself back, so its count never runs out.
// A claimed row has its own bound (actEffectStore.ts actStalledTooLong): its
// reads GitHub did not answer are counted, and past the bound no write is
// sent for it again. A read that finds nothing then refuses it
// `approval-stale` (nothing was done), one that finds the act settles it as
// ever, and while reads still cannot say the owner is told it may have gone
// through (`stalled`).
//
// A release (releaseAct.ts) runs its own steps after the pins: the default
// branch, the commit on it, the tag and the release still free, the checks
// on the commit; then either the tag alone (its workflow publishes it), or a
// draft whose id is journaled, the late gate, and publishing that draft with
// the approved fields. A 4xx from publishing is uncertain, settled by a read
// later (GitHub was measured making a tag on a 4xx from a call that
// publishes). Once a row's draft is on GitHub the row stays claimed (a
// restart keeps its approval), and any refusal or drop of the row deletes
// that draft while it is still a draft, unless the act's tag is made at the
// commit (or cannot be read): a publish that stopped after making the tag
// keeps its draft for the owner, since deleting it would leave the tag with
// no release. A kept draft, or one whose delete failed, adds a code to the
// row's refusal (DRAFT_FATE_CODE), so the owner is told. The decision is
// journaled (decideDraft); a draft a quit, or a read GitHub did not answer,
// left open is decided by a later sweep, and its request's refusal is
// amended then.

import type { GhActAnswer, GhActPort } from '../github/GhActService';
import type { ApprovalAct, ApprovalActRepo, ApprovalReleaseAct } from '../../shared/botApproval';
import { actMarker, bodyWithMarker, normalizeActText } from './actPayload';
import { ACT_MAX_ATTEMPTS, actRowClaimed, actStalledTooLong, draftUndecided, draftUnansweredTooLong, runnableAct, type ActEffect, type ActEffectStore } from './actEffectStore';
import type { StoredApproval } from './approvals';
import { failed, isFail, loginOf, readPaged, readRefusal, rec, repoPath, str, type Read, type ReadFail } from './actRead';
import { laneRefusalLine } from './laneRefusalText';
import {
  type DraftFate, deleteDraft, draftBody, draftWritten, findRelease, mapRelease, publishBody, publishedWritten, readTagTarget, releasePrecondition,
  tagIsOurs, tagRefBody, tagRefWritten, tagRunsUrl,
} from './releaseAct';

export { repoPath };

/** The acts that take one write (a release has its own steps). */
type OneWriteAct = Exclude<ApprovalAct, ApprovalReleaseAct>;

/** How long an uncertain try waits before a read settles it. */
export const RECONCILE_AFTER_MS = 60_000;

/** The refusal code a release draft adds to its row's reason when it stays
 *  on GitHub: kept (its tag made, or not checked), or not deleted. */
const DRAFT_FATE_CODE: Partial<Record<DraftFate, string>> = {
  'kept-tag-made': 'draft-kept-tag-made',
  'kept-unchecked': 'draft-kept-unchecked',
  'kept-not-ours': 'draft-kept-changed',
  failed: 'draft-not-deleted',
};

/** Authorize answers that mean "not now", not "never": the row waits
 *  (the approval taken back or not due, the store or the bot directory not
 *  readable during a start or a quit). */
export const ACT_NOT_NOW: ReadonlySet<string> = new Set(['approval-not-approved', 'approval-undo-window', 'approval-not-running', 'bots-unreadable']);

export interface ActApprovalPort {
  request(requestId: string): StoredApproval | null;
  /** Null when the request behind the row allows it now, else why not. */
  authorize(effect: ActEffect): string | null;
}

export interface ActExecutorPorts {
  effects: ActEffectStore;
  gh: GhActPort;
  approval: ActApprovalPort;
  emit?: (effect: ActEffect) => void;
  /** A claimed row past its bound whose read still cannot say whether it
   *  went through (told on every such sweep; the listener tells once). */
  stalled?: (effect: ActEffect) => void;
  now?: () => number;
  log?: (line: string) => void;
  reconcileAfterMs?: number;
}

// ── GitHub reads (also the request-time reads, approvals.ts) ───────────────


export interface IssueFacts {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  locked: boolean;
  isPr: boolean;
  title: string;
  closedBy: string | null;
  /** `state_reason` (completed, not_planned, reopened), or null. */
  stateReason: string | null;
  closedAt: number | null;
  url: string;
}

export interface PullFacts {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
  title: string;
  url: string;
}

/** The gh login, or why not. An answer without a status (a rate limit, a
 *  timeout, GitHub's 5xx, a gh not started) says nothing about who is
 *  signed in; one with a status is GitHub's own answer. */
export async function readIdentity(gh: GhActPort, host: string): Promise<Read<string>> {
  const a = await gh.read(host, 'user');
  if (!a.ok) return failed(a);
  return loginOf(a.value) ?? { error: 'GitHub named no login', status: 200 };
}

export async function readLogin(gh: GhActPort, host: string): Promise<string | null> {
  const a = await readIdentity(gh, host);
  return typeof a === 'string' ? a : null;
}

/** The repository as a request pins it, and the default branch GitHub
 *  names now (`''` when it names none), which is not pinned. */
export async function readRepo(gh: GhActPort, repoKey: string): Promise<Read<ApprovalActRepo & { defaultBranch: string }>> {
  const p = repoPath(repoKey);
  if (!p) return { error: 'not a GitHub repository' };
  const a = await gh.read(p.host, p.base);
  if (!a.ok) return failed(a);
  const v = rec(a.value);
  const fullName = str(v?.full_name);
  const nodeId = str(v?.node_id);
  return fullName && nodeId && typeof v?.id === 'number'
    ? { fullName, nodeId, id: v.id, defaultBranch: str(v.default_branch) } : { error: 'the repository could not be read' };
}

export function mapIssue(value: unknown): IssueFacts | null {
  const v = rec(value);
  if (!v || typeof v.number !== 'number' || !str(v.node_id)) return null;
  return {
    number: v.number, nodeId: str(v.node_id), state: v.state === 'closed' ? 'closed' : 'open', locked: v.locked === true,
    isPr: rec(v.pull_request) !== null, title: str(v.title), closedBy: loginOf(v.closed_by),
    stateReason: str(v.state_reason) || null, closedAt: Number.isFinite(Date.parse(str(v.closed_at))) ? Date.parse(str(v.closed_at)) : null,
    url: str(v.html_url),
  };
}

export function mapPull(value: unknown): PullFacts | null {
  const v = rec(value);
  const head = rec(v?.head);
  if (!v || typeof v.number !== 'number' || !str(v.node_id) || !str(head?.sha)) return null;
  return {
    number: v.number, nodeId: str(v.node_id), state: v.state === 'closed' ? 'closed' : 'open', merged: v.merged === true,
    headSha: str(head?.sha), title: str(v.title), url: str(v.html_url),
  };
}

export async function readIssue(gh: GhActPort, repoKey: string, n: number): Promise<Read<IssueFacts>> {
  const p = repoPath(repoKey);
  if (!p) return { error: 'not a GitHub repository' };
  const a = await gh.read(p.host, `${p.base}/issues/${n}`);
  if (!a.ok) return failed(a);
  return mapIssue(a.value) ?? { error: 'the issue could not be read' };
}

export async function readPull(gh: GhActPort, repoKey: string, n: number): Promise<Read<PullFacts>> {
  const p = repoPath(repoKey);
  if (!p) return { error: 'not a GitHub repository' };
  const a = await gh.read(p.host, `${p.base}/pulls/${n}`);
  if (!a.ok) return failed(a);
  return mapPull(a.value) ?? { error: 'the pull request could not be read' };
}

// ── What a write's answer must be ─────────────────────────────────────────

/** The result of a write whose answer is the act done as approved, or null
 *  (the try is uncertain). Pure. */
export function writeResult(r: Pick<StoredApproval, 'requestId' | 'ghLogin'>, act: ApprovalAct, value: unknown): ActEffect['result'] | null {
  const v = rec(value);
  if (!v) return null;
  const url = str(v.html_url);
  if (!/^https:\/\//.test(url)) return null;
  const by = loginOf(v.user);
  switch (act.kind) {
    case 'comment':
      return typeof v.id === 'number' && by === r.ghLogin && str(v.body).includes(actMarker(r.requestId)) ? { url, id: v.id } : null;
    case 'issue_create':
      return typeof v.number === 'number' && rec(v.pull_request) === null && by === r.ghLogin && str(v.body).includes(actMarker(r.requestId))
        ? { url, number: v.number } : null;
    case 'issue_close':
      return v.number === act.number && v.state === 'closed' ? { url, number: act.number } : null;
    case 'pr_close':
      return v.number === act.number && v.state === 'closed' && v.merged !== true ? { url, number: act.number } : null;
    case 'release':
      // Checked by its own steps (releaseAct.ts), never from one answer.
      return null;
  }
}

// ── The executor ───────────────────────────────────────────────────────────

/** What a read says of a row that may have run. `draft`: a release's own
 *  draft, still on GitHub; `result`: what a refusal still made (a release
 *  published on a tag that points elsewhere). */
type Found =
  | { status: 'done'; result: NonNullable<ActEffect['result']> }
  | { status: 'refused'; reason: string; result?: ActEffect['result']; draft?: number }
  | { status: 'none'; draft?: number; tagMade?: true }
  | { status: 'unknown'; error?: string };

/** What the owner is told of a read that could not say, with no error of its own. */
const READ_UNSAID = 'GitHub could not be read';

/** How one claimed try ends (runOnce's own moves). */
interface TryEnds {
  gate: () => string | null;
  end: (status: 'done' | 'refused' | 'uncertain', reason?: string, result?: ActEffect['result']) => Promise<ActEffect | null>;
  back: (reason: string, error?: string) => ActEffect | null;
}

export class ActExecutor {
  private readonly running = new Map<string, Promise<ActEffect | null>>();
  private readonly now: () => number;

  constructor(private readonly ports: ActExecutorPorts) {
    this.now = ports.now ?? Date.now;
  }

  /** Run one row's next step. Concurrent calls for one id share the run. */
  run(id: string): Promise<ActEffect | null> {
    const live = this.running.get(id);
    if (live) return live;
    const p = this.runOnce(id).catch((err: unknown) => {
      this.ports.log?.(`[factory] act ${id} failed: ${String(err)}`);
      return this.ports.effects.get(id);
    }).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  /** Wait for the runs under way. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  /** Startup and the sweep: settle the rows that may have run, run the
   *  pending rows whose request allows it now, and settle the pending rows
   *  whose request never will (the run refuses them); drop the rows whose
   *  request is gone; decide the drafts of refused rows a quit left
   *  undecided. */
  async reconcileAll(): Promise<void> {
    for (const row of this.ports.effects.list()) {
      if (draftUndecided(row)) {
        await this.run(row.id);
        continue;
      }
      if (row.status === 'done' || row.status === 'refused') {
        // An ended row outlives its request only when its drop was not
        // written: dropped again.
        if (this.ports.approval.authorize(row) === 'approval-missing') this.ports.effects.drop(row.id);
        continue;
      }
      if (!runnableAct(row) || (row.status !== 'uncertain' && row.status !== 'pending')) continue;
      const denied = this.ports.approval.authorize(row);
      if (denied === 'approval-missing') await this.orphaned(row);
      else if (row.status === 'uncertain' || denied === null || !ACT_NOT_NOW.has(denied)) await this.run(row.id);
    }
  }

  /** A row whose request is gone: the act's text and login went with it, so
   *  no read can settle it. Dropped, and logged; a claimed row only once its
   *  read window passed. */
  private async orphaned(row: ActEffect): Promise<void> {
    const claimed = actRowClaimed(row);
    if (claimed && this.now() - (row.startedAt ?? row.updatedAt) < (this.ports.reconcileAfterMs ?? RECONCILE_AFTER_MS)) return;
    // Its draft first: a quit before the row is dropped decides it again
    // (a draft deleted then reads as gone); GitHub not answering keeps the
    // row for a later sweep.
    if ((await this.dropDraft(row))?.fate === 'retry') return;
    if (!this.ports.effects.drop(row.id)) return;
    this.ports.log?.(`[factory] act ${row.action} ${row.requestId} dropped: its request is gone (${row.status}, attempt ${row.attempt}${claimed ? '; whether it reached GitHub is not known' : ''})`);
  }

  /** A release row that ended refused, or was dropped, with a draft of its
   *  own on GitHub: the draft goes while it is still a draft (deleteDraft
   *  keeps one published since, changed, or whose tag is made at the commit
   *  or cannot be checked: the act's tag and commit, or the draft's own when
   *  the request is gone), and the log says what became of it. Its fate (null:
   *  no draft) and the code the row's refusal gains; `retry`: GitHub did not
   *  answer, counted on the row, and the draft stays open until that has
   *  lasted DRAFT_OPEN_MAX_MS over DRAFT_OPEN_MIN_TRIES reads at least: then
   *  it is kept, not checked, and told. */
  private async dropDraft(row: ActEffect | null): Promise<{ fate: DraftFate; code: string | null } | null> {
    if (!row || row.action !== 'release' || row.draftId === undefined) return null;
    const p = repoPath(row.repoKey);
    const act = this.ports.approval.request(row.requestId)?.act;
    const want = act?.kind === 'release' ? act : undefined;
    let fate: DraftFate = p ? await deleteDraft(this.ports.gh, p, row.draftId, want).catch(() => 'retry' as const) : 'kept-unchecked';
    if (fate === 'retry') {
      const counted = this.ports.effects.noteDraftUnanswered(row.id, this.now()) ?? row;
      if (draftUnansweredTooLong(counted, this.now())) fate = 'kept-unchecked';
    }
    const code = DRAFT_FATE_CODE[fate] ?? null;
    this.ports.log?.(`[factory] act release ${row.requestId}: its draft ${row.draftId}: ${fate}${code ? ` (${laneRefusalLine(code, row.repoKey)})` : ''}`);
    return { fate, code };
  }

  /** A row that ended refused: its release draft settled (dropDraft), the
   *  decision journaled, and its reason told when the draft stays on
   *  GitHub. A decision not journaled is told all the same (a new row
   *  object); the row stays undecided and the next sweep decides it again.
   *  `retry` returns the row itself: nothing decided. */
  private async refusedDraft(out: ActEffect | null): Promise<ActEffect | null> {
    if (!out || !draftUndecided(out)) return out;
    const decided = await this.dropDraft(out);
    // GitHub did not answer: the draft stays open for a later sweep.
    if (decided?.fate === 'retry') return out;
    const reason = decided?.code ? `${out.reason ?? 'refused'}, ${decided.code}` : undefined;
    return this.ports.effects.decideDraft(out.id, reason) ?? { ...out, ...(reason ? { reason } : {}) };
  }

  private emit(e: ActEffect | null): void {
    if (!e) return;
    try { this.ports.emit?.(e); } catch { /* a listener never breaks the outbox */ }
  }

  private async runOnce(id: string): Promise<ActEffect | null> {
    const { effects } = this.ports;
    let row = effects.get(id);
    if (!row) return row;
    if (draftUndecided(row)) {
      // A refusal whose draft a quit, or a read GitHub did not answer, left
      // open. Its request gone is the approvals' own answer: while they are
      // not up (a start), nothing is decided.
      const gone = this.ports.approval.authorize(row) === 'approval-missing';
      if (!gone && !this.ports.approval.request(row.requestId)) return row;
      const out = await this.refusedDraft(row);
      if (!out || out === row) return out;
      this.emit(out);
      // A request that is gone keeps no row once its draft is decided.
      if (gone && !draftUndecided(out)) effects.drop(out.id);
      return out;
    }
    if (!runnableAct(row)) return row;
    if (row.status === 'uncertain' || (row.status === 'pending' && actRowClaimed(row))) {
      // A try that may have landed (or an earlier try that ended without
      // proof either way): read GitHub before anything is sent again.
      if (row.status === 'uncertain' && this.now() - (row.startedAt ?? row.updatedAt) < (this.ports.reconcileAfterMs ?? RECONCILE_AFTER_MS)) return row;
      const settled = await this.reconcile(row);
      if (settled === 'unknown') return row;
      row = settled;
    }
    if (!row || row.status !== 'pending') return row;
    // An approval no try of which started in a day (its reads kept failing,
    // say) ends here, before a try is claimed: nothing was sent for it.
    if (!actRowClaimed(row) && this.ports.approval.authorize(row) === 'approval-stale') {
      const out = effects.settle(id, 'refused', 'approval-stale');
      this.ports.log?.(`[factory] act ${row.action} ${row.requestId} ${out?.status ?? 'refused'} (approval-stale)`);
      this.emit(out);
      return out;
    }
    const claimed = effects.claim(id);
    if (!claimed) return effects.get(id);
    this.emit(claimed);
    const end = async (status: 'done' | 'refused' | 'uncertain', reason?: string, result?: ActEffect['result']): Promise<ActEffect | null> => {
      const out = await this.refusedDraft(effects.finish(id, status, reason, result));
      this.ports.log?.(`[factory] act ${claimed.action} ${claimed.requestId} ${out?.status ?? status}${out?.reason ? ` (${out.reason})` : ''}`);
      this.emit(out);
      return out;
    };
    // Nothing of this try reached GitHub: it is given back (a row whose
    // draft is on GitHub stays claimed by its draftId, not its count). A
    // read that failed is counted towards the row's bound (only a claimed
    // row's: an unclaimed one has its approval's).
    const back = (reason: string, error?: string): ActEffect | null => {
      let out = effects.release(id, reason);
      if (out && reason === 'read-failed') out = effects.noteReadUnanswered(id, error ?? READ_UNSAID) ?? out;
      this.emit(out);
      return out;
    };
    const stop = (denied: string): Promise<ActEffect | null> | ActEffect | null => (ACT_NOT_NOW.has(denied) ? back(denied) : end('refused', denied));
    try {
      const gate = (): string | null => this.ports.approval.authorize(claimed);
      const denied = gate();
      if (denied) return await stop(denied);
      const r = this.ports.approval.request(claimed.requestId);
      const act = r?.act;
      const p = r ? repoPath(r.repoKey) : null;
      if (!r || !act || !p || !r.actRepo || !r.ghLogin) return end('refused', 'approval-mismatch');
      const login = await readIdentity(this.ports.gh, p.host);
      if (isFail(login)) return login.status === undefined ? back('read-failed', login.error) : end('refused', 'identity-unknown');
      if (login !== r.ghLogin) return end('refused', 'identity-changed');
      // Its default branch is the one a release reads (not pinned).
      const repo = await readRepo(this.ports.gh, r.repoKey);
      if (isFail(repo)) {
        const why = readRefusal(repo, 'repo-changed');
        return why === 'read-failed' ? back(why, repo.error) : end('refused', why);
      }
      // The name, node id and numeric id the request read (a rename or a
      // transfer changes the name; a repository made again changes the ids).
      if (repo.fullName.toLowerCase() !== r.actRepo.fullName.toLowerCase() || repo.nodeId !== r.actRepo.nodeId || repo.id !== r.actRepo.id) return end('refused', 'repo-changed');
      if (act.kind === 'release') return await this.runRelease(id, claimed, { login: r.ghLogin, branch: repo.defaultBranch }, act, p, { gate, end, back });
      const pre = await this.precondition(r.repoKey, act);
      if (isFail(pre)) return back('read-failed', pre.error);
      if (pre) return end('refused', pre);
      const late = gate();
      if (late) return await stop(late);
      const ans = await this.write(p, r, act);
      if (ans.ok) {
        const result = writeResult(r, act, ans.value);
        return result ? end('done', undefined, result) : end('uncertain', 'unexpected-response');
      }
      if (ans.kind === 'http') return end('refused', `gh-${ans.status}`);
      if (ans.kind === 'rate-limited' || ans.kind === 'unsent') return back(ans.kind);
      return end('uncertain', 'write-error');
    } catch (err) {
      this.ports.log?.(`[factory] act ${id} failed: ${String(err)}`);
      return end('uncertain', 'executor-error');
    }
  }

  /** A release's try from its preconditions on (releaseAct.ts): the tag
   *  alone (`workflow`), or a draft, then the late gate, then publishing it
   *  (`release`). A refusal deletes the row's draft (`end`), unless its
   *  tag is made at the commit (refusedDraft). */
  private async runRelease(id: string, claimed: ActEffect, o: { login: string; branch: string }, act: ApprovalReleaseAct, p: { host: string; base: string }, t: TryEnds): Promise<ActEffect | null> {
    const gh = this.ports.gh;
    const { effects } = this.ports;
    const { login } = o;
    // An earlier try of the row may have written (its count was kept).
    const pre = await releasePrecondition(gh, p, act, { login, branch: o.branch, draftId: claimed.draftId, wroteBefore: claimed.attempt > 1 });
    // This act's draft, found by its content after a crash: journaled now,
    // so a refusal deletes it and the next try publishes it.
    let draft = pre.draft;
    if (draft && claimed.draftId !== draft.id && !effects.noteDraft(id, draft.id)) return this.unjournaled(id, claimed, draft.id);
    if (pre.refusal === 'read-failed') return t.back(pre.refusal);
    if (pre.refusal) return t.end('refused', pre.refusal);
    if (act.mode === 'release' && !draft) {
      // Write 1: a draft, which makes no tag (a 4xx on it leaves none).
      const ans = await gh.write(p.host, 'POST', `${p.base}/releases`, draftBody(act));
      if (!ans.ok) {
        if (ans.kind === 'http') return t.end('refused', `gh-${ans.status}`);
        if (ans.kind === 'rate-limited' || ans.kind === 'unsent') return t.back(ans.kind);
        return t.end('uncertain', 'write-error');
      }
      draft = draftWritten(ans.value, act, login);
      if (!draft) {
        // A draft of this tag by the owner's login, not as approved: its id
        // is journaled so a read finds it (and a refusal deletes it).
        const made = mapRelease(ans.value);
        if (made?.draft && made.tagName === act.tagName && made.author === login) effects.noteDraft(id, made.id);
        return t.end('uncertain', 'unexpected-response');
      }
      if (!effects.noteDraft(id, draft.id)) return this.unjournaled(id, claimed, draft.id);
    }
    // The late gate, right before the write that makes the tag: the approval
    // again, then the tag still free (or made at the commit by an earlier
    // publish of this very draft).
    const denied = t.gate();
    if (denied) return ACT_NOT_NOW.has(denied) ? t.back(denied) : t.end('refused', denied);
    const tag = await readTagTarget(gh, p, act.tagName);
    if (isFail(tag)) {
      const why = readRefusal(tag, 'tag-taken');
      return why === 'read-failed' ? t.back(why, tag.error) : t.end('refused', why);
    }
    if (tag !== null && !tagIsOurs(act, tag, draft)) return t.end('refused', 'tag-taken');
    if (act.mode === 'workflow') {
      const ans = await gh.write(p.host, 'POST', `${p.base}/git/refs`, tagRefBody(act));
      if (ans.ok) return tagRefWritten(ans.value, act) ? t.end('done', undefined, { url: tagRunsUrl(p, act) }) : t.end('uncertain', 'unexpected-response');
      if (ans.kind === 'http' && ans.status === 422 && /already exists/i.test(ans.message)) {
        // The tag exists: at the commit it is what this act makes (as a
        // read settles it); elsewhere it is someone else's.
        const at = await readTagTarget(gh, p, act.tagName);
        if (isFail(at) || at === null) return t.end('uncertain', 'gh-422');
        return at === act.targetSha ? t.end('done', undefined, { url: tagRunsUrl(p, act) }) : t.end('refused', 'tag-taken');
      }
      if (ans.kind === 'http') return t.end('refused', `gh-${ans.status}`);
      if (ans.kind === 'rate-limited' || ans.kind === 'unsent') return t.back(ans.kind);
      return t.end('uncertain', 'write-error');
    }
    if (!draft) return t.end('uncertain', 'executor-error');
    // Write 2: publish the draft with every approved field; this makes the tag.
    const ans = await gh.write(p.host, 'PATCH', `${p.base}/releases/${draft.id}`, publishBody(act));
    if (ans.ok) {
      const shown = publishedWritten(ans.value, act, login, draft.id);
      if (shown === 'different') return t.end('refused', 'found-different', { url: mapRelease(ans.value)?.url ?? '', id: draft.id });
      const at = shown ? await readTagTarget(gh, p, act.tagName) : null;
      if (!shown || at === null || isFail(at)) return t.end('uncertain', 'unexpected-response');
      // GitHub puts a release on a tag that exists, wherever it points: one
      // made since the late read is reported as it is, published.
      return at === act.targetSha ? t.end('done', undefined, shown) : t.end('refused', 'published-other-target', shown);
    }
    if (ans.kind === 'rate-limited' || ans.kind === 'unsent') return t.back(ans.kind);
    // A 4xx from a call that publishes is not proof nothing was published
    // (it can leave the tag made and the release a draft): a read settles it
    // after RECONCILE_AFTER_MS.
    return t.end('uncertain', ans.kind === 'http' ? `gh-${ans.status}` : 'write-error');
  }

  /** A draft whose id did not reach the journal: the row is uncertain in
   *  memory, and a read (the draft scan) settles it. */
  private unjournaled(id: string, claimed: ActEffect, draftId: number): ActEffect | null {
    this.ports.log?.(`[factory] act release ${claimed.requestId}: draft ${draftId} not journaled; a read settles it`);
    const row = this.ports.effects.get(id);
    this.emit(row);
    return row;
  }

  /** Why the act may not run on GitHub as it stands now, the read that
   *  failed (`read-failed`), or null. */
  private async precondition(repoKey: string, act: OneWriteAct): Promise<string | ReadFail | null> {
    const gh = this.ports.gh;
    const refusal = (e: ReadFail): string | ReadFail => {
      const why = readRefusal(e, 'target-gone');
      return why === 'read-failed' ? e : why;
    };
    if (act.kind === 'issue_create') return null;
    if (act.kind === 'pr_close') {
      const pr = await readPull(gh, repoKey, act.number);
      if (isFail(pr)) return refusal(pr);
      if (pr.nodeId !== act.targetNodeId) return 'target-changed';
      if (pr.merged) return 'merged';
      if (pr.state === 'closed') return 'already-closed';
      return pr.headSha === act.headSha ? null : 'head-moved';
    }
    const issue = await readIssue(gh, repoKey, act.number);
    if (isFail(issue)) return refusal(issue);
    if (issue.nodeId !== act.targetNodeId) return 'target-changed';
    if (act.kind === 'issue_close') {
      if (issue.isPr) return 'target-changed';
      return issue.state === 'closed' ? 'already-closed' : null;
    }
    if (issue.isPr !== (act.target === 'pr')) return 'target-changed';
    if (issue.locked) return 'locked';
    if (act.target === 'issue') return issue.state === 'closed' ? 'already-closed' : null;
    const pr = await readPull(gh, repoKey, act.number);
    if (isFail(pr)) return refusal(pr);
    if (pr.merged) return 'merged';
    if (pr.state === 'closed') return 'already-closed';
    return pr.headSha === act.headSha ? null : 'head-moved';
  }

  private write(p: { host: string; base: string }, r: StoredApproval, act: OneWriteAct): Promise<GhActAnswer> {
    const gh = this.ports.gh;
    switch (act.kind) {
      case 'comment':
        return gh.write(p.host, 'POST', `${p.base}/issues/${act.number}/comments`, { body: bodyWithMarker(act.body, r.requestId) });
      case 'issue_create':
        return gh.write(p.host, 'POST', `${p.base}/issues`, { title: act.title, body: bodyWithMarker(act.body, r.requestId) });
      case 'issue_close':
        return gh.write(p.host, 'PATCH', `${p.base}/issues/${act.number}`, { state: 'closed', state_reason: act.stateReason });
      case 'pr_close':
        return gh.write(p.host, 'PATCH', `${p.base}/pulls/${act.number}`, { state: 'closed' });
    }
  }

  /** Settle a row that may have run from a read of GitHub; `unknown` when
   *  the read cannot say (nothing is sent then: the read is counted, and a
   *  row past its bound is told). Past its bound, a row the read finds
   *  nothing of is refused, not tried again. */
  private async reconcile(row: ActEffect): Promise<ActEffect | null | 'unknown'> {
    const r = this.ports.approval.request(row.requestId);
    if (!r?.act || !r.ghLogin) return 'unknown';
    const found = await this.find(r, r.act, row).catch((err: unknown): Found => ({ status: 'unknown', error: String(err) }));
    if (found.status === 'unknown') {
      const counted = this.ports.effects.noteReadUnanswered(row.id, found.error ?? READ_UNSAID);
      if (counted && actStalledTooLong(counted, this.now())) {
        this.ports.log?.(`[factory] act ${row.action} ${row.requestId}: GitHub has not said for a day whether it went through; nothing more is sent (${counted.lastReadError ?? READ_UNSAID})`);
        try { this.ports.stalled?.(counted); } catch { /* a listener never breaks the outbox */ }
      }
      return 'unknown';
    }
    // A release's own draft found: journaled before the row is settled, so
    // the next try publishes it and a refusal (attempts exhausted included)
    // deletes it. Not journaled: nothing is settled, and the next sweep reads
    // again.
    const draft = found.status === 'refused' || found.status === 'none' ? found.draft : undefined;
    if (draft !== undefined && row.draftId !== draft && !this.ports.effects.noteDraft(row.id, draft)) {
      this.ports.log?.(`[factory] act release ${row.requestId}: draft ${draft} not journaled; the row is settled on a later read`);
      return 'unknown';
    }
    let next: ActEffect | null;
    // Its tag made with the release still a draft, and no try left: the
    // draft is kept for the owner to publish or delete (refusedDraft). Its
    // reads failed past its bound (actStalledTooLong): nothing of it is on
    // GitHub (a tag made aside), and no write is sent for it again.
    const stalled = actStalledTooLong(row, this.now());
    if (found.status === 'done') next = this.ports.effects.settle(row.id, 'done', undefined, found.result);
    else if (found.status === 'refused') next = this.ports.effects.settle(row.id, 'refused', found.reason, found.result);
    else if (found.tagMade && (row.attempt >= ACT_MAX_ATTEMPTS || stalled)) next = this.ports.effects.settle(row.id, 'refused', 'tag-made-not-published');
    else if (stalled) next = this.ports.effects.settle(row.id, 'refused', 'approval-stale');
    else next = this.ports.effects.settle(row.id, 'pending', 'not-found');
    next = await this.refusedDraft(next);
    if (next && (next.status !== row.status || next.reason !== row.reason)) this.emit(next);
    return next;
  }

  /** Whether the act is on GitHub as approved. */
  private async find(r: StoredApproval, act: ApprovalAct, row: ActEffect): Promise<Found> {
    const p = repoPath(r.repoKey);
    if (!p) return { status: 'unknown' };
    const gh = this.ports.gh;
    if (act.kind === 'release') return findRelease(gh, p, act, r.ghLogin as string, row.draftId);
    const since = new Date((row.firstStartedAt ?? row.createdAt) - RECONCILE_AFTER_MS).toISOString();
    const marker = actMarker(r.requestId);
    if (act.kind === 'comment' || act.kind === 'issue_create') {
      const endpoint = act.kind === 'comment'
        ? `${p.base}/issues/${act.number}/comments?since=${since}`
        : `${p.base}/issues?creator=${r.ghLogin}&state=all&since=${since}`;
      const list = await readPaged(gh, p.host, endpoint);
      if (isFail(list)) return { status: 'unknown', error: list.error };
      const mine = list.map(rec).filter((v): v is Record<string, unknown> => !!v
        && loginOf(v.user) === r.ghLogin && str(v.body).includes(marker) && (act.kind === 'comment' || rec(v.pull_request) === null));
      if (mine.length === 0) return { status: 'none' };
      const want = bodyWithMarker(act.body, r.requestId);
      const same = mine.find((v) => normalizeActText(str(v.body)) === want && (act.kind === 'comment' || normalizeActText(str(v.title)) === act.title));
      if (!same) return { status: 'refused', reason: 'found-different' };
      const url = str(same.html_url);
      return act.kind === 'comment'
        ? { status: 'done', result: { url, ...(typeof same.id === 'number' ? { id: same.id } : {}) } }
        : { status: 'done', result: { url, ...(typeof same.number === 'number' ? { number: same.number } : {}) } };
    }
    // A close is this try's only when the target is the node the request
    // read, closed as approved (an issue's reason; a PR unmerged at the
    // card's head), by the owner's login; when GitHub names nobody, closed
    // after this request's first try started.
    if (act.kind === 'pr_close') {
      const pr = await readPull(gh, r.repoKey, act.number);
      if (isFail(pr)) return { status: 'unknown', error: pr.error };
      if (pr.nodeId !== act.targetNodeId) return { status: 'refused', reason: 'target-changed' };
      if (pr.merged) return { status: 'refused', reason: 'merged' };
      if (pr.state === 'open') return { status: 'none' };
      if (pr.headSha !== act.headSha) return { status: 'refused', reason: 'head-moved' };
    }
    const issue = await readIssue(gh, r.repoKey, act.number);
    if (isFail(issue)) return { status: 'unknown', error: issue.error };
    if (act.kind === 'issue_close' && (issue.nodeId !== act.targetNodeId || issue.isPr)) return { status: 'refused', reason: 'target-changed' };
    if (issue.state === 'open') return { status: 'none' };
    if (issue.closedBy !== null && issue.closedBy !== r.ghLogin) return { status: 'refused', reason: 'closed-by-other' };
    if (act.kind === 'issue_close' && issue.stateReason !== act.stateReason) return { status: 'refused', reason: 'closed-differently' };
    const ours = issue.closedBy !== null
      || (row.firstStartedAt !== undefined && issue.closedAt !== null && issue.closedAt >= row.firstStartedAt);
    return ours ? { status: 'done', result: { url: issue.url, number: act.number } } : { status: 'refused', reason: 'closed-by-other' };
  }
}
