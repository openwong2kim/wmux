// ─── The act outbox as a factory module ────────────────────────────────────
//
// Builds the act outbox (actEffectStore.ts, `<wmuxDir>/factory/
// act-effects.json`) and its executor (actExecutor.ts) over gh
// (GhActService.ts, run from `<wmuxDir>/factory`, never a bot's checkout),
// and hands the approval store its port (getApprovalActHost): the GitHub
// reads a request pins, and the outbox. Registered from modules.ts before
// the approvals module, so the outbox is up when the approval store resumes.
// At start, and every SWEEP_MS, the executor's reconcileAll settles rows that
// may have run, runs or refuses pending rows, and drops rows whose request is
// gone. Quit waits a moment for a write in flight.

import fs from 'node:fs';
import path from 'node:path';
import { GhActService } from '../github/GhActService';
import { ACT_EFFECTS_FILENAME, ActEffectStore } from './actEffectStore';
import { ActExecutor, readIssue, readLogin, readPull, readRepo, repoPath } from './actExecutor';
import { getApprovalService, type ApprovalActHost } from './approvals';
import { readReleaseAsk } from './releaseAct';
import { registerFactoryRpcModule, type FactoryHostDeps } from './factoryHost';

const SWEEP_MS = 5 * 60_000;
const QUIT_WAIT_MS = 1_000;

let current: ApprovalActHost | null = null;

/** The approval store's port to the act outbox, or null while it is not running. */
export function getApprovalActHost(): ApprovalActHost | null {
  return current;
}

export function setApprovalActHostForTests(h: ApprovalActHost | null): void {
  current = h;
}

export function createActModule(deps: Pick<FactoryHostDeps, 'wmuxDir'>): { start(): Promise<void>; dispose(): Promise<void> } {
  let executor: ActExecutor | null = null;
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  return {
    async start() {
      const dir = path.join(deps.wmuxDir(), 'factory');
      let effects: ActEffectStore;
      try {
        fs.mkdirSync(dir, { recursive: true });
        effects = new ActEffectStore(path.join(dir, ACT_EFFECTS_FILENAME));
      } catch (err) {
        console.error(`[factory] act outbox did not start (approved comments, issues and closes are not carried out): ${String(err)}`);
        return;
      }
      const gh = new GhActService(() => dir);
      const run = new ActExecutor({
        effects,
        gh,
        approval: {
          request: (id) => getApprovalService()?.get(id) ?? null,
          authorize: (e) => {
            const approvals = getApprovalService();
            return approvals ? approvals.authorizeAct(e) : 'approval-not-running';
          },
        },
        emit: (e) => getApprovalService()?.onActEffect(e),
        stalled: (e) => getApprovalService()?.onActStalled(e),
        log: (l) => console.log(l),
      });
      executor = run;
      current = {
        login: (key) => {
          const p = repoPath(key);
          return p ? readLogin(gh, p.host) : Promise.resolve(null);
        },
        repo: (key) => readRepo(gh, key),
        issue: (key, n) => readIssue(gh, key, n),
        pull: (key, n) => readPull(gh, key, n),
        release: (key, input) => readReleaseAsk(gh, key, input),
        enqueue: (r) => (r.act && r.payloadHash
          ? effects.enqueue({ requestId: r.requestId, action: r.act.kind, repoKey: r.repoKey, payloadHash: r.payloadHash })
          : null),
        run: (id) => run.run(id),
        effect: (id) => effects.get(id),
        remove: (id) => effects.remove(id),
      };
      const sweep = (): Promise<void> => run.reconcileAll();
      // The approval store is not up yet on the first start: its resume runs
      // after this module, and the first sweep waits a moment for it.
      first = setTimeout(() => void sweep().catch(() => undefined), 5_000);
      first.unref?.();
      timer = setInterval(() => void sweep().catch(() => undefined), SWEEP_MS);
      timer.unref?.();
    },
    async dispose() {
      current = null;
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      timer = null;
      first = null;
      let bound: NodeJS.Timeout | null = null;
      await Promise.race([
        executor?.idle().catch(() => undefined),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, QUIT_WAIT_MS);
          bound.unref?.();
        }),
      ]);
      if (bound) clearTimeout(bound);
    },
  };
}

registerFactoryRpcModule('acts', (_router, deps) => createActModule(deps));
