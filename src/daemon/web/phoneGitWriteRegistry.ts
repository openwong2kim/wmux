import type { PhoneGitRepo } from './phoneGitRead';
import type { GitWriteReceiptFields } from './phoneGitWriteGate';
import type {
  GitWriteError, GitWriteErrorBody, GitWritePins, PhoneGitWriteAction,
  PrCreateExecuteBody, PrMergeExecuteBody, PushExecuteBody,
} from '../../shared/phoneGitWrite';

/**
 * Where the phone git write actions plug in. The routes (phoneGitWriteRoutes.ts)
 * own the gate, confirm tokens, receipts and identity; an action module owns
 * only the git/gh work and registers itself here when it is loaded:
 *
 *   registerPhoneGitWriteAction('push', { preview, execute });
 *
 * and is loaded by a side-effect import in phoneGitWriteRoutes.ts. An action
 * with no handlers answers 501 and is not advertised on `/api/config`.
 */

/** What every handler call knows about the request. Already authorized. */
export interface GitWriteSessionContext {
  action: PhoneGitWriteAction;
  /** `device:<id>` or `operator`. */
  owner: string;
  /** Empty for the operator token. */
  deviceId: string;
  sessionId: string;
  /** The session's trusted `spawnCwd`. */
  cwd: string;
  repo: PhoneGitRepo;
  /** pr.merge: the PR number from the path. */
  number?: number;
  /** `gitWriteLogin`, already resolved to a token. */
  login: string;
  /** Environment for every git/gh network call: GH_TOKEN is the login's token, inherited ones removed. */
  ghEnv: NodeJS.ProcessEnv;
}

export type GitWriteFailure = { ok: false; body: GitWriteErrorBody };

export type GitWritePreviewResult =
  | { ok: true; facts: Record<string, unknown>; pins: GitWritePins }
  | GitWriteFailure;

export type GitWriteSettle =
  | { state: 'done'; fields?: GitWriteReceiptFields }
  | { state: 'refused'; error: GitWriteError; fields?: GitWriteReceiptFields };

export interface GitWriteExecuteContext extends GitWriteSessionContext {
  requestId: string;
  body: PushExecuteBody | PrCreateExecuteBody | PrMergeExecuteBody;
  /** The preview's pins (push, pr.merge); null for pr.create. Re-read each before spawning. */
  pins: GitWritePins | null;
  /** Durably mark the receipt `inFlight`. Call it immediately before spawning; it throws if the write fails. */
  markInFlight(): void;
  /** Settle the receipt. Called once; later calls are ignored. */
  settle(outcome: GitWriteSettle): void;
}

export interface PhoneGitWriteActionHandlers {
  /** push and pr.merge only. */
  preview?(ctx: GitWriteSessionContext): Promise<GitWritePreviewResult>;
  /**
   * Runs after the 202 went out. A rejection settles a `pending` receipt as
   * `refused` / `gh-unavailable` and an `inFlight` one as `uncertain`.
   */
  execute(ctx: GitWriteExecuteContext): Promise<void>;
}

const handlers = new Map<PhoneGitWriteAction, PhoneGitWriteActionHandlers>();

/** Register an action's handlers. Returns the unregister function (tests). */
export function registerPhoneGitWriteAction(action: PhoneGitWriteAction, h: PhoneGitWriteActionHandlers): () => void {
  if (action !== 'pr.create' && !h.preview) throw new Error(`${action} needs a preview handler`);
  handlers.set(action, h);
  return () => { if (handlers.get(action) === h) handlers.delete(action); };
}

export function phoneGitWriteHandlers(action: PhoneGitWriteAction): PhoneGitWriteActionHandlers | undefined {
  return handlers.get(action);
}
