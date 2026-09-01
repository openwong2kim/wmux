import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PlaywrightEngine } from '../playwright/PlaywrightEngine';
import { withAutomationLease } from '../playwright/automationLease';
import { browserScopeKey } from '../playwright/snapshot';
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
  traceVariableNames,
  type TraceRecord,
} from '../../shared/browserReplay/actionTrace';
import {
  traceFromPromoted,
  type PromotedRecord,
} from '../../shared/browserReplay/promotedSkill';
import { requireBrowserTargetScope } from '../playwright/browserScope';
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
    .enum(['list', 'save', 'run', 'forget', 'promote', 'demote'])
    .describe(
      'list: recorded flows for this workspace. save: name the actions you just ' +
        'performed. run: replay a saved flow without reading a snapshot. forget: delete one. ' +
        'promote: keep a proven flow permanently and have it offered whenever you land on its ' +
        'page. demote: undo a promote.',
    ),
  name: z
    .string()
    .optional()
    .describe('Flow name. Required for save, run, forget, promote, and demote.'),
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

function describeTrace(trace: TraceRecord, promoted = false): string {
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
    `  ${health}${promoted ? ', promoted' : ''}; ${trace.successCount} ok / ${trace.failCount} failed`,
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
      'Steps that typed into a password field are never stored and make a flow unrunnable. ' +
      'Needs the chrome browser backend: the builtin webview can fall back to a DOM snapshot that ' +
      'mints no accessibility refs, and a flow recorded then saves but can never run.',
    inputSchema: BROWSER_REPLAY_SHAPE,
    profiles: ['full'],
    invoke: async ({ action, name, steps, variables, surfaceId }) => {
      const nameError = () =>
        text(
          `browser_replay ${action} needs a name (letters, digits, and " _.:-", up to 64 characters).`,
          true,
        );

      // promote and demote run OUTSIDE the automation lease.
      //
      // They touch no page: promote reads a recorded trace and writes the
      // permanent store, demote deletes from it. Taking a lease would make
      // both of them depend on a live browser, and the moment an agent most
      // needs to demote a flow is when the session that recorded it has died
      // — a lease there would refuse exactly the call that fixes the problem.
      // Scope is still resolved, so the workspace boundary is unchanged.
      if (action === 'promote' || action === 'demote') {
        try {
          if (!isValidTraceName(name)) return nameError();
          const scope = await requireBrowserTargetScope(deps, surfaceId);
          return action === 'promote'
            ? await promoteTrace(scope, name)
            : await demoteTrace(scope, name);
        } catch (error) {
          return text(describeToolError(error), true);
        }
      }

      return withAutomationLease(deps, surfaceId, async (scope: BrowserTargetScope) => {
        try {
          if (action === 'list') return await listTraces(scope);
          if (!isValidTraceName(name)) return nameError();
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
      });
    },
  });

  async function promoteTrace(scope: BrowserTargetScope, name: string) {
    const res = await sendScopedBrowserRpc<{ ok: boolean; reason?: string; record?: PromotedRecord }>(
      'browser.actionCache.promote',
      scope,
      { name },
    );
    if (!res?.ok || !res.record) {
      return text(`Cannot promote "${name}": ${res?.reason ?? 'the store refused it'}.`, true);
    }
    const record = res.record;
    const vars = record.variables.length > 0 ? ` Variables: ${record.variables.join(', ')}.` : '';
    return text(
      `Promoted "${record.name}" — ${record.steps.length} step(s) on ${record.host}.${vars}\n` +
        'It is now kept permanently, survives the 30-day recording cache, and is offered ' +
        'automatically whenever a navigation lands on its page. ' +
        `Undo with browser_replay {action:"demote", name:"${record.name}"}.`,
    );
  }

  async function demoteTrace(scope: BrowserTargetScope, name: string) {
    const res = await sendScopedBrowserRpc<{ ok: boolean; reason?: string }>(
      'browser.actionCache.demote',
      scope,
      { name },
    );
    return res?.ok
      ? text(
          `Demoted "${name}". It is no longer offered on landing and no longer kept ` +
            'permanently; any recording of it in the 30-day cache is untouched.',
        )
      : text(`Cannot demote "${name}": ${res?.reason ?? 'the store refused it'}.`, true);
  }

  async function listTraces(scope: BrowserTargetScope) {
    const [res, promotedRes] = await Promise.all([
      sendScopedBrowserRpc<{ traces: TraceRecord[] }>('browser.actionCache.list', scope),
      sendScopedBrowserRpc<{ promoted: PromotedRecord[] }>(
        'browser.actionCache.promoted',
        scope,
      ).catch(() => ({ promoted: [] as PromotedRecord[] })),
    ]);
    const traces = res?.traces ?? [];
    const promoted = promotedRes?.promoted ?? [];
    // Promoted flows are listed even when the cache no longer holds them: the
    // whole point of promoting is that the flow outlives the recording, so a
    // list that showed only the cache would report a promoted flow as gone on
    // the day it mattered most.
    const promotedNames = new Set(promoted.map((r) => r.name));
    const orphaned = promoted.filter((r) => !traces.some((t) => t.name === r.name));

    if (traces.length === 0 && promoted.length === 0) {
      return text(
        'No recorded flows in this workspace yet. Perform a flow, then ' +
          'browser_replay {action:"save", name:"..."}.',
      );
    }
    const lines: string[] = [];
    if (traces.length > 0) {
      lines.push(`${traces.length} recorded flow(s):`);
      for (const trace of traces) {
        lines.push(describeTrace(trace, promotedNames.has(trace.name)));
      }
    }
    for (const record of orphaned) {
      lines.push(
        `- ${record.name} — ${record.steps.length} step(s) on ${record.urlKey}\n` +
          '  promoted; the 30-day recording has expired but the promoted copy still runs',
      );
    }
    return text(lines.join('\n'));
  }

  async function saveTrace(scope: BrowserTargetScope, name: string, count: number | undefined) {
    const ring = ringFor(deps);
    if (!ring) {
      return text(
        'This connection has no action recorder, so there is nothing to save. ' +
          'Perform the flow again on a connection that records.',
        true,
      );
    }
    const tail = ring.tail(browserScopeKey(scope), count);
    if (tail.length === 0) {
      return text(
        'Nothing to save — no successful browser actions have been recorded on this surface yet.',
        true,
      );
    }
    // Refused, not truncated: silently keeping the last 30 of 40 actions saves
    // a flow that starts in the middle and still reports success.
    if (tail.length > MAX_STEPS_PER_TRACE) {
      return text(
        `That is ${tail.length} actions, and a flow holds at most ${MAX_STEPS_PER_TRACE}. ` +
          `Pass steps:<n> to name the tail you want, or save the flow in shorter parts.`,
        true,
      );
    }
    const cut = tail;
    // The baseline is the shape of the page the flow's ELEMENT steps were
    // numbered against, which is not always the first action's page.
    //
    // A flow that opens with a navigate is recorded before its destination has
    // ever been snapshotted, so that first action carries an empty ref map —
    // and storing its hash meant every trace was filed under the hash of
    // nothing, which then differed from every live page forever (dogfood: a
    // spurious mismatch warning on all 3 of 3 successful replays). Taking the
    // first action that actually had a ref map lands on the destination page,
    // which is exactly where the replay re-measures. If no action had one,
    // there is no baseline and the comparison is skipped rather than faked.
    const surfaceShape = cut.find((entry) => entry.surfaceShape !== '')?.surfaceShape ?? '';
    const page = await engine.getPageForScope(scope).catch(() => null);
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
    let trace = res?.trace ?? null;
    let restoredFromPromotion = false;
    if (!trace) {
      // The recording cache expired it (or the workspace was pruned), but a
      // promoted flow carries its own copy of the steps. Restoring here is
      // what makes promotion mean PERMANENT rather than merely "listed for
      // longer" — without it a promoted flow would die with its cache entry
      // on day 31, which is the exact failure promotion exists to prevent.
      const promotedRes = await sendScopedBrowserRpc<{ promoted: PromotedRecord[] }>(
        'browser.actionCache.promoted',
        scope,
      ).catch(() => ({ promoted: [] as PromotedRecord[] }));
      const record = (promotedRes?.promoted ?? []).find((r) => r.name === name);
      if (record) {
        trace = traceFromPromoted(record);
        restoredFromPromotion = true;
      }
    }
    if (!trace) return text(`No flow named "${name}" in this workspace.`, true);

    const blocked = replayBlockedReason(trace);
    if (blocked) return text(`Cannot replay "${name}": ${blocked}`, true);

    // A flow's stored axes were numbered against ONE page. Replaying them from
    // somewhere else resolves role+name matches that happen to exist on
    // whatever is open now — which is not a failed replay, it is a successful
    // replay of the wrong actions. A flow whose first step is a navigate
    // carries its own starting page and is exempt.
    const startsWithNavigate = trace.steps[0]?.tool === 'browser_navigate';
    if (!startsWithNavigate) {
      const livePage = await engine.getPageForScope(scope).catch(() => null);
      const liveKey = normalizeUrlKey(livePage?.url() ?? '');
      if (liveKey !== trace.urlKey) {
        return text(
          `Cannot replay "${name}" from here: it was recorded on ${trace.urlKey}, and this ` +
            `surface is on ${liveKey || 'no page'}. Navigate there first, then run it again.`,
          true,
        );
      }
    }

    // A live Page is required, and the RPC lane is refused rather than
    // emulated: replay resolves stored axes through the accessibility ref map,
    // which the data-wmux-ref lane does not produce at all. Falling back would
    // silently replay against a different addressing scheme.
    const page = await engine.getPageForScope(scope).catch(() => null);
    if (!page) {
      return text(
        `Cannot replay "${name}": this workspace's browser backend provides no live page, and ` +
          'replay resolves elements through the accessibility snapshot rather than by selector. ' +
          'Switch the workspace to the chrome backend.',
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
    const restoreNote = restoredFromPromotion
      ? '\n  (restored from the promoted copy — the 30-day recording had expired. ' +
        'A successful run does not re-create the recording; save it again if you want one.)'
      : '';
    return text(`${renderRun(name, result)}${restoreNote}`, !result.ok);
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
