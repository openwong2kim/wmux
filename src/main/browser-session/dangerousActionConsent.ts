import { randomUUID } from 'node:crypto';
import type { ApprovalQueue, ApprovalResult } from '../mcp/ApprovalQueue';
import type { AutomationRunOwnership } from '../automation/AutomationBridge';
import type { BrowserPolicyStore } from './BrowserPolicyStore';
import {
  BROWSER_CONSENT_DEADLINE_MS,
  NEEDS_CONSENT_CODE,
  policyDeniedMessage,
  type BrowserConsentAction,
  type PaneConsentGrants,
} from '../../shared/browserPolicy';
import { cookieDomainAllowed, type HostPolicy } from '../../shared/browserHostPolicy';
import { sanitizeHelpPrompt } from '../../shared/browserHelp';

// ---------------------------------------------------------------------------
// Consent for dangerous actions on protected browser panes.
//
// A protected pane refuses page scripts, downloads and sensitive-site cookies
// outright (A-core). This turns each of those refusals into one question for
// the operator, asked at the moment the agent tries it:
//
//   standing grant for this pane, at the epoch the caller was resolved under
//                                   → allowed, nobody is asked
//   the caller is a scheduled run the daemon owns (nobody is watching), or
//   whether it is one cannot be told → needs_consent, at once, nothing queued
//   otherwise                       → one prompt for THIS operation
//
// Every operation is its own prompt (dedupeKey = a main-minted operation id):
// one waiter, one execution, never a shared approval. The answer is checked
// against a server-side deadline when it arrives, and the caller's identity
// (pane, profile, policy epoch, allowed hosts) is re-resolved before anything
// runs. Any throw, timeout, cancellation or mismatch is a deny.
//
// "Always on this pane" (remember) is honoured only after the same checks, is
// written with the epoch the caller was resolved under, and the operation then
// runs under the epoch that write returned — a stale answer grants nothing.
// ---------------------------------------------------------------------------

/** The method name refusals are attributed to (the MCP lane maps the prefix). */
export const CONSENT_METHOD = 'browser.consent.request';

/** Detail text cap: the dialog shows it, it is not a transcript. */
const DETAIL_MAX_CHARS = 160;

/** Who is asking, as main resolved it from its own attestation. */
export interface ConsentCaller {
  workspaceId: string;
  paneId: string;
  profileId: string;
  epoch: number;
  hosts: HostPolicy;
  /** The caller's attested PTY (for the unattended check). */
  ptyId: string | undefined;
}

/** One operation's terms. Hosts are canonical (see browserConsent.rpc.ts). */
export interface ConsentOperation {
  action: BrowserConsentAction;
  hosts: string[];
  /** Shown to the operator; sanitized here again. */
  detail?: string;
}

export interface ConsentDecision {
  operationId: string;
  /** The epoch the operation is good for (the remember write's, if any). */
  epoch: number;
  /** How it was allowed. */
  via: 'grant' | 'once' | 'remembered';
}

export interface DangerousActionConsentDeps {
  store: Pick<BrowserPolicyStore, 'grantsFor' | 'setGrants'>;
  /** The approval queue; null until main has built it (fail closed). */
  queue: () => Pick<ApprovalQueue, 'requestConsent' | 'cancelPrompt'> | null;
  /** Whether a PTY is a daemon-owned scheduled run (AutomationBridge). */
  runOwnership: (ptyId: string | undefined) => AutomationRunOwnership;
  /** Display name of a workspace, for the prompt. */
  workspaceName?: (workspaceId: string) => string | undefined;
  /** Where unattended refusals are recorded (PR C wires run details). */
  log?: (line: string) => void;
  deadlineMs?: number;
  now?: () => number;
  mintOperationId?: () => string;
}

/** Thrown for every refusal; the message carries the refusal code prefix. */
export class ConsentRefusal extends Error {
  constructor(readonly code: 'policy_denied' | 'needs_consent', message: string) {
    super(message);
    this.name = 'ConsentRefusal';
  }
}

function denied(why: string): ConsentRefusal {
  return new ConsentRefusal('policy_denied', policyDeniedMessage(CONSENT_METHOD, why));
}

function needsConsent(action: BrowserConsentAction, host: string, why: string): ConsentRefusal {
  return new ConsentRefusal(
    'needs_consent',
    `${CONSENT_METHOD}: ${NEEDS_CONSENT_CODE}: ${action} on ${host}. ${why} ` +
      "The operator can allow it on this pane (Always on this pane) the next time it is asked while they are present; do not retry unchanged.",
  );
}

/** Whether `grants` already cover the operation. */
export function grantCovers(grants: PaneConsentGrants, op: Pick<ConsentOperation, 'action' | 'hosts'>): boolean {
  if (op.action === 'evaluate') return grants.evaluate === true;
  if (op.action === 'download') return grants.download === true;
  const have = grants.sensitiveHosts ?? [];
  return op.hosts.length > 0 && op.hosts.every((h) => have.includes(h));
}

