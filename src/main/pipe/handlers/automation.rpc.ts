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
//     rotating names, and the queue it protects is the human's. At most
//     AUTOMATION_MAX_PENDING_DRAFTS drafts may wait at once, and an identical
//     waiting draft is refused. A UNC / device cwd is refused before any stat.
//   - list / runs return an explicit projection: no prompt, folder, account,
//     PTY id, agent session id or output snapshot, and no name for a schedule
//     a human created. Reads share their own rate window; runs is capped.
//   - only the authenticated external wire (the bundled MCP server) reaches
//     these handlers; in-process callers use the renderer IPC surface.

import { promises as fsp } from 'node:fs';
import type { RpcRouter } from '../RpcRouter';
import type { RpcContext } from '../../../shared/rpc';
import type { Automation, AutomationRun } from '../../../shared/automation';
import { validateDraft, effectiveMode } from '../../../daemon/automation/draft';
import type { AutomationClient } from '../../automation/AutomationClient';

export const AUTOMATION_PROPOSE_LIMIT = 5;
export const AUTOMATION_PROPOSE_WINDOW_MS = 60_000;
/** list + runs together, per minute. */
export const AUTOMATION_READ_LIMIT = 30;
/** Drafts that may wait for review at once (the daemon's cap is shared with the human's schedules). */
export const AUTOMATION_MAX_PENDING_DRAFTS = 10;
/** automation.runs returns at most this many, newest first. */
export const AUTOMATION_RUNS_MAX = 50;

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
  /** Only for agent-drafted schedules; a human's schedule names are not shown. */
  name?: string;
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
    ...(a.createdBy === 'mcp-proposal' ? { name: a.name } : {}),
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

/** One sliding window shared by every caller (client names are self-asserted). */
function slidingWindow(limit: number, windowMs: number, now: () => number): () => boolean {
  let hits: number[] = [];
  return () => {
    const t = now();
    hits = hits.filter((at) => t - at < windowMs);
    if (hits.length >= limit) return false;
    hits.push(t);
    return true;
  };
}

/** `\\server\share`, `//server/share`, `\\?\…`, `\\.\…`: network or device paths. */
function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

export function registerAutomationRpc(router: RpcRouter, deps: AutomationRpcDeps): void {
  const isDirectory = deps.isDirectory ?? statIsDirectory;
  const now = deps.now ?? Date.now;
  const allowPropose = slidingWindow(AUTOMATION_PROPOSE_LIMIT, AUTOMATION_PROPOSE_WINDOW_MS, now);
  const allowRead = slidingWindow(AUTOMATION_READ_LIMIT, AUTOMATION_PROPOSE_WINDOW_MS, now);
  // Proposals run one at a time so the pending-draft count and the duplicate
  // check read the state the previous proposal left behind.
  let proposeChain: Promise<unknown> = Promise.resolve();

  // Positive provenance: only the authenticated external wire the bundled MCP
  // server uses. The in-process renderer has its own IPC surface for
  // schedules, and plugin-host iframes have no reason to draft one.
  const wireClient = (ctx: RpcContext | undefined, method: string) => {
    if (ctx?.externalWire !== true) return deny('NOT_AUTHORIZED', `${method}: MCP callers only`);
    const client = deps.getClient();
    return client ?? deny('UNAVAILABLE', `${method}: the wmux daemon is not connected`);
  };

  const propose = async (client: AutomationClient, params: Record<string, unknown>) => {
    // First, so a failed or malformed attempt still spends a slot.
    if (!allowPropose()) {
      return deny('RATE_LIMITED', `automation.propose: at most ${AUTOMATION_PROPOSE_LIMIT} drafts per minute`);
    }
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
    const { cwd, prompt } = draft.value.action;
    // Before any stat: touching a UNC path makes the OS reach out to that host.
    if (isUncOrDevicePath(cwd)) {
      return deny('INVALID_ARGUMENT', 'automation.propose: cwd must be a local folder, not a network or device path');
    }
    if (!(await isDirectory(cwd))) {
      return deny('INVALID_ARGUMENT', 'automation.propose: cwd must be an existing directory');
    }
    // Drafts share the daemon's schedule cap and attention queue with the
    // human's own schedules, so an agent may only keep a few waiting.
    const { automations } = await client.list();
    const pending = automations.filter((a) => a.proposed === true && !a.enabled);
    if (pending.some((a) => a.name === draft.value.name && a.action.cwd === cwd && a.action.prompt === prompt)) {
      return deny('DUPLICATE', 'automation.propose: the same draft is already waiting for review');
    }
    if (pending.length >= AUTOMATION_MAX_PENDING_DRAFTS) {
      return deny('TOO_MANY_PENDING', `automation.propose: ${AUTOMATION_MAX_PENDING_DRAFTS} drafts are already waiting for review; ask the user to review or discard them first`);
    }
    const res = await client.propose({ draft: draft.value });
    if (!res.ok) return deny('REFUSED', `automation.propose: ${res.error}`);
    return {
      ok: true,
      automation: redactAutomation(res.automation),
      note: 'Draft only. It stays disabled until a human reviews and enables it in wmux (Schedules).',
    };
  };

  router.register('automation.propose', async (params, ctx) => {
    const client = wireClient(ctx, 'automation.propose');
    if ('ok' in client) return client;
    const result = proposeChain.then(() => propose(client, params));
    proposeChain = result.catch(() => undefined);
    try {
      return await result;
    } catch (err) {
      return deny('UNAVAILABLE', `automation.propose: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  router.register('automation.list', async (_params, ctx) => {
    const client = wireClient(ctx, 'automation.list');
    if ('ok' in client) return client;
    if (!allowRead()) return deny('RATE_LIMITED', `automation.list: at most ${AUTOMATION_READ_LIMIT} reads per minute`);
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
    const client = wireClient(ctx, 'automation.runs');
    if ('ok' in client) return client;
    const id = params.automationId;
    if (id !== undefined && (typeof id !== 'string' || !id || id.length > 128)) {
      return deny('INVALID_ARGUMENT', 'automation.runs: automationId must be a schedule id');
    }
    if (!allowRead()) return deny('RATE_LIMITED', `automation.runs: at most ${AUTOMATION_READ_LIMIT} reads per minute`);
    try {
      const runs = await client.runs(id as string | undefined);
      // Newest first from the daemon; keep the tool result well under the MCP cap.
      return {
        ok: true,
        runs: runs.slice(0, AUTOMATION_RUNS_MAX).map(redactRun),
        ...(runs.length > AUTOMATION_RUNS_MAX ? { truncated: true, total: runs.length } : {}),
      };
    } catch (err) {
      return deny('UNAVAILABLE', `automation.runs: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
