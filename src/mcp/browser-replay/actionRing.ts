import type { Page } from 'playwright-core';
import { getRefEntry } from '../playwright/snapshot';
import type { BrowserToolDeps } from '../playwright/browserScope';
import { redactPasswordParams } from '../playwright/redact';
import {
  ACTION_RING_CAPACITY,
  NO_AXIS,
  clampArgValue,
  normalizeUrlKey,
  refEntryToAxis,
  stripUrlUserinfo,
  type ReplayableTool,
  type StepAxis,
  type TraceStep,
  type UnrecordableReason,
} from '../../shared/browserReplay/actionTrace';

// ---------------------------------------------------------------------------
// The recording ring.
//
// Why a ring and a later cut, rather than an explicit record start / stop:
//
//   1. Success is known AFTERWARDS. An agent does not know a flow was the
//      right flow until it worked, and by then a "start recording" call would
//      have had to be made before the first attempt — i.e. before there was
//      any reason to make it. So every successful action is recorded
//      unconditionally, and `browser_replay {action:'save'}` cuts the tail.
//   2. An open recording session has no owner. If the agent stops, crashes, or
//      simply moves on, something has to close the session and decide what to
//      do with the half-recorded flow. A ring has nothing to close.
//
// The ring is per-CONNECTION, not global: two agents driving two workspaces
// must not cut each other's actions into their traces. The module-level ring
// is a fallback for call sites that predate the deps field, and is scoped by
// nothing — which is safe only because it is used when there is exactly one
// server in the process.
// ---------------------------------------------------------------------------

export interface RecordedAction {
  step: TraceStep;
  /** The page the action happened on, for cutting and for the trace's urlKey. */
  urlKey: string;
  at: number;
}

export class ActionRing {
  private readonly entries: RecordedAction[] = [];

  push(action: RecordedAction): void {
    this.entries.push(action);
    if (this.entries.length > ACTION_RING_CAPACITY) {
      this.entries.splice(0, this.entries.length - ACTION_RING_CAPACITY);
    }
  }

  /** Everything currently held, oldest first. */
  all(): RecordedAction[] {
    return this.entries.map((a) => ({ ...a, step: { ...a.step } }));
  }

  clear(): void {
    this.entries.length = 0;
  }

  /**
   * The tail a save should take.
   *
   * With an explicit count, the last `count` actions. Without one, everything
   * from the most recent navigate onward — a navigate is where a flow starts
   * in practice, and cutting there is what makes `save` usable with no
   * argument at all. With no navigate in the ring, the whole ring is the flow.
   */
  tail(count?: number): RecordedAction[] {
    const all = this.all();
    if (count !== undefined && count > 0) return all.slice(-count);
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].step.tool === 'browser_navigate') return all.slice(i);
    }
    return all;
  }
}

/** Deps may carry a per-connection ring; a call site without one shares this. */
const moduleRing = new ActionRing();

export interface ActionRingDeps extends BrowserToolDeps {
  actionRing?: ActionRing;
}

export function ringFor(deps: BrowserToolDeps): ActionRing {
  return (deps as ActionRingDeps).actionRing ?? moduleRing;
}

/** Test seam: reset the fallback ring between cases. */
export function resetModuleRing(): void {
  moduleRing.clear();
}

// ── Recording ──────────────────────────────────────────────────────────────

export interface RecordActionInput {
  tool: ReplayableTool;
  /** The live page, when the action took the Playwright lane. */
  page: Page | null;
  /** Ref the action addressed, when it addressed one. */
  ref?: string;
  /** Second ref, for browser_drag. */
  targetRef?: string;
  /** CSS selector, when the action came from browser_smart_snapshot. */
  selector?: string;
  args?: Record<string, string | number | boolean>;
  /** Force a hole — the password case decides this before the value is known. */
  unrecordable?: UnrecordableReason;
  /** Overrides page.url() (browser_navigate knows its final URL already). */
  url?: string;
}

