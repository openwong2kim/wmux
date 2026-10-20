// routine_set / routine_list / routine_pause / stop_my_work — a bot's own
// routines and its own stop (shared/botRoutine.ts, shared/bot.ts
// BOT_RPC.stopMyWork), registered with registerToolModule
// (src/mcp/toolModules.ts). Every call carries the bot's token; main takes
// the bot from its binding, so no tool names whose routines or work it means.

import { z } from 'zod';
import { BOT_RPC } from '../shared/bot';
import { ROUTINE_LIMITS, ROUTINE_RPC } from '../shared/botRoutine';
import { registerToolModule } from './toolModules';

/** stop_my_work cancels tasks and stops their workers. */
const STOP_TIMEOUT_MS = 60_000;

const ROUTINE_ID = z.string().regex(/^r-[A-Za-z0-9_-]{8,32}$/).describe('A routine id from routine_set or routine_list.');

const SCHEDULE = z
  .union([
    z.object({
      kind: z.literal('interval'),
      // wmux holds the floor (it refuses a shorter interval with its reason).
      every_minutes: z.number().int().min(1).max(30 * 24 * 60)
        .describe(`Minutes between runs (at least ${Math.ceil(ROUTINE_LIMITS.MIN_INTERVAL_MS / 60_000)}).`),
    }),
    z.object({
      kind: z.literal('daily'),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional().describe('0 = Sunday; omit for every day.'),
    }),
    z.object({
      kind: z.literal('once'),
      // wmux parses it (local time when there is no offset) and holds the range.
      at: z.string().min(16).max(40).describe('ISO 8601, e.g. "2026-10-23T09:00" (local) or with an offset; within a year.'),
    }),
  ])
  .describe('Every N minutes, daily at a local time, or once at a date and time.');

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const QUIET_HOURS = z
  .object({ start: HHMM, end: HHMM })
  .describe('Interval only: runs in this local HH:MM window are skipped (22:00-07:00 wraps midnight). A change without it clears it.');

type ScheduleArg = z.infer<typeof SCHEDULE>;

function scheduleParam(s: ScheduleArg): Record<string, unknown> {
  return s.kind === 'interval'
    ? { kind: 'interval', everyMs: s.every_minutes * 60_000 }
    : s.kind === 'once' ? { kind: 'once', at: s.at }
      : { kind: 'daily', hour: s.hour, minute: s.minute, ...(s.weekdays ? { weekdays: s.weekdays } : {}) };
}

registerToolModule({
  name: 'bot-routines',
  tools: ['routine_set', 'routine_list', 'routine_pause', 'stop_my_work'],
  register(host, deps) {
    // A fresh object literal: the SDK's result type has an index signature.
    const call = async (method: Parameters<typeof deps.callRpc>[0], params: Record<string, unknown>, timeoutMs?: number) => ({
      ...(await deps.callRpc(method, params, timeoutMs)),
    });

    host.tool(
      'routine_set',
      'Schedule a routine for yourself — you are woken with its prompt every time it is due ("every 60 minutes: check the open PRs"), '
        + 'or once ("remind me Friday 9am"; then done, or missed if wmux was off over 6 h past it) — '
        + 'or change one of yours (routine_id; a done one given a new time runs again). '
        + 'Only in a turn on the owner\'s words: set one when the owner asks for recurring or timed work. '
        + `A card in the room shows it; you keep at most ${ROUTINE_LIMITS.MAX_PER_BOT}. Returns the routine with its next due time.`,
      {
        title: z.string().min(1).max(ROUTINE_LIMITS.TITLE_MAX).describe('One line for the owner, in their language: what the routine is.'),
        prompt: z.string().min(1).max(ROUTINE_LIMITS.PROMPT_MAX).describe('What to tell yourself when it fires.'),
        schedule: SCHEDULE,
        quiet_hours: QUIET_HOURS.optional(),
        routine_id: ROUTINE_ID.optional().describe('Change this routine of yours instead of creating one.'),
        thread_id: z.string().min(1).max(240).optional().describe('The room thread its wakes run in (default "general").'),
      },
      async ({ title, prompt, schedule, quiet_hours, routine_id, thread_id }) =>
        call(ROUTINE_RPC.set, {
          title,
          prompt,
          schedule: scheduleParam(schedule),
          ...(quiet_hours ? { quietHours: quiet_hours } : {}),
          ...(routine_id ? { routineId: routine_id } : {}),
          ...(thread_id ? { threadId: thread_id } : {}),
        }),
    );

    host.tool(
      'routine_list',
      'List your routines: schedule, quiet hours, state (active, paused and why, or done: fired or missed) and the next due time.',
      {},
      async () => call(ROUTINE_RPC.list, {}),
    );

    host.tool(
      'routine_pause',
      'Pause one of your routines (paused: true) or resume it (paused: false). A resumed routine counts from now.',
      { routine_id: ROUTINE_ID, paused: z.boolean() },
      async ({ routine_id, paused }) => call(ROUTINE_RPC.pause, { routineId: routine_id, paused }),
    );

    host.tool(
      'stop_my_work',
      'Stop your own work when the owner says stop: your running workers and their checks are stopped and your routines paused. '
        + 'This turn goes on so you can say so — post one line saying what you stopped, then end the turn; start nothing new.',
      {},
      async () => call(BOT_RPC.stopMyWork, {}, STOP_TIMEOUT_MS),
    );
  },
});
