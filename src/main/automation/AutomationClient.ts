import {
  AUTOMATION_RPC,
  type Automation,
  type AutomationCancelRunParams,
  type AutomationCreateParams,
  type AutomationGrantParams,
  type AutomationMutationResult,
  type AutomationRemoveParams,
  type AutomationRun,
  type AutomationRunNowParams,
  type AutomationSetEnabledParams,
  type AutomationUpdateParams,
} from '../../shared/automation';

/** The slice of DaemonClient this wrapper needs (a fake in tests). */
export interface AutomationRpcTransport {
  rpc(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/**
 * The contract types remove / runNow / cancelRun loosely; a daemon may answer
 * them with a bare `{ ok:true }`, so their callers only get the verdict.
 */
export type AutomationActionResult = { ok: true } | { ok: false; error: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Typed wrappers over the daemon's `automation.*` RPCs. Reads degrade to
 * empty results; mutations resolve `{ ok:false, error }` instead of throwing,
 * so the renderer never has to tell a transport failure from a refusal.
 */
export class AutomationClient {
  constructor(private readonly transport: AutomationRpcTransport) {}

  async list(): Promise<Automation[]> {
    const r = (await this.transport.rpc(AUTOMATION_RPC.list, {})) as { automations?: unknown } | null;
    return Array.isArray(r?.automations) ? (r.automations as Automation[]) : [];
  }

  async runs(automationId?: string): Promise<AutomationRun[]> {
    const r = (await this.transport.rpc(
      AUTOMATION_RPC.runs,
      automationId ? { automationId } : {},
    )) as { runs?: unknown } | null;
    return Array.isArray(r?.runs) ? (r.runs as AutomationRun[]) : [];
  }

  async snapshot(runId: string): Promise<string | null> {
    const r = (await this.transport.rpc(AUTOMATION_RPC.snapshot, { runId })) as { text?: unknown } | null;
    return typeof r?.text === 'string' ? r.text : null;
  }

  create(params: AutomationCreateParams): Promise<AutomationMutationResult> {
    return this.mutate(AUTOMATION_RPC.create, { draft: params.draft });
  }

  update(params: AutomationUpdateParams): Promise<AutomationMutationResult> {
    return this.mutate(AUTOMATION_RPC.update, { id: params.id, draft: params.draft });
  }

  remove(params: AutomationRemoveParams): Promise<AutomationActionResult> {
    return this.act(AUTOMATION_RPC.remove, { id: params.id });
  }

  setEnabled(params: AutomationSetEnabledParams): Promise<AutomationMutationResult> {
    return this.mutate(AUTOMATION_RPC.setEnabled, { id: params.id, enabled: params.enabled });
  }

  grant(params: AutomationGrantParams): Promise<AutomationMutationResult> {
    return this.mutate(AUTOMATION_RPC.grant, {
      id: params.id,
      mode: params.mode,
      ...(params.allowedTools ? { allowedTools: params.allowedTools } : {}),
    });
  }

  runNow(params: AutomationRunNowParams): Promise<AutomationActionResult> {
    return this.act(AUTOMATION_RPC.runNow, { id: params.id, kind: params.kind });
  }

  cancelRun(params: AutomationCancelRunParams): Promise<AutomationActionResult> {
    return this.act(AUTOMATION_RPC.cancelRun, { runId: params.runId });
  }

  private async act(method: string, params: Record<string, unknown>): Promise<AutomationActionResult> {
    try {
      const r = (await this.transport.rpc(method, params)) as { ok?: unknown; error?: unknown } | null;
      if (r?.ok === true) return { ok: true };
      return { ok: false, error: typeof r?.error === 'string' ? r.error : 'invalid daemon reply' };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  private async mutate(method: string, params: Record<string, unknown>): Promise<AutomationMutationResult> {
    try {
      const r = (await this.transport.rpc(method, params)) as Partial<AutomationMutationResult> | null;
      if (r && r.ok === true && 'automation' in r && r.automation) return { ok: true, automation: r.automation };
      if (r && r.ok === false && 'error' in r && typeof r.error === 'string') return { ok: false, error: r.error };
      return { ok: false, error: 'invalid daemon reply' };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }
}
