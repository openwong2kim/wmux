import type { ElementHandle, Page } from 'playwright-core';
import { generateSnapshot, listRefEntries, resolveRef, StaleRefError } from '../playwright/snapshot';
import { describeToolError } from '../playwright/toolError';
import { validateNavigationUrl } from '../../shared/types';
import {
  applyVariables,
  describeAxis,
  hasUnrecordableStep,
  refMapShapeHash,
  stripUrlUserinfo,
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
  /**
   * The run stopped because the PAGE changed shape, not because the flow is
   * broken. Kept out of the trace's failure streak (see StepFailure).
   */
  inconclusive?: boolean;
  recordedShape: string;
  liveShape: string;
}

/**
 * The shape comparison, or nothing.
 *
 * Silence when EITHER side is missing is the whole point. The two hashes are
 * only comparable when both were measured at the same point in the flow — on
 * the page the flow's element steps were numbered against. When the recorder
 * had no ref map to stamp (a flow whose first action is a navigate, recorded
 * before the destination was ever snapshotted), there is no baseline, and a
 * warning built on one would fire on every single replay of a page that never
 * changed. A missing baseline is not evidence of a changed page.
 */
function shapeWarning(recorded: string, live: string): string | null {
  if (!recorded || !live || recorded === live) return null;
  return (
    `page shape differs from the recording (recorded ${recorded.slice(0, 12)}, ` +
    `live ${live.slice(0, 12)}) — continuing, since the per-step element checks ` +
    'are the real correctness test'
  );
}

/** What the live page says about the element the axis points at. */
interface LiveEntry {
  ref: number;
  sameNameIndex: number;
  context?: string;
}

/**
 * The context verifier (#1182).
 *
 * #1179 stops a replay when the same-name POPULATION changed size. It cannot
 * see a swap that keeps the size — one look-alike inserted above the recorded
 * element and one removed below leaves N alone, so the index still resolves
 * and the click lands on a stranger while the step reports ok.
 *
 * The recorded `context` (the nearest named ancestor, minted by the snapshot
 * walk) is the only extra evidence, and it is used as EVIDENCE ONLY — three
 * verdicts, and the element is never located by it:
 *
 *   exactly one live element carries the recorded context
 *     at the recorded index  → confirmed. Stronger than the count check, so it
 *       also clears a population that merely changed size around it.
 *     at a different index    → the recorded element is still on the page but
 *       the population shifted under it. Stop; do NOT follow it to its new
 *       index, which would be re-resolving by position with extra steps and
 *       would act on the wrong element the moment the context is not unique
 *       for the reason we think it is.
 *
 *   no live element carries it, but some live element carries SOMETHING → the
 *     neighbourhood the recording named is gone. Stop.
 *
 *   no live element carries any context, or several carry the recorded one →
 *     no verdict. The context cannot tell these elements apart (identical
 *     siblings), or the page mints none, so the pre-#1182 population rules
 *     decide and nothing regresses.
 *
 * The accepted cost of the second verdict: a section renamed between recording
 * and replay stops a flow that would have worked. That is the designed failure
 * mode — the run stops at the step, says why, and hands the page back live —
 * and it is the right side to be wrong on for a step that may be a `Delete`.
 */
function contextVerdict(
  axis: RefAxis,
  population: readonly LiveEntry[],
): { ref: string } | { error: string } | null {
  if (!axis.context) return null;
  const matches = population.filter((entry) => (entry.context ?? '') === axis.context);
  if (matches.length === 1) {
    const found = matches[0];
    if (found.sameNameIndex === axis.sameNameIndex) return { ref: String(found.ref) };
    return {
      error:
        `${describeAxis(axis)} was recorded under ${axis.context}, and the only element ` +
        `with that context now sits at position ${found.sameNameIndex + 1}, not ` +
        `${axis.sameNameIndex + 1}. The population shifted under this step, so replaying ` +
        'it would act on whatever took its place',
    };
  }
  if (matches.length === 0 && population.some((entry) => (entry.context ?? '').length > 0)) {
    return {
      error:
        `${describeAxis(axis)} was recorded under ${axis.context}, and no element with that ` +
        'role and name is under it any more — the element at the recorded position is a ' +
        'different one, or its section was renamed',
    };
  }
  return null;
}