/** The grants after "Always on this pane" for `op`. */
export function withGrant(grants: PaneConsentGrants, op: Pick<ConsentOperation, 'action' | 'hosts'>): PaneConsentGrants {
  if (op.action === 'evaluate') return { ...grants, evaluate: true };
  if (op.action === 'download') return { ...grants, download: true };
  const hosts = [...(grants.sensitiveHosts ?? [])];
  for (const h of op.hosts) if (!hosts.includes(h)) hosts.push(h);
  return { ...grants, sensitiveHosts: hosts };
}

/** Same pane, same account, same policy — the terms the operator answered under. */
export function sameTerms(a: ConsentCaller, b: ConsentCaller): boolean {
  return (
    a.workspaceId === b.workspaceId
    && a.paneId === b.paneId
    && a.profileId === b.profileId
    && a.epoch === b.epoch
    && JSON.stringify(a.hosts) === JSON.stringify(b.hosts)
  );
}

/** The English headline (the renderer words it per locale from browserAction). */
export function consentTitle(action: BrowserConsentAction, host: string): string {
  switch (action) {
    case 'evaluate':
      return `An agent wants to run a script on ${host}`;
    case 'download':
      return `An agent wants to download a file from ${host}`;
    case 'sensitive':
      return `An agent wants to read or change sign-in data for ${host}`;
  }
}

export class DangerousActionConsent {
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly mint: () => string;

  constructor(private readonly deps: DangerousActionConsentDeps) {
    this.deadlineMs = deps.deadlineMs ?? BROWSER_CONSENT_DEADLINE_MS;
    this.now = deps.now ?? Date.now;
    this.mint = deps.mintOperationId ?? randomUUID;
  }

  /**
   * Decide one operation. Resolves only when it may run; throws a
   * ConsentRefusal otherwise. `revalidate` re-resolves the caller from main's
   * attestation after the operator answered; `signal` aborts on caller
   * cancellation or connection loss.
   */
  async authorize(
    caller: ConsentCaller,
    op: ConsentOperation,
    opts: { revalidate: () => Promise<ConsentCaller>; signal?: AbortSignal },
  ): Promise<ConsentDecision> {
    const hostLabel = op.hosts.join(', ');
    if (op.hosts.length === 0) throw denied('the action names no site');
    // Never wider than the pane's own site policy: consent is asked only for
    // what the policy already lets this pane reach.
    if (!op.hosts.every((h) => cookieDomainAllowed(caller.hosts, h))) {
      throw denied("that host is not on this pane's allowed list");
    }

    const standing = this.deps.store.grantsFor(caller.paneId, caller.workspaceId, caller.profileId);
    if (!standing || standing.epoch !== caller.epoch) {
      throw denied("the pane's browser policy changed while the call was being checked; try again");
    }
    if (grantCovers(standing.grants, op)) {
      return { operationId: this.mint(), epoch: caller.epoch, via: 'grant' };
    }

    // Unattended: answer now, before anything is queued. Unknown is refused the
    // same way — asking a person who may not exist would hang the run.
    const ownership = this.deps.runOwnership(caller.ptyId);
    if (ownership !== 'not-owned') {
      const why =
        ownership === 'owned'
          ? 'This is a scheduled run and nobody is there to answer.'
          : 'wmux could not tell whether anyone is watching this session.';
      this.deps.log?.(
        `[browser-consent] needs_consent ${op.action} on ${hostLabel} (pane ${caller.paneId}, pty ${caller.ptyId ?? '-'}, ${ownership})`,
      );
      throw needsConsent(op.action, hostLabel, why);
    }

    const queue = this.deps.queue();
    if (!queue) throw denied('nobody can be asked right now');
    if (opts.signal?.aborted) throw denied('the call was cancelled');

    const operationId = this.mint();
    const deadlineAt = this.now() + this.deadlineMs;
    const workspaceName = this.deps.workspaceName?.(caller.workspaceId) || caller.workspaceId;
    const detail = op.detail ? sanitizeHelpPrompt(op.detail).slice(0, DETAIL_MAX_CHARS) : undefined;
    let handle;
    try {
      handle = queue.requestConsent({
        kind: 'browser-action',
        // One prompt per operation: two concurrent operations are two prompts.
        dedupeKey: operationId,
        clientName: workspaceName,
        title: consentTitle(op.action, hostLabel),
        deadlineAt,
        browserAction: {
          workspaceId: caller.workspaceId,
          paneId: caller.paneId,
          action: op.action,
          host: hostLabel,
          ...(detail && { detail }),
        },
      });
    } catch {
      throw denied('the question could not be put to the operator');
    }

    let result: ApprovalResult | 'expired' | 'aborted';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const expiry = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), Math.max(0, deadlineAt - this.now()));
        // A pending question must not keep the process alive.
        timer.unref?.();
      });
      const aborted = new Promise<'aborted'>((resolve) => {
        if (!opts.signal) return;
        onAbort = () => resolve('aborted');
        opts.signal.addEventListener('abort', onAbort, { once: true });
      });
      result = await Promise.race([handle.resolution, expiry, aborted]);
    } catch {
      // cancelPrompt rejects the waiter: a withdrawn question was not approved.
      result = 'aborted';
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      handle.resolution.catch(() => undefined);
    }
    if (result === 'expired' || result === 'aborted') {
      // Take the row off screen: an answer that can no longer be used must not
      // sit there inviting a click.
      queue.cancelPrompt(handle.promptId, result === 'expired' ? 'consent expired' : 'caller went away');
      throw denied(result === 'expired' ? 'the operator did not answer in time' : 'the call was cancelled');
    }
    if (result.approved !== true) throw denied('the operator denied it');
    // Checked again at answer time: a click that lands after the deadline (the
    // timer may not have fired yet under load) is not an answer.
    if (this.now() > deadlineAt) throw denied('the operator answered after the deadline');
    if (opts.signal?.aborted) throw denied('the call was cancelled');

    // Re-resolve who is asking. Anything that moved under the prompt — a
    // rebind, a policy edit, a move, the pane going away — voids the answer.
    let again: ConsentCaller;
    try {
      again = await opts.revalidate();
    } catch {
      throw denied('the pane changed while the operator was being asked');
    }
    if (!sameTerms(caller, again) || again.ptyId !== caller.ptyId) {
      throw denied('the pane changed while the operator was being asked');
    }
    // The re-resolution awaited: the deadline and the caller once more.
    if (this.now() > deadlineAt) throw denied('the operator answered after the deadline');
    if (opts.signal?.aborted) throw denied('the call was cancelled');

    if (result.remember !== true) return { operationId, epoch: caller.epoch, via: 'once' };

    // Remember: same checks once more, then a write that names the epoch the
    // caller was resolved under. Only the epoch that write returns is used.
    if (this.now() > deadlineAt || opts.signal?.aborted) throw denied('the operator answered after the deadline');
    let epoch: number;
    try {
      epoch = await this.deps.store.setGrants(
        caller.paneId,
        { workspaceId: caller.workspaceId, profileId: caller.profileId },
        (current) => withGrant(current, op),
        caller.epoch,
      );
    } catch {
      throw denied("the pane's browser policy changed before the grant could be saved");
    }
    return { operationId, epoch, via: 'remembered' };
  }
}

