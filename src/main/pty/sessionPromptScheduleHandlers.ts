// Electron-free IPC request handlers for per-session prompt schedules.

import { isAgentSlug, type AgentSlug } from '../../shared/agentIdentity';
import {
  createSessionPromptSchedule,
  loadSessionPromptSchedules,
  mutateSessionPromptSchedules,
  SESSION_PROMPT_SCHEDULE_LIMITS,
  type SessionPromptSchedule,
} from './sessionPromptScheduleStore';

type ScheduleAgentState = { slug: AgentSlug } | null;

export interface SessionPromptScheduleHandlerDeps {
  /** False in local/fallback mode, where process identity cannot be proven. */
  available: boolean;
  getAgentState: (ptyId: string) => Promise<ScheduleAgentState>;
  dir?: string;
}

function requestObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

export function createSessionPromptScheduleHandlers(deps: SessionPromptScheduleHandlerDeps) {
  return {
    async list(raw: unknown): Promise<{ schedules: SessionPromptSchedule[]; available: boolean }> {
      const req = requestObject(raw);
      const ptyId = typeof req.ptyId === 'string' ? req.ptyId : '';
      const schedules = loadSessionPromptSchedules(deps.dir);
      if (req.includeAll === true) return { schedules, available: deps.available };
      return {
        schedules: ptyId
          ? schedules.filter((schedule) => schedule.ptyId === ptyId)
          : [],
        available: deps.available,
      };
    },

    async create(raw: unknown): Promise<{
      ok: boolean;
      schedule?: SessionPromptSchedule;
      code?: string;
    }> {
      const req = requestObject(raw);
      const ptyId = typeof req.ptyId === 'string' ? req.ptyId : '';
      const requestedSlug = isAgentSlug(req.agentSlug) ? req.agentSlug : null;
      if (!requestedSlug) return { ok: false, code: 'invalid_agent' };
      if (!deps.available) return { ok: false, code: 'daemon_required' };

      // Bind only the daemon's canonical current agent. This closes both a
      // stale renderer race and hand-crafted IPC attempts to target a shell.
      const currentAgent = await deps.getAgentState(ptyId);
      if (!currentAgent || currentAgent.slug !== requestedSlug) {
        return { ok: false, code: 'agent_unavailable' };
      }

      const schedule = createSessionPromptSchedule({
        ptyId,
        agentSlug: requestedSlug,
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        nextRunAt: typeof req.nextRunAt === 'number' ? req.nextRunAt : NaN,
        ...(typeof req.intervalMinutes === 'number'
          ? { intervalMinutes: req.intervalMinutes }
          : {}),
      });
      if (!schedule) return { ok: false, code: 'invalid' };

      return mutateSessionPromptSchedules<{
        ok: boolean;
        schedule?: SessionPromptSchedule;
        code?: string;
      }>((schedules) => {
        if (schedules.length >= SESSION_PROMPT_SCHEDULE_LIMITS.MAX_SCHEDULES) {
          return { schedules, result: { ok: false, code: 'limit' } };
        }
        return {
          schedules: [...schedules, schedule],
          result: { ok: true, schedule },
        };
      }, deps.dir);
    },

    async update(raw: unknown): Promise<{ ok: boolean; code?: string }> {
      const req = requestObject(raw);
      const ptyId = typeof req.ptyId === 'string' ? req.ptyId : '';
      const id = typeof req.id === 'string' ? req.id : '';
      const enabled = req.enabled;
      if (typeof enabled !== 'boolean') return { ok: false, code: 'invalid' };

      return mutateSessionPromptSchedules<{ ok: boolean; code?: string }>((schedules) => {
        const index = schedules.findIndex(
          (schedule) => schedule.id === id && schedule.ptyId === ptyId,
        );
        if (index === -1) {
          return { schedules, result: { ok: false, code: 'not_found' } };
        }
        schedules[index] = { ...schedules[index], enabled };
        return { schedules, result: { ok: true } };
      }, deps.dir);
    },

    async remove(raw: unknown): Promise<{ ok: boolean }> {
      const req = requestObject(raw);
      const ptyId = typeof req.ptyId === 'string' ? req.ptyId : '';
      const id = typeof req.id === 'string' ? req.id : '';
      return mutateSessionPromptSchedules((schedules) => ({
        schedules: schedules.filter(
          (schedule) => schedule.id !== id || schedule.ptyId !== ptyId,
        ),
        result: { ok: true },
      }), deps.dir);
    },
  };
}

export type SessionPromptScheduleHandlers = ReturnType<typeof createSessionPromptScheduleHandlers>;
