import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../playwright/PlaywrightEngine';
import { withAutomationLease } from '../playwright/automationLease';
import { generateSnapshot } from '../playwright/snapshot';
import { describeToolError } from '../playwright/toolError';
import {
  sendScopedBrowserRpc,
  type BrowserTargetScope,
  type BrowserToolDeps,
} from '../playwright/browserScope';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
} from '../toolCatalog';
import {
  MAX_STEPS_PER_TRACE,
  hasUnrecordableStep,
  isQuarantined,
  isServable,
  isValidTraceName,
  normalizeUrlKey,
  surfaceShapeHash,
  traceVariableNames,
  type TraceRecord,
} from '../../shared/browserReplay/actionTrace';
import { ringFor } from './actionRing';
import { replayBlockedReason, replayTrace, type ReplayResult } from './replayRunner';

// ---------------------------------------------------------------------------
// browser_replay — one tool, four actions.
//
// One tool rather than four (browser_replay_save, _run, _list, _forget) for a
// budget reason that is not cosmetic: the full profile's tools/list payload is
// the first thing every host pays for, and four tools cost four descriptions
// and four schemas for one feature. The action enum keeps the whole feature at
// one entry.
//
// full profile only. It is an optimization for agents that drive browsers, and
// the core and commander profiles carry no browser tools for it to optimize.
// ---------------------------------------------------------------------------

const BROWSER_REPLAY_SHAPE = {
  action: z
    .enum(['list', 'save', 'run', 'forget'])
    .describe(
      'list: recorded flows for this workspace. save: name the actions you just ' +
        'performed. run: replay a saved flow without reading a snapshot. forget: delete one.',
    ),
  name: z
    .string()
    .optional()
    .describe('Flow name. Required for save, run, and forget.'),
  steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('save: how many of your most recent actions to keep. Default: everything since your last navigate.'),
  variables: z
    .record(z.string(), z.string())
    .optional()
    .describe('run: values for the {{placeholders}} the flow was saved with.'),
  surfaceId: z
    .string()
    .optional()
    .describe('Omit for the active surface.'),
};

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], ...(isError && { isError: true }) };
}

