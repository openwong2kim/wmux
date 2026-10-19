// Deferred WebGL builds for terminals that reveal without a context.
//
// Building a WebGL renderer is synchronous GPU setup: context creation plus a
// shader compile, measured at 0.45-0.55 s per terminal on Windows
// (2026-10-14). A terminal that reveals without a context (a cold-parked
// workspace remounting its panes, or the first reveal after start) used to
// pay that inside the switch's input task, so the whole window froze for
// 0.5 s per pane before the new workspace painted, whether the switch came
// from a click or a shortcut.
//
// Such a terminal now queues its build here. The queue runs one job per
// frame, each after the previous paint, so the switch itself paints at once,
// each pane appears as soon as its renderer is ready, and a burst of reveals
// never stacks into one long freeze.

export interface WebglUpgradeQueueOptions {
  /** Wait after the most recent enqueue before the first job runs. */
  settleMs?: number;
  /** Schedules the next job (default: a task after the next paint). */
  idle?: (cb: () => void) => void;
  /** Delayed scheduler (injectable for tests). */
  delay?: (cb: () => void, ms: number) => unknown;
  /** Cancels a `delay` handle. */
  cancelDelay?: (handle: unknown) => void;
}

/** No settle wait by default: the first build runs right after the paint. */
export const WEBGL_UPGRADE_SETTLE_MS = 0;

/** Longest a pane stays hidden waiting for its build; past it the pane shows
 *  on whatever renderer it has. */
export const WEBGL_UPGRADE_HIDE_MAX_MS = 1000;

/** Runs `cb` in a task after the next paint. */
function afterNextPaint(cb: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(cb, 0));
  } else {
    setTimeout(cb, 0);
  }
}

export class WebglUpgradeQueue {
  private jobs: Array<{ run: () => void }> = [];
  private settleHandle: unknown = null;
  private draining = false;
  private readonly settleMs: number;
  private readonly idle: (cb: () => void) => void;
  private readonly delay: (cb: () => void, ms: number) => unknown;
  private readonly cancelDelay: (handle: unknown) => void;

  constructor(opts: WebglUpgradeQueueOptions = {}) {
    this.settleMs = opts.settleMs ?? WEBGL_UPGRADE_SETTLE_MS;
    this.idle = opts.idle ?? afterNextPaint;
    this.delay = opts.delay ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancelDelay = opts.cancelDelay ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Queue `run`. Returns a cancel function; cancelling a job that already
   *  ran or was cancelled is a no-op. */
  enqueue(run: () => void): () => void {
    const job = { run };
    this.jobs.push(job);
    // Every enqueue restarts the settle wait (when one is configured).
    if (!this.draining) {
      if (this.settleHandle !== null) this.cancelDelay(this.settleHandle);
      this.settleHandle = this.delay(() => {
        this.settleHandle = null;
        this.drain();
      }, this.settleMs);
    }
    return () => {
      const i = this.jobs.indexOf(job);
      if (i >= 0) this.jobs.splice(i, 1);
    };
  }

  /** Jobs still waiting (diagnostics/tests). */
  get pending(): number {
    return this.jobs.length;
  }

  private drain(): void {
    if (this.jobs.length === 0) {
      this.draining = false;
      return;
    }
    this.draining = true;
    this.idle(() => {
      const job = this.jobs.shift();
      if (job) {
        try {
          job.run();
        } catch {
          /* an upgrade failure must not stall the queue */
        }
      }
      this.drain();
    });
  }
}

/** Process-wide queue: every terminal shares it. */
export const webglUpgradeQueue = new WebglUpgradeQueue();
