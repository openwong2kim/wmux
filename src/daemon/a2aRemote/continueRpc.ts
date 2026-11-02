import { isHostId, type HostId } from '../../shared/a2aRemote';
import {
  A2A_CONTINUE_RPC,
  continueClaimable,
  isContinueCode,
  isContinueId,
  type A2aContinueBinding,
  type A2aContinueClaimResult,
  type A2aContinuePlaceResult,
  type A2aContinueRequestState,
  type A2aContinueStartFailure,
  type A2aContinueStepResult,
  type A2aContinueWork,
} from '../../shared/a2aContinue';
import { CONTINUE_START_FAILURES, type A2aContinueReceiver } from './continueReceiver';
import type { ContinuePlacer } from './continuePlacer';
import type { ContinueRequestStore } from './continueRequestStore';
import { isSafeId } from './storeFile';

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

const BAD = { ok: false, error: 'bad-request' } as const;

/**
 * The machine-local RPCs main starts a received conversation with
 * (`wmux.internal`): what to start, the claim, the files placed and taken
 * back, the pane's binding, and how the start ended. The claim's answer
 * carries no path of the asking PC's and no file: the daemon keeps the
 * manifest and places the files itself.
 */
export function registerContinueRpc(
  onRpc: (method: string, handler: RpcHandler) => void,
  deps: {
    receiver: Pick<A2aContinueReceiver, 'claim' | 'started' | 'failed'>;
    requests: Pick<ContinueRequestStore, 'get' | 'inState'>;
    placer: Pick<ContinuePlacer, 'place' | 'unplace' | 'forget'>;
    /** This PC's name for a paired PC. */
    hostName: (hostId: HostId) => string | undefined;
    /** The transcript a pane's agent named in its hooks (its resume binding's), or null. */
    paneTranscript: (ptyId: string) => string | null;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;
  const ids = (p: Record<string, unknown>): { hostId: HostId; continueId: string } | null => {
    const hostId = p['hostId'];
    const continueId = p['continueId'];
    return isHostId(hostId) && isContinueId(continueId) ? { hostId, continueId } : null;
  };

  onRpc(A2A_CONTINUE_RPC.work, async (): Promise<A2aContinueWork> => ({
    received: deps.requests.inState('received')
      .filter((rec) => continueClaimable(rec, now()))
      .map((rec) => ({ hostId: rec.hostId, continueId: rec.request.continueId })),
  }));

  onRpc(A2A_CONTINUE_RPC.claim, async (p): Promise<A2aContinueClaimResult | typeof BAD> => {
    const id = ids(p);
    if (!id) return BAD;
    const res = await deps.receiver.claim(id.hostId, id.continueId);
    // A refusal names the code the asker was told; anything else may pass on a later try.
    if (!res.ok) return isContinueCode(res.error) ? { ok: false, error: res.error, code: res.error } : { ok: false, error: res.error };
    const { claim } = res;
    return {
      ok: true,
      claim: {
        hostId: id.hostId,
        hostName: deps.hostName(id.hostId) || id.hostId.slice(0, 8),
        continueId: id.continueId,
        sessionId: claim.request.sessionId,
        agent: claim.request.agent,
        repoPath: claim.rootPath,
        origin: claim.request.repo.origin,
        branch: claim.request.repo.branch,
        head: claim.request.repo.head,
        sub: claim.request.repo.sub ?? '',
        permissionMode: claim.permissionMode,
      },
    };
  });

  onRpc(A2A_CONTINUE_RPC.place, async (p): Promise<A2aContinuePlaceResult | typeof BAD> => {
    const id = ids(p);
    const cwd = p['cwd'];
    if (!id || typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) return BAD;
    return deps.placer.place(id.hostId, id.continueId, cwd);
  });

  onRpc(A2A_CONTINUE_RPC.unplace, async (p): Promise<A2aContinueStepResult> => {
    const id = ids(p);
    return id ? deps.placer.unplace(id.hostId, id.continueId) : BAD;
  });

  onRpc(A2A_CONTINUE_RPC.binding, async (p): Promise<A2aContinueBinding | typeof BAD> => {
    const ptyId = p['ptyId'];
    return isSafeId(ptyId) ? { transcriptPath: deps.paneTranscript(ptyId) } : BAD;
  });

  onRpc(A2A_CONTINUE_RPC.started, async (p): Promise<A2aContinueStepResult> => {
    const id = ids(p);
    if (!id) return BAD;
    const res = deps.receiver.started(id.hostId, id.continueId);
    if (res.ok) deps.placer.forget(id.hostId, id.continueId);
    return res;
  });

  onRpc(A2A_CONTINUE_RPC.failed, async (p): Promise<A2aContinueStepResult> => {
    const id = ids(p);
    const code = p['code'];
    if (!id || typeof code !== 'string' || !(CONTINUE_START_FAILURES as readonly string[]).includes(code)) return BAD;
    // The contract's type, so a code it names that the receiver does not take fails to compile.
    const res = deps.receiver.failed(id.hostId, id.continueId, code as A2aContinueStartFailure);
    if (res.ok) deps.placer.forget(id.hostId, id.continueId);
    return res;
  });

  onRpc(A2A_CONTINUE_RPC.state, async (p): Promise<A2aContinueRequestState | typeof BAD> => {
    const id = ids(p);
    if (!id) return BAD;
    const rec = deps.requests.get(id.hostId, id.continueId);
    return rec ? { state: rec.state, ...(rec.code ? { code: rec.code } : {}) } : {};
  });
}
