import type { ElementHandle, Page } from 'playwright-core';
import { generateSnapshot, listRefEntries, resolveRef } from '../playwright/snapshot';
import { describeToolError } from '../playwright/toolError';
import { validateNavigationUrl } from '../../shared/types';
import {
  applyVariables,
  describeAxis,
  hasUnrecordableStep,
  stripUrlUserinfo,
  surfaceShapeHash,
  type RefAxis,
  type StepAxis,
  type TraceRecord,
  type TraceStep,
} from '../../shared/browserReplay/actionTrace';

// ---------------------------------------------------------------------------
// The replay runner.
//
// What is actually being saved here is NOT round trips — it is the snapshot.
// A repeated flow normally costs the agent one full accessibility dump per
// step plus the reasoning to pick a ref out of it. A replay takes exactly one
// snapshot per step, internally, and never shows any of them to anyone: the
// refs are consumed by this module to re-resolve the stored axes.
//
// Failure is a first-class outcome, not an exception (the self-heal principle
// borrowed from Stagehand): a replay that cannot find step 4's element stops
// AT step 4 and reports where it stopped, why, and how the page's shape differs
// from the recorded one. The agent then finishes the flow live — which is both
// the recovery and the next recording.
// ---------------------------------------------------------------------------

export interface StepReport {
  /** 1-based. */
  index: number;
  tool: string;
  ok: boolean;
  detail: string;
}

export interface ReplayResult {
  ok: boolean;
  steps: StepReport[];
  warnings: string[];
  /** 1-based index of the step that stopped the run. */
  failedStep?: number;
  /** Set when the run ended early on purpose rather than on a failure. */
  stoppedEarly?: string;
  recordedShape: string;
  liveShape: string;
}

function shapeWarning(recorded: string, live: string): string | null {
  if (!recorded || recorded === live) return null;
  return (
    `page shape differs from the recording (recorded ${recorded.slice(0, 12)}, ` +
    `live ${live.slice(0, 12)}) — continuing, since the per-step element checks ` +
    'are the real correctness test'
  );
}

/**
 * Find the live ref number for a stored axis.
 *
 * The match is role + name + position among the same-named elements in the
 * same frame, i.e. exactly the population resolveRef counts against. A
 * `sameNameTotal` that no longer agrees is a WARNING and not a refusal: an
 * added third "Delete" button does not necessarily move the first one, and
 * refusing there would make the cache useless on any page that grows a row.
 * A missing element IS a refusal — that is the case where continuing would
 * click something else.
 */
function matchRefAxis(
  page: Page,
  axis: RefAxis,
): { ref: string; warning?: string } | { error: string } {
  const population = listRefEntries(page).filter(
    (entry) =>
      entry.role === axis.role &&
      entry.name === axis.name &&
      (entry.frameKey ?? '') === axis.frameKey,
  );
  if (population.length === 0) {
    return { error: `no ${describeAxis(axis)} on the page any more` };
  }
  const match = population.find((entry) => entry.sameNameIndex === axis.sameNameIndex);
  if (!match) {
    return {
      error:
        `${describeAxis(axis)} is gone — the page now has ${population.length} ` +
        `element(s) with that role and name, none at position ${axis.sameNameIndex + 1}`,
    };
  }
  if (population.length !== axis.sameNameTotal) {
    return {
      ref: String(match.ref),
      warning:
        `${describeAxis(axis)}: the page now has ${population.length} such element(s), ` +
        `the recording had ${axis.sameNameTotal} — replaying against position ` +
        `${axis.sameNameIndex + 1} anyway`,
    };
  }
  return { ref: String(match.ref) };
}

interface Resolved {
  element: ElementHandle;
  warning?: string;
}