// ---------------------------------------------------------------------------
// The approved download.
//
// A protected profile's Chrome denies downloads, and main's guard cancels any
// that begins (ChromeLauncher.armDownloadGuard). For one approved operation
// main lifts that for exactly one download:
//
//   1. claim the guard (one pass per Chrome at a time), then switch the
//      browser to allowAndName into a main-owned directory;
//   2. the FIRST download that begins in the approved tab's main frame
//      (frameId = the tab's target id) is kept, and deny is restored as soon
//      as Chrome reports it under way (its first progress event: a deny sent
//      at begin can reach Chrome before it has settled the target, which
//      cancels the approved one under load). Until then — and for as long as
//      the pass holds the guard — every other download is cancelled by guid;
//   3. any download from another tab, a subframe or a popup, or a second one
//      from the same tab, is cancelled by the guard as before;
//   4. deny is restored on every exit: kept, cancelled, timed out before it
//      started, finished, failed, or the guard went away.
// ---------------------------------------------------------------------------

/** What the approved download produced. */
export interface ConsentedDownload {
  url: string;
  suggestedFilename: string;
  /** Main-owned file (named by Chrome's guid inside the pass directory). */
  path: string;
}

export interface DownloadPass {
  /** Settles when the approved download completes, fails, or never starts. */
  readonly done: Promise<ConsentedDownload>;
  /** Withdraw: cancels a running download and restores deny. Idempotent. */
  cancel(reason?: string): void;
}

/** The guard surface a pass needs (ChromeLauncher.consentDownloadGuard()). */
export interface DownloadGuardPort {
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  claim(claimant: (params: Record<string, unknown>) => boolean): (() => void) | null;
  onProgress(listener: (params: Record<string, unknown>) => void): () => void;
  onClose(listener: () => void): () => void;
}

/** The URL a tab shows now, read over the guard's browser session. */
async function targetUrl(guard: DownloadGuardPort, targetId: string): Promise<string | null> {
  try {
    const res = (await guard.send('Target.getTargetInfo', { targetId })) as {
      targetInfo?: { type?: unknown; url?: unknown };
    };
    const info = res?.targetInfo;
    return info && info.type === 'page' && typeof info.url === 'string' ? info.url : null;
  } catch {
    return null;
  }
}

