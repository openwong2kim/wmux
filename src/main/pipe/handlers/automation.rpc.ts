// ─── automation.propose / list / runs — scheduled runs on the pipe surface ──
//
// The MCP path for scheduled runs. An agent may DRAFT a schedule and read a
// redacted view; it can never enable one, grant it a permission mode, or run
// it. Main relays to the daemon over its own first-party connection (the
// daemon's `automation.propose` is first-party only), so everything the agent
// can influence is decided here:
//
//   - propose rebuilds the draft from seven named fields. Anything that would
//     enable or elevate a schedule (`enabled`, `permission`, `allowedTools`,
//     an account or model) is refused outright rather than dropped, so the
//     caller learns the path cannot do it. The daemon then stores the draft
//     disabled, proposed and in approval mode, and queues an attention item
//     the desktop surfaces to the human.
//   - propose is rate-limited with one window shared by every caller: a
//     client name is self-asserted, so a per-name window could be bypassed by
//     rotating names, and the queue it protects is the human's.
//   - list / runs return an explicit projection: no prompt, folder, account,
//     PTY id, agent session id or output snapshot.

import { promises as fsp } from 'node:fs';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { Automation, AutomationRun } from '../../../shared/automation';
import { validateDraft, effectiveMode } from '../../../daemon/automation/draft';
import type { AutomationClient } from '../../automation/AutomationClient';

export const AUTOMATION_PROPOSE_LIMIT = 5;
export const AUTOMATION_PROPOSE_WINDOW_MS = 60_000;

/** Wire fields that would enable or elevate a schedule. Refused, never read. */
const FORBIDDEN_PROPOSE_FIELDS = [
  'enabled',
  'permission',
  'mode',
  'allowedTools',
  'grantedRevision',
  'revision',
  'accountId',
  'model',
  'effort',
  'policy',
  'draft',
] as const;

export interface AutomationRpcDeps {
  /** Main's first-party automation client, or null with no daemon. */
  getClient: () => AutomationClient | null;
  /** Injected in tests; defaults to fs.stat().isDirectory(). */
  isDirectory?: (p: string) => Promise<boolean>;
  now?: () => number;
}

/** What an MCP caller may see of one schedule. */
export interface RedactedAutomation {
  id: string;
  name: string;
  enabled: boolean;
  proposed: boolean;
  agent: Automation['action']['agent'];
  weekdays: number[];
  time: string;
  permissionMode: ReturnType<typeof effectiveMode>;
  nextRunAt: number | null;
  lastRun: { state: AutomationRun['state']; reason?: AutomationRun['reason']; at: number } | null;
}

export type RedactedRun = Pick<
  AutomationRun,
  'id' | 'automationId' | 'trigger' | 'state' | 'reason' | 'effectiveMode' | 'scheduledFor' | 'startedAt' | 'endedAt'
>;

export function redactAutomation(a: Automation, lastRun?: AutomationRun): RedactedAutomation {
  return {
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    proposed: a.proposed === true,
    agent: a.action.agent,
    weekdays: [...a.trigger.weekdays],
    time: a.trigger.time,
    permissionMode: effectiveMode(a),
    nextRunAt: a.nextRunAt,
    lastRun: lastRun
      ? {
          state: lastRun.state,
          ...(lastRun.reason ? { reason: lastRun.reason } : {}),
          at: lastRun.endedAt ?? lastRun.startedAt ?? lastRun.scheduledFor,
        }
      : null,
  };
}

export function redactRun(r: AutomationRun): RedactedRun {
  return {
    id: r.id,
    automationId: r.automationId,
    trigger: r.trigger,
    state: r.state,
    ...(r.reason ? { reason: r.reason } : {}),
    effectiveMode: r.effectiveMode,
    scheduledFor: r.scheduledFor,
    ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
  };
}

function deny(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } };
}

async function statIsDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export function registerAutomationRpc(router: RpcRouter, deps: AutomationRpcDeps): void {
  const isDirectory = deps.isDirectory ?? statIsDirectory;
  const now = deps.now ?? Date.now;
  let proposedAt: number[] = [];

  const localClient = (ctx: RpcContext | undefined, method: string) => {
    if (ctx?.origin === 'remote') return deny('NOT_AUTHORIZED', `${method}: local callers only`);
    const client = deps.getClient();
    return client ?? deny('UNAVAILABLE', `${method}: the wmux daemon is not connected`);
  };

  router.register('automation.propose', async (params, ctx) => {
    const client = localClient(ctx, 'automation.propose');
    if ('ok' in client) return client;
    const sent = FORBIDDEN_PROPOSE_FIELDS.filter((k) => params[k] !== undefined);
    if (sent.length > 0) {
      return deny('INVALID_ARGUMENT', `automation.propose: ${sent.join(', ')} cannot be set here; a draft is always disabled and in approval mode until a human enables it in wmux`);
    }
    const draft = validateDraft({
      name: params.name,
      trigger: {
        kind: 'schedule',
        weekdays: params.weekdays,
        time: params.time,
        ...(params.graceMinutes !== undefined ? { graceMinutes: params.graceMinutes } : {}),
      },
      action: { kind: 'launch', cwd: params.cwd, agent: params.agent, prompt: params.prompt },
    });
    if (!draft.ok) return deny('INVALID_ARGUMENT', `automation.propose: ${draft.error}`);
    if (!(await isDirectory(draft.value.action.cwd))) {
      return deny('INVALID_ARGUMENT', 'automation.propose: cwd must be an existing directory');
    }
    const t = now();
    proposedAt = proposedAt.filter((at) => t - at < AUTOMATION_PROPOSE_WINDOW_MS);
    if (proposedAt.length >= AUTOMATION_PROPOSE_LIMIT) {
      return deny('RATE_LIMITED', `automation.propose: at most ${AUTOMATION_PROPOSE_LIMIT} drafts per minute`);
    }
    proposedAt.push(t);
    const res = await client.propose({ draft: draft.value });
    if (!res.ok) return deny('REFUSED', `automation.propose: ${res.error}`);
    return {
      ok: true,
      automation: redactAutomation(res.automation),
      note: 'Draft only. It stays disabled until a human reviews and enables it in wmux (Schedules).',
    };
  });

  router.register('automation.list', async (_params, ctx) => {
    const client = localClient(ctx, 'automation.list');
    if ('ok' in client) return client;
    try {
      const [{ automations }, runs] = await Promise.all([client.list(), client.runs()]);
      // Runs arrive newest first; the first one per schedule is its last run.
      const last = new Map<string, AutomationRun>();
      for (const r of runs) if (!last.has(r.automationId)) last.set(r.automationId, r);
      return { ok: true, automations: automations.map((a) => redactAutomation(a, last.get(a.id))) };
    } catch (err) {
      return deny('UNAVAILABLE', `automation.list: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  router.register('automation.runs', async (params, ctx) => {
    const client = localClient(ctx, 'automation.runs');
    if ('ok' in client) return client;
    const id = params.automationId;
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 128)) {
      return deny('INVALID_ARGUMENT', 'automation.runs: automationId must be a schedule id');
    }
    try {
      const runs = await client.runs(id as string | undefined);
      return { ok: true, runs: runs.map(redactRun) };
    } catch (err) {
      return deny('UNAVAILABLE', `automation.runs: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