/**
 * Find the live ref number for a stored axis.
 *
 * The match is role + name + position among the same-named elements in the
 * same frame, i.e. exactly the population resolveRef counts against.
 *
 * A same-name population whose SIZE changed is a refusal at EVERY position.
 * Position N names the recorded element only while the population around it is
 * still the one that was counted: an element inserted anywhere — above the
 * first one included — shifts every index from the insertion point on, and the
 * replay would act on whatever moved into the slot.
 *
 * Index 0 used to be exempt, on the theory that nothing can displace the first
 * element. A decoy `button "Submit order"` inserted BEFORE the real one
 * disproved that live: the replay clicked the decoy, the real submit never
 * fired, and the step was reported `ok` with a warning saying the first one
 * could not have been displaced. Silently acting on the wrong element is the
 * one outcome a replay must never produce, so the exemption is gone.
 *
 * The axis stores nothing beyond the 4-tuple to disambiguate with, so there is
 * no cheaper fallback than stopping: the agent takes one snapshot and finishes
 * the flow live, which is also the next recording.
 *
 * What this does NOT catch, and cannot with what is recorded: a change that
 * leaves the COUNT the same — one look-alike added above, one element removed
 * below. The population still measures N, the index still resolves, and the
 * element it lands on is a different one. Closing that needs a disambiguator
 * the recording does not carry.
 *
 * A missing element is always a refusal — that is the other case where
 * continuing would act on something else.
 *
 * All of that is the fallback. When the recorded axis carries a `context` and
 * the live page carries one too, contextVerdict runs first and may settle the
 * step outright — including the same-count swap this reasoning is blind to.
 */
function matchRefAxis(page: Page, axis: RefAxis): { ref: string } | StepFailure {
  const population = listRefEntries(page).filter(
    (entry) =>
      entry.role === axis.role &&
      entry.name === axis.name &&
      (entry.frameKey ?? '') === axis.frameKey,
  );
  if (population.length === 0) {
    return { error: `no ${describeAxis(axis)} on the page any more` };
  }
  // Before the positional reasoning, not after: when the context can identify
  // the element it is better evidence than the index, in both directions.
  const verdict = contextVerdict(axis, population);
  if (verdict !== null) {
    if ('error' in verdict) return verdict;
    // A changed population size is what the count rules below stop on. A
    // unique context match at the recorded position is better evidence than
    // that count: it says which element this is, not merely how many look
    // alike. So it clears the size change and the step runs. (The step-level
    // warning channel that used to annotate this went away with #1179, whose
    // stop replaced it; the verdict itself is the reasoning.)
    return verdict;
  }
  // Before the index lookup, not after: a population that shrank past the
  // recorded index would otherwise report only "no element at that position"
  // and never say that the count is what changed.
  //
  // Unnamed axes are exempt, exactly as resolveRef's own count check is, and
  // for a sharper reason here: their stored total is not a same-name count at
  // all. smartRefAxisEntry (dom-intelligence) records roleIndex/roleTotal in
  // these two fields for an element with no accessible name, measured over its
  // own full-tree walk, while the number compared against is counted from this
  // module's snapshot ref map (depth-capped, filtered when it overflows). The
  // two enumerations do not have to agree on an unchanged page, so demanding
  // equality would stop flows that nothing is wrong with.
  //
  // A NAMED smartRef axis is compared anyway, and the same two enumerations
  // could in principle disagree there too. The axis carries no record of which
  // recorder minted it, and giving it one would widen the stored format, so
  // this takes the trade the whole check is built on: a stop the agent can
  // finish live costs less than a click on the wrong element.
  if (axis.name !== '' && population.length !== axis.sameNameTotal) {
    const grew = population.length > axis.sameNameTotal;
    return {
      error:
        `${describeAxis(axis)} can no longer be identified by position: the page has ` +
        `${population.length} element(s) with that role and name, the recording had ` +
        `${axis.sameNameTotal} — ` +
        (grew
          ? `element(s) were added, and one added at or above position ` +
            `${axis.sameNameIndex + 1} moves a different element into that slot`
          : `element(s) were removed, so position ${axis.sameNameIndex + 1} no longer ` +
            'counts the same population'),
      // The page changed shape under the recording. That says nothing about
      // whether the flow itself is still good, so it must not push the trace
      // toward quarantine (panel ⑤).
      inconclusive: true,
    };
  }
  const match = population.find((entry) => entry.sameNameIndex === axis.sameNameIndex);
  if (!match) {
    return {
      error:
        `${describeAxis(axis)} is gone — the page now has ${population.length} ` +
        `element(s) with that role and name, none at position ${axis.sameNameIndex + 1}`,
    };
  }
  return { ref: String(match.ref) };
}

interface Resolved {
  element: ElementHandle;
}

/**
 * Why a step could not act, and whether that is evidence about the FLOW.
 *
 * `inconclusive` marks a stop caused by the page having changed shape under
 * the recording — a same-name population that grew or shrank, a ref the live
 * page moved out from under the snapshot. The flow may well be perfectly good;
 * refusing was about not guessing which element. Those stops still end the run,
 * but they are kept out of the failure streak that quarantines a trace, so a
 * page that sprouts a banner cannot permanently demote a working recording.
 */