async function resolveAxis(page: Page, axis: StepAxis): Promise<Resolved | { error: string }> {
  if (axis.kind === 'none') return { error: 'this step names no element' };
  if (axis.kind === 'css') {
    const locator = page.locator(axis.selector);
    const count = await locator.count().catch(() => 0);
    // A css axis carries no population index, so an ambiguous selector has no
    // sound tie-break — one match or nothing.
    if (count !== 1) {
      return { error: `css ${axis.selector} matched ${count} elements, expected exactly 1` };
    }
    const element = await locator.elementHandle().catch(() => null);
    return element ? { element } : { error: `css ${axis.selector} could not be resolved` };
  }
  const matched = matchRefAxis(page, axis);
  if ('error' in matched) return matched;
  const element = await resolveRef(page, matched.ref).catch(() => null);
  if (!element) return { error: `${describeAxis(axis)} could not be resolved to a live element` };
  return { element, ...(matched.warning !== undefined && { warning: matched.warning }) };
}

type StepOutcome = { detail: string; warning?: string } | { error: string };

/**
 * Separator the recorder joins a browser_select's values on, and the only
 * place they are split back apart. NUL rather than a comma or a space because
 * an <option> value may legally contain either, and a separator that can occur
 * inside a value silently selects the wrong options.
 */
const SELECT_VALUE_SEPARATOR = '\u0000';

async function runStep(
  page: Page,
  step: TraceStep,
  args: Record<string, string | number | boolean>,
): Promise<StepOutcome> {
  if (step.tool === 'browser_navigate') {
    // The cache file is ordinary JSON in the user's home directory and a
    // variable substitution is caller-supplied, so a stored URL is untrusted
    // input by the time it gets here — not something wmux wrote and can
    // vouch for. It goes through the SAME gate browser_navigate applies to an
    // agent-supplied URL, plus a userinfo strip, so a hand-edited trace cannot
    // reach a target the live tool would have refused.
    const stripped = stripUrlUserinfo(String(args.url ?? ''));
    const check = validateNavigationUrl(stripped.url);
    if (!check.valid) return { error: `the recorded URL is not navigable: ${check.reason}` };
    await page.goto(stripped.url, { waitUntil: 'domcontentloaded' });
    return { detail: `navigated to ${page.url()}` };
  }
  if (step.tool === 'browser_press_key') {
    await page.keyboard.press(String(args.key));
    return { detail: `pressed ${String(args.key)}` };
  }
  if (step.tool === 'browser_scroll' && step.axis.kind === 'none') {
    const px = typeof args.amount === 'number' ? args.amount : 500;
    const direction = String(args.direction ?? 'down');
    const dx = direction === 'right' ? px : direction === 'left' ? -px : 0;
    const dy = direction === 'down' ? px : direction === 'up' ? -px : 0;
    await page.evaluate(([x, y]) => { window.scrollBy(x, y); }, [dx, dy] as [number, number]);
    return { detail: `scrolled ${direction} by ${px}px` };
  }

  const resolved = await resolveAxis(page, step.axis);
  if ('error' in resolved) return resolved;
  const { element } = resolved;
  const warn = resolved.warning !== undefined ? { warning: resolved.warning } : {};

  switch (step.tool) {
    case 'browser_click':
      if (args.double === true) await element.dblclick();
      else await element.click();
      return { detail: `clicked ${describeAxis(step.axis)}`, ...warn };
    case 'browser_type':
      await element.fill(String(args.text ?? ''));
      if (args.submit === true) await page.keyboard.press('Enter');
      return { detail: `typed into ${describeAxis(step.axis)}`, ...warn };
    case 'browser_fill':
      await element.fill(String(args.value ?? ''));
      return { detail: `filled ${describeAxis(step.axis)}`, ...warn };
    case 'browser_hover':
      await element.hover();
      return { detail: `hovered ${describeAxis(step.axis)}`, ...warn };
    case 'browser_select':
      await element.selectOption(String(args.values ?? '').split(SELECT_VALUE_SEPARATOR));
      return { detail: `selected in ${describeAxis(step.axis)}`, ...warn };
    case 'browser_scroll_into_view':
      await element.scrollIntoViewIfNeeded();
      return { detail: `scrolled ${describeAxis(step.axis)} into view`, ...warn };
    case 'browser_scroll': {
      const px = typeof args.amount === 'number' ? args.amount : 500;
      const direction = String(args.direction ?? 'down');
      const dx = direction === 'right' ? px : direction === 'left' ? -px : 0;
      const dy = direction === 'down' ? px : direction === 'up' ? -px : 0;
      await element.evaluate(
        (node, [x, y]) => { (node as Element).scrollBy(x, y); },
        [dx, dy] as [number, number],
      );
      return { detail: `scrolled inside ${describeAxis(step.axis)}`, ...warn };
    }
    case 'browser_drag': {
      if (!step.target2) return { error: 'the recorded drag has no target' };
      const target = await resolveAxis(page, step.target2);
      if ('error' in target) return target;
      const from = await element.boundingBox();
      const to = await target.element.boundingBox();
      if (!from || !to) return { error: 'the drag source or target has no box on screen' };
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await page.mouse.up();
      return { detail: `dragged ${describeAxis(step.axis)}`, ...warn };
    }
    default:
      return { error: `${step.tool} cannot be replayed by this version` };
  }
}