function axisFor(page: Page | null, ref: string | undefined, selector: string | undefined): {
  axis: StepAxis;
  unrecordable?: UnrecordableReason;
} {
  if (selector !== undefined) return { axis: { kind: 'css', selector } };
  if (ref === undefined) return { axis: NO_AXIS };
  // No page means the action went over the RPC lane, which resolves elements
  // through data-wmux-ref tags and mints no RefEntry — there is nothing to
  // record an axis from, so the step becomes an honest hole.
  if (!page) return { axis: NO_AXIS, unrecordable: 'rpc-transport' };
  const axis = refEntryToAxis(getRefEntry(page, ref));
  if (!axis) return { axis: NO_AXIS, unrecordable: 'unresolved-axis' };
  return { axis };
}

/**
 * Sanitise a URL that is about to be STORED as a step's argument.
 *
 * Two credential shapes reach a URL: `scheme://user:pass@host` and a
 * password-family query parameter. `redactPasswordParams` is what the tool
 * layer already applies before echoing a URL to the agent, so recording uses
 * the same rule — a value wmux refuses to put in the transcript has no
 * business going to disk, where it lives for thirty days.
 *
 * Both cases change the URL, so neither can be replayed as recorded. The step
 * is reported back as a hole rather than stored as a URL that would navigate
 * somewhere else (or nowhere) on replay.
 */
function sanitizeRecordedUrl(url: string): { url: string; redacted: boolean } {
  const withoutUserinfo = stripUrlUserinfo(url);
  const masked = redactPasswordParams(withoutUserinfo.url);
  return { url: masked, redacted: withoutUserinfo.stripped || masked !== withoutUserinfo.url };
}

function pageUrl(page: Page | null): string {
  try {
    return page?.url() ?? '';
  } catch {
    return '';
  }
}

/**
 * Record ONE successful action.
 *
 * Called immediately before each tool's success return rather than from a
 * wrapper around withAutomationLease: the lease wrapper cannot tell a success
 * from an `isError: true` result — both are ordinary resolved values in this
 * codebase — so recording there would file every failed click as a step of the
 * flow. Attaching at the return sites costs ten call sites and buys the one
 * property the whole feature rests on: a trace contains only actions that
 * actually worked.
 *
 * Never throws. A recorder that can fail a page action is worse than no
 * recorder at all.
 */
export function recordAction(deps: BrowserToolDeps, input: RecordActionInput): void {
  try {
    const resolved = axisFor(input.page, input.ref, input.selector);
    const target = input.targetRef === undefined
      ? undefined
      : axisFor(input.page, input.targetRef, undefined);
    const args: Record<string, string | number | boolean> = {};
    let truncated = false;
    let redactedUrl = false;
    for (const [key, value] of Object.entries(input.args ?? {})) {
      // `url` is the one argument that is itself a credential carrier.
      if (key === 'url' && typeof value === 'string') {
        const safe = sanitizeRecordedUrl(value);
        redactedUrl = redactedUrl || safe.redacted;
        const clampedUrl = clampArgValue(safe.url);
        args[key] = clampedUrl.value;
        truncated = truncated || clampedUrl.truncated;
        continue;
      }
      const clamped = clampArgValue(value);
      args[key] = clamped.value;
      truncated = truncated || clamped.truncated;
    }
    const unrecordable =
      input.unrecordable ??
      resolved.unrecordable ??
      target?.unrecordable ??
      (redactedUrl ? 'redacted-url' : undefined) ??
      // A clamped argument replays a DIFFERENT value than the one that worked,
      // which is a wrong run wearing a right run's clothes.
      (truncated ? 'unresolved-axis' : undefined);
    const step: TraceStep = {
      tool: input.tool,
      axis: resolved.axis,
      ...(target && { target2: target.axis }),
      args,
      ...(unrecordable && { unrecordable }),
    };
    ringFor(deps).push({
      step,
      urlKey: normalizeUrlKey(input.url ?? pageUrl(input.page)),
      at: Date.now(),
    });
  } catch {
    /* recording is never allowed to affect the action it observed */
  }
}
