// Page dialogs (alert, confirm) on in-app browser tabs while an agent drives them.
//
// With nobody driving, a dialog is the person's: Electron shows its native box
// and the page waits for an answer, as in any browser. Nothing here touches that.
//
// While an agent drives the tab (a lease is held), the same wait would stall the
// agent's call until someone happened to look. So the dialog is answered at once,
// dismissed unless the agent armed an answer for it, and reported in the next tool
// result. A dialog already open when a lease starts is answered then.
//
// Answering over CDP doesn't close Electron's box: it stays until someone clicks
// it, harmlessly, and each answered dialog leaves its own. So answers are capped:
// without that a page looping alert() would stack boxes without limit, where a
// page that isn't answered can only ever show one. Past the cap the page waits on
// its box like any other, and the agent is told why.
//
// A Playwright page attached to the guest answers its own dialogs within
// milliseconds, including armed answers, so the answer here waits briefly and
// stands down once the dialog has closed.

export const ARMED_DIALOG_TTL_MS = 30_000;
const MAX_MESSAGE_CHARS = 200;
const ANSWER_WINDOW_MS = 10_000;
const MAX_ANSWERS_PER_WINDOW = 3;
const ANSWER_DELAY_MS = 150;

export type GuestDialogAnswer =
  | 'dismissed'
  | 'accepted (pre-armed)'
  | 'dismissed (pre-armed)'
  | 'left open for a person (too many in a row)';

export interface GuestDialogNote {
  type: string;
  /** Page-controlled text, capped. */
  message: string;
  answer: GuestDialogAnswer;
  at: number;
}

export interface GuestDialogsDeps {
  answer(surfaceId: string, accept: boolean, text?: string): Promise<unknown>;
  note(surfaceId: string, note: GuestDialogNote): void;
  now?(): number;
  /** Test seam; defaults to an unref'd timer. */
  defer?(fn: () => void, ms: number): void;
}

interface SurfaceDialogs {
  /** Open and unanswered. A page can only have one: it is blocked until it's answered. */
  open?: { type: string; message: string; capNoted: boolean };
  armed?: { accept: boolean; text?: string; expires: number };
  /** Input dispatches in flight. Only a dialog raised by one may use an armed answer. */
  dispatching: number;
  answeredAt: number[];
}

export class GuestDialogs {
  private readonly surfaces = new Map<string, SurfaceDialogs>();

  constructor(private readonly deps: GuestDialogsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private surface(surfaceId: string): SurfaceDialogs {
    let state = this.surfaces.get(surfaceId);
    if (!state) {
      state = { dispatching: 0, answeredAt: [] };
      this.surfaces.set(surfaceId, state);
    }
    return state;
  }

  /** `Page.javascriptDialogOpening`. */
  opening(surfaceId: string, type: string, message: string, driven: boolean): void {
    // Electron settles beforeunload itself, and leaving a page always wins.
    if (type === 'beforeunload') return;
    const state = this.surface(surfaceId);
    const capped = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}…` : message;
    state.open = { type, message: capped, capNoted: false };
    if (!driven) return;
    const opened = state.open;
    this.defer(() => {
      if (state.open === opened) this.settle(surfaceId, state);
    });
  }

  private defer(fn: () => void): void {
    if (this.deps.defer) this.deps.defer(fn, ANSWER_DELAY_MS);
    else setTimeout(fn, ANSWER_DELAY_MS).unref?.();
  }

  /** `Page.javascriptDialogClosed`: answered by anyone, including the person. */
  closed(surfaceId: string): void {
    const state = this.surfaces.get(surfaceId);
    if (state) state.open = undefined;
  }

  /** A lease just started on this surface. */
  leaseStarted(surfaceId: string): void {
    const state = this.surfaces.get(surfaceId);
    if (state?.open) this.settle(surfaceId, state);
  }

  arm(surfaceId: string, accept: boolean, text?: string): void {
    this.surface(surfaceId).armed = {
      accept,
      ...(text !== undefined && { text }),
      expires: this.now() + ARMED_DIALOG_TTL_MS,
    };
  }

  /** Mark an input dispatch in flight. Returns the closer; safe to call twice. */
  beginDispatch(surfaceId: string): () => void {
    const state = this.surface(surfaceId);
    state.dispatching++;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      state.dispatching = Math.max(0, state.dispatching - 1);
    };
  }

  forget(surfaceId: string): void {
    this.surfaces.delete(surfaceId);
  }

  private settle(surfaceId: string, state: SurfaceDialogs): void {
    const open = state.open;
    if (!open) return;
    const now = this.now();
    state.answeredAt = state.answeredAt.filter((at) => now - at < ANSWER_WINDOW_MS);
    if (state.answeredAt.length >= MAX_ANSWERS_PER_WINDOW) {
      if (!open.capNoted) {
        open.capNoted = true;
        this.deps.note(surfaceId, { type: open.type, message: open.message, answer: 'left open for a person (too many in a row)', at: now });
      }
      return;
    }
    const armed = state.armed && state.armed.expires > now && state.dispatching > 0 ? state.armed : undefined;
    if (armed) state.armed = undefined;
    state.open = undefined;
    state.answeredAt.push(now);
    // Already answered, or the page is gone: nothing to do either way.
    void this.deps.answer(surfaceId, armed?.accept ?? false, armed?.text).catch(() => undefined);
    this.deps.note(surfaceId, {
      type: open.type,
      message: open.message,
      answer: armed ? (armed.accept ? 'accepted (pre-armed)' : 'dismissed (pre-armed)') : 'dismissed',
      at: now,
    });
  }
}
