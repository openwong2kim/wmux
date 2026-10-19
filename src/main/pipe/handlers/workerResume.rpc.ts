// bot.resumeWorker — a bot relaunches the stopped worker of an ended task it
// started (main/factory/workerReclaim.ts), registered as the `worker-resume`
// factory module. Only a bot (the binding names it), only its own tasks, only
// while the factory runs, and only when an agent slot is free right now
// (factory/agentSlots.ts): a resume is a worker start, and the tool call
// answers instead of waiting. The message, when given, is delivered to the
// relaunched agent once it is up.

import { BOT_RPC } from '../../../shared/bot';
import type { RpcContext } from '../../../shared/rpc';
import { registerFactoryRpcModule, type FactoryRouter } from '../../factory/factoryHost';
import { getFactorySettings } from '../../factory/factorySettings';
import { getAgentSlots, type AgentSlots } from '../../factory/agentSlots';
import { getBotRuntime } from '../../factory/BotRuntime';
import { getBotStore } from '../../factory/botStore';
import { isWakeStoppedByOwner } from '../../factory/factoryStop';
import { botLaunchRefusal } from './fanout.rpc';
import { RESUME_MESSAGE_MAX, getWorkerResumePorts, resumeWorker, type WorkerResumePorts } from '../../factory/workerReclaim';

const TASK_ID_RE = /^wtask-[A-Za-z0-9_-]{1,80}$/;

function refuse(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

export interface WorkerResumeRpcDeps {
  ports: () => WorkerResumePorts | null;
  slots: () => AgentSlots | null;
  factoryEnabled: () => boolean;
  /** Why this bot may not start a worker now (disabled, parked, its running
   *  wake stopped by the owner or by itself), or null — the fan-out's check. */
  launchRefusal: (botId: string) => string | null;
}

export function registerWorkerResumeRpc(router: FactoryRouter, deps: WorkerResumeRpcDeps): void {
  router.register(BOT_RPC.resumeWorker, async (raw, ctx?: RpcContext) => {
    if (!ctx?.bot) return refuse('not_authorized', 'a bot resumes only the workers of tasks it started');
    const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const taskId = p.taskId;
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return refuse('invalid_argument', 'taskId must be a task id (wtask-…)');
    if (p.message !== undefined && (typeof p.message !== 'string' || p.message.length > RESUME_MESSAGE_MAX)) {
      return refuse('invalid_argument', `message must be text of at most ${RESUME_MESSAGE_MAX} characters`);
    }
    if (!deps.factoryEnabled()) return refuse('factory_off', 'the agent factory is off');
    const refusal = deps.launchRefusal(ctx.bot.botId);
    if (refusal) return refuse('not_now', refusal);
    const ports = deps.ports();
    if (!ports) return refuse('not_started', 'the agent factory has not started');
    const rec = ports.store.get(taskId);
    if (!rec || rec.botId !== ctx.bot.botId) return refuse('not_found', 'no stopped worker of a task you started has this id');
    const slots = deps.slots();
    const slot = slots ? slots.tryAcquire({ taskId, botId: ctx.bot.botId }) : null;
    if (slots && !slot) return refuse('no_slot', `every agent slot (${slots.limit()}) is in use; try again once a task ends`);
    // The slot hands over to the resumed-worker count once the line is typed.
    const release = (): void => {
      if (slot?.ok) slot.release();
    };
    try {
      return await resumeWorker(ports, taskId, { kind: 'bot', botId: ctx.bot.botId }, typeof p.message === 'string' ? p.message : undefined, release);
    } finally {
      release();
    }
  });
}

registerFactoryRpcModule('worker-resume', (router) => {
  registerWorkerResumeRpc(router, {
    ports: getWorkerResumePorts,
    slots: getAgentSlots,
    factoryEnabled: () => getFactorySettings().enabled,
    launchRefusal: (botId) => {
      const runtime = getBotRuntime();
      const wakeId = runtime?.currentTurn(botId)?.wakeId ?? '';
      if (wakeId && isWakeStoppedByOwner(wakeId)) return 'your work was stopped in this turn';
      return botLaunchRefusal(getFactorySettings().enabled, getBotStore()?.get(botId) ?? null, runtime?.wakeState(wakeId) ?? null);
    },
  });
  return {};
});