export async function openDownloadPass(
  guard: DownloadGuardPort,
  opts: {
    /** The approved tab's main frame id (its target id). */
    frameId: string;
    /** The site the operator approved; the tab must be on it at arm and begin. */
    approvedHost: string;
    /** Canonical host of a URL (null when it has none). */
    hostOf: (url: string) => string | null;
    /** Directory the download is written into (main-owned, fresh). */
    dir: string;
    /** How long the download has to begin. */
    startTimeoutMs: number;
    /** How long a begun download has to finish. */
    finishTimeoutMs: number;
    join: (dir: string, name: string) => string;
  },
): Promise<DownloadPass> {
  const deny = () =>
    guard.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => undefined);
  let state: 'waiting' | 'running' | 'settled' = 'waiting';
  let guid = '';
  let url = '';
  let suggestedFilename = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (d: ConsentedDownload) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<ConsentedDownload>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  // The caller may never await (it died between request and await).
  done.catch(() => undefined);

  let release: (() => void) | null = null;
  let offProgress: (() => void) | null = null;
  let offClose: (() => void) | null = null;
  const settle = (outcome: { ok: ConsentedDownload } | { error: string }): void => {
    if (state === 'settled') return;
    state = 'settled';
    if (timer) clearTimeout(timer);
    release?.();
    offProgress?.();
    offClose?.();
    void deny();
    if ('ok' in outcome) resolveDone(outcome.ok);
    else rejectDone(new ConsentRefusal('policy_denied', policyDeniedMessage(CONSENT_METHOD, outcome.error)));
  };
  const arm = (ms: number, why: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (state === 'running' && guid) void guard.send('Browser.cancelDownload', { guid }).catch(() => undefined);
      settle({ error: why });
    }, ms);
    timer.unref?.();
  };

  // The tab named must be a page on the approved site now — main's own read,
  // not the caller's word.
  const armedUrl = await targetUrl(guard, opts.frameId);
  if (!armedUrl || opts.hostOf(armedUrl) !== opts.approvedHost) {
    throw new ConsentRefusal(
      'policy_denied',
      policyDeniedMessage(CONSENT_METHOD, 'the tab is not on the site the operator approved'),
    );
  }

  release = guard.claim((params) => {
    if (state !== 'waiting' || params.frameId !== opts.frameId || typeof params.guid !== 'string' || !params.guid) {
      return false;
    }
    state = 'running';
    guid = params.guid;
    url = typeof params.url === 'string' ? params.url : '';
    suggestedFilename = typeof params.suggestedFilename === 'string' ? params.suggestedFilename : '';
    // This one is kept; nothing after it is (cancelled by guid while the pass
    // holds the guard, then denied once it is under way).
    arm(opts.finishTimeoutMs, 'the approved download did not finish in time');
    // Still the approved site when it began? Checked as soon as it can be; a
    // tab that moved loses the download.
    void targetUrl(guard, opts.frameId).then((url) => {
      if (state !== 'running') return;
      if (!url || opts.hostOf(url) !== opts.approvedHost) {
        void guard.send('Browser.cancelDownload', { guid }).catch(() => undefined);
        settle({ error: 'the tab left the approved site before the download began' });
      }
    });
    return true;
  });
  if (!release) {
    throw new ConsentRefusal(
      'policy_denied',
      policyDeniedMessage(CONSENT_METHOD, 'another approved download is still running on this pane; wait for it to finish'),
    );
  }
  let underWay = false;
  offClose = guard.onClose(() => settle({ error: "the protected browser's download guard went away" }));
  offProgress = guard.onProgress((params) => {
    if (!guid || params.guid !== guid) return;
    if (!underWay) {
      underWay = true;
      void deny();
    }
    if (params.state === 'completed') settle({ ok: { url, suggestedFilename, path: opts.join(opts.dir, guid) } });
    else if (params.state === 'canceled') settle({ error: 'the approved download was cancelled' });
  });
  try {
    await guard.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: opts.dir,
      eventsEnabled: true,
    });
  } catch {
    settle({ error: "the protected browser's download guard is not ready" });
    throw new ConsentRefusal(
      'policy_denied',
      policyDeniedMessage(CONSENT_METHOD, "the protected browser's download guard is not ready"),
    );
  }
  if (state === 'waiting') arm(opts.startTimeoutMs, 'no download started in the approved tab in time');
  return {
    done,
    cancel: (reason = 'the download was withdrawn') => {
      if (state === 'running' && guid) void guard.send('Browser.cancelDownload', { guid }).catch(() => undefined);
      settle({ error: reason });
    },
  };
}