/** A trace that cannot run at all, and why. Checked before any page work. */
export function replayBlockedReason(trace: TraceRecord): string | null {
  if (trace.steps.length === 0) return 'the trace has no steps';
  if (hasUnrecordableStep(trace)) {
    const holes = trace.steps
      .map((s, i) => (s.unrecordable ? `step ${i + 1} (${s.unrecordable})` : null))
      .filter((entry): entry is string => entry !== null)
      .join(', ');
    return (
      `the trace has unreplayable steps — ${holes}. Perform this flow live; ` +
      'a password step is never stored and never can be.'
    );
  }
  return null;
}

/**
 * Replay a trace against a live page.
 *
 * The snapshots taken here are internal, taken purely to charge the ref map,
 * and are never returned to the caller: exposing one would spend exactly the
 * context the replay exists to save.
 */
export async function replayTrace(
  page: Page,
  trace: TraceRecord,
  variables: Record<string, string> | undefined,
): Promise<ReplayResult> {
  const snapshotText = await generateSnapshot(page, { format: 'ai' }).catch(() => '');
  const liveShape = surfaceShapeHash(snapshotText);
  const warnings: string[] = [];
  const shapeNote = shapeWarning(trace.surfaceShape, liveShape);
  if (shapeNote) warnings.push(shapeNote);

  const steps: StepReport[] = [];
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    const index = i + 1;

    // A navigate anywhere but first is where the recorded flow left the page
    // the rest of the steps were numbered against. Stop cleanly instead of
    // replaying refs from the previous document into the new one.
    if (step.tool === 'browser_navigate' && i > 0) {
      return {
        ok: true,
        steps,
        warnings,
        stoppedEarly:
          `step ${index} navigates away; the recorded flow ends here for replay purposes`,
        recordedShape: trace.surfaceShape,
        liveShape,
      };
    }

    const substituted = applyVariables(step.args, variables);
    if (substituted.missing.length > 0) {
      steps.push({
        index,
        tool: step.tool,
        ok: false,
        detail: `missing variable(s): ${substituted.missing.join(', ')}`,
      });
      return {
        ok: false,
        steps,
        warnings,
        failedStep: index,
        recordedShape: trace.surfaceShape,
        liveShape,
      };
    }

    let outcome: StepOutcome;
    try {
      outcome = await runStep(page, step, substituted.args);
    } catch (error) {
      outcome = { error: describeToolError(error) };
    }
    if ('error' in outcome) {
      steps.push({ index, tool: step.tool, ok: false, detail: outcome.error });
      return {
        ok: false,
        steps,
        warnings,
        failedStep: index,
        recordedShape: trace.surfaceShape,
        liveShape,
      };
    }
    if (outcome.warning !== undefined) warnings.push(`step ${index}: ${outcome.warning}`);
    steps.push({ index, tool: step.tool, ok: true, detail: outcome.detail });

    // A step that changed the page invalidates the ref map the remaining steps
    // resolve against, so re-charge it. Still internal, still never shown.
    if (i + 1 < trace.steps.length) {
      await generateSnapshot(page, { format: 'ai' }).catch(() => '');
    }
  }

  return { ok: true, steps, warnings, recordedShape: trace.surfaceShape, liveShape };
}