function describeTrace(trace: TraceRecord): string {
  const variables = traceVariableNames(trace);
  const health = isQuarantined(trace)
    ? 'quarantined (the same step failed twice running)'
    : hasUnrecordableStep(trace)
      ? 'not runnable (contains an unreplayable step)'
      : isServable(trace)
        ? 'proven'
        : 'unproven';
  return [
    `- ${trace.name} — ${trace.steps.length} step(s) on ${trace.urlKey}`,
    `  ${health}; ${trace.successCount} ok / ${trace.failCount} failed`,
    variables.length > 0 ? `  variables: ${variables.join(', ')}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function renderRun(name: string, result: ReplayResult): string {
  const lines = [
    result.ok
      ? `Replayed "${name}": ${result.steps.length}/${result.steps.length} step(s) ran.`
      : `Replay of "${name}" stopped at step ${result.failedStep}.`,
  ];
  for (const step of result.steps) {
    lines.push(`  ${step.ok ? 'ok' : 'STOP'} ${step.index}. ${step.tool} — ${step.detail}`);
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.stoppedEarly) lines.push(`  ${result.stoppedEarly}`);
  if (!result.ok) {
    // The self-heal handoff: the page is left exactly where the replay stopped,
    // so the cheapest recovery is to finish from here and save again.
    lines.push(
      `  The page is left where the replay stopped. Take a browser_snapshot and ` +
        `finish from here, then browser_replay {action:"save", name:"${name}"} to ` +
        `re-record the healed path.`,
    );
    lines.push(`  recorded page shape ${result.recordedShape.slice(0, 12)}, live ${result.liveShape.slice(0, 12)}`);
  }
  return lines.join('\n');
}

export function createReplayToolCatalog(deps: BrowserToolDeps) {
  const engine = PlaywrightEngine.getInstance();

  const tool = defineWmuxTool({
    name: 'browser_replay',
    description:
      'Record and replay a browser flow. After a flow works, save it by name; a later run repeats ' +
      'it without reading a single snapshot, which is where the saving is. A run that cannot find ' +
      'an element stops at that step and reports why, leaving the page there for you to finish live. ' +
      'Steps that typed into a password field are never stored and make a flow unrunnable.',
    inputSchema: BROWSER_REPLAY_SHAPE,
    profiles: ['full'],
    invoke: async ({ action, name, steps, variables, surfaceId }) =>
      withAutomationLease(deps, surfaceId, async (scope: BrowserTargetScope) => {
        try {
          if (action === 'list') return await listTraces(scope);
          if (!isValidTraceName(name)) {
            return text(
              `browser_replay ${action} needs a name (letters, digits, and " _.:-", up to 64 characters).`,
              true,
            );
          }
          if (action === 'forget') {
            const res = await sendScopedBrowserRpc<{ removed: number }>(
              'browser.actionCache.forget',
              scope,
              { name },
            );
            return text(
              res.removed > 0 ? `Forgot "${name}".` : `No flow named "${name}" in this workspace.`,
            );
          }
          if (action === 'save') return await saveTrace(scope, name, steps);
          return await runTrace(scope, name, variables as Record<string, string> | undefined);
        } catch (error) {
          return text(describeToolError(error), true);
        }
      }),
  });

  async function listTraces(scope: BrowserTargetScope) {
    const res = await sendScopedBrowserRpc<{ traces: TraceRecord[] }>(
      'browser.actionCache.list',
      scope,
    );
    const traces = res?.traces ?? [];
    if (traces.length === 0) {
      return text(
        'No recorded flows in this workspace yet. Perform a flow, then ' +
          'browser_replay {action:"save", name:"..."}.',
      );
    }
    return text(`${traces.length} recorded flow(s):\n${traces.map(describeTrace).join('\n')}`);
  }

  async function saveTrace(scope: BrowserTargetScope, name: string, count: number | undefined) {
    const tail = ringFor(deps).tail(count);
    if (tail.length === 0) {
      return text(
        'Nothing to save — no successful browser actions have been recorded on this connection yet.',
        true,
      );
    }
    const cut = tail.slice(-MAX_STEPS_PER_TRACE);
    // The shape is read from the page the flow STARTED on, which is the page a
    // future run will begin against; hashing the end state would compare the
    // wrong two things.
    const page = await engine.getPageForScope(scope).catch(() => null);
    const surfaceShape = page ? surfaceShapeHash(await generateSnapshot(page, { format: 'ai' }).catch(() => '')) : '';
    const trace = {
      id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      urlKey: cut[0].urlKey || normalizeUrlKey(page?.url() ?? ''),
      surfaceShape,
      steps: cut.map((entry) => entry.step),
      observedCount: 1,
      successCount: 0,
      failCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    const res = await sendScopedBrowserRpc<{ ok: boolean; reason?: string; trace?: TraceRecord }>(
      'browser.actionCache.put',
      scope,
      { trace },
    );
    if (!res?.ok || !res.trace) {
      return text(`Could not save "${name}": ${res?.reason ?? 'the store refused the trace'}.`, true);
    }
    const holes = res.trace.steps.filter((s) => s.unrecordable);
    const note = holes.length > 0
      ? `\nNote: ${holes.length} step(s) cannot be replayed (${holes
          .map((s) => s.unrecordable)
          .join(', ')}), so this flow is saved for the record but will refuse to run.`
      : '';
    const vars = traceVariableNames(res.trace);
    const varNote = vars.length > 0 ? `\nVariables: ${vars.join(', ')}` : '';
    return text(
      `Saved "${name}" — ${res.trace.steps.length} step(s) on ${res.trace.urlKey}.${varNote}${note}`,
    );
  }

  async function runTrace(
    scope: BrowserTargetScope,
    name: string,
    variables: Record<string, string> | undefined,
  ) {
    const res = await sendScopedBrowserRpc<{ trace: TraceRecord | null }>(
      'browser.actionCache.get',
      scope,
      { name },
    );
    const trace = res?.trace ?? null;
    if (!trace) return text(`No flow named "${name}" in this workspace.`, true);

    const blocked = replayBlockedReason(trace);
    if (blocked) return text(`Cannot replay "${name}": ${blocked}`, true);

    // A live Page is required, and the RPC lane is refused rather than
    // emulated: replay resolves stored axes through the accessibility ref map,
    // which the data-wmux-ref lane does not produce at all. Falling back would
    // silently replay against a different addressing scheme.
    const page = await engine.getPageForScope(scope).catch(() => null);
    if (!page) {
      return text(
        `Cannot replay "${name}": this workspace's browser backend provides no live page, and ` +
          'replay resolves elements through the accessibility snapshot rather than by selector.',
        true,
      );
    }

    const result = await replayTrace(page, trace, variables);
    await sendScopedBrowserRpc('browser.actionCache.stats', scope, {
      name,
      ok: result.ok,
      ...(result.failedStep !== undefined && { failedStep: result.failedStep }),
    }).catch(() => {
      /* statistics are an optimization for the hint pipe; never fail a run on them */
    });
    return text(renderRun(name, result), !result.ok);
  }

  return Object.freeze([tool]);
}

/** Register the replay catalog through the wire-neutral current-SDK adapter. */
export function registerReplayTools(
  server: McpServer,
  deps: BrowserToolDeps,
  options: RegisterWmuxToolsOptions,
): void {
  registerWmuxTools(server, createReplayToolCatalog(deps), options);
}