interface StepFailure {
  error: string;
  inconclusive?: boolean;
}

async function resolveAxis(page: Page, axis: StepAxis): Promise<Resolved | StepFailure> {
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
  // strictCount, because the population compared above was counted from the
  // internal snapshot — a measurement taken BEFORE this step. Anything the page
  // added since is invisible to it, and on a singleton population resolveRef's
  // own count check is off by default, so a decoy that appears in that window
  // would be clicked as position 0. This closes the window at the moment of
  // acting, which is the only place it can be closed.
  let element: ElementHandle | null = null;
  let moved: string | null = null;
  try {
    element = await resolveRef(page, matched.ref, { strictCount: true });
  } catch (error) {
    // StaleRefError is resolveRef's "the page is no longer the page this ref
    // was numbered against" — same class as a changed population, and equally
    // silent about whether the flow is still good. Anything else keeps the
    // generic message it has always produced.
    if (error instanceof StaleRefError) moved = error.message;
  }
  if (moved !== null) return { error: `${describeAxis(axis)}: ${moved}`, inconclusive: true };
  if (!element) return { error: `${describeAxis(axis)} could not be resolved to a live element` };
  return { element };
}

type StepOutcome = { detail: string } | StepFailure;

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

  switch (step.tool) {
    case 'browser_click':
      if (args.double === true) await element.dblclick();
      else await element.click();
      return { detail: `clicked ${describeAxis(step.axis)}` };
    case 'browser_type':
      await element.fill(String(args.text ?? ''));
      if (args.submit === true) await page.keyboard.press('Enter');
      return { detail: `typed into ${describeAxis(step.axis)}` };
    case 'browser_fill':
      await element.fill(String(args.value ?? ''));
      return { detail: `filled ${describeAxis(step.axis)}` };
    case 'browser_hover':
      await element.hover();
      return { detail: `hovered ${describeAxis(step.axis)}` };
    case 'browser_select':
      await element.selectOption(String(args.values ?? '').split(SELECT_VALUE_SEPARATOR));
      return { detail: `selected in ${describeAxis(step.axis)}` };
    case 'browser_scroll_into_view':
      await element.scrollIntoViewIfNeeded();
      return { detail: `scrolled ${describeAxis(step.axis)} into view` };
    case 'browser_scroll': {
      const px = typeof args.amount === 'number' ? args.amount : 500;
      const direction = String(args.direction ?? 'down');
      const dx = direction === 'right' ? px : direction === 'left' ? -px : 0;
      const dy = direction === 'down' ? px : direction === 'up' ? -px : 0;
      await element.evaluate(
        (node, [x, y]) => { (node as Element).scrollBy(x, y); },
        [dx, dy] as [number, number],
      );
      return { detail: `scrolled inside ${describeAxis(step.axis)}` };
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
      return { detail: `dragged ${describeAxis(step.axis)}` };
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
  const warnings: string[] = [];
  const steps: StepReport[] = [];

  // WHERE the live shape is measured has to match where the recorded one was.
  // A flow that starts by navigating was recorded against its DESTINATION, so
  // measuring here — before that navigate has run — would hash whatever page
  // the agent happened to be on when it called run, and report a difference
  // that says nothing about the flow (dogfood: the same successful replay
  // reported two different "live" hashes purely from two different starting
  // pages). For those flows the measurement is deferred until after step 1.
  const startsWithNavigate = trace.steps[0]?.tool === 'browser_navigate';
  let liveShape = '';
  const measureShape = (): void => {
    liveShape = refMapShapeHash(listRefEntries(page));
    const note = shapeWarning(trace.surfaceShape, liveShape);
    if (note) warnings.push(note);
  };

  if (!startsWithNavigate) {
    await generateSnapshot(page, { format: 'ai' }).catch(() => '');
    measureShape();
  }

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
        ...(outcome.inconclusive === true && { inconclusive: true }),
        recordedShape: trace.surfaceShape,
        liveShape,
      };
    }
    steps.push({ index, tool: step.tool, ok: true, detail: outcome.detail });

    // A step that changed the page invalidates the ref map the remaining steps
    // resolve against, so re-charge it. Still internal, still never shown.
    if (i + 1 < trace.steps.length) {
      await generateSnapshot(page, { format: 'ai' }).catch(() => '');
      // The leading navigate has now landed, so this is the flow's own page —
      // the point the recorder's baseline was taken at.
      if (i === 0 && startsWithNavigate) measureShape();
    }
  }

  return { ok: true, steps, warnings, recordedShape: trace.surfaceShape, liveShape };
}
