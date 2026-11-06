// Page dialogs (alert, confirm) on in-app browser tabs while an agent drives them.
//
// With nobody driving, a dialog is the person's: Electron shows its native box
// and the page waits for an answer, as in any browser. Nothing here touches that.
//
// While an agent drives the tab (a lease is held), the same wait would stall the
// agent's call until someone happened to look. So the dialog is answered at once,
// dismissed unless the agent armed an answer for it, and reported in the next tool
// result. A dialog already open when a lease starts is answered then, or once it's
// old enough if it has only just opened (see below).
//
// Answering over CDP doesn't close Electron's box: it stays until someone clicks
// it, and each answered dialog leaves its own. On macOS it's a sheet on the main
// window, which takes no keyboard or mouse input until the sheet is dismissed. So
// answers are capped across all tabs: without that, pages looping alert() would
// stack boxes without limit, where a page that isn't answered can only ever show
// one. Past the cap a page waits on its box like any other, and the agent is told
// why.
//
// A Playwright page attached to the guest answers its own dialogs, including armed
// answers, within a few hundred ms, and main can't see that it's there. So a dialog
// that didn't come from an RPC-lane input waits long enough for that, and this
// stands down once the dialog has closed. One raised by an RPC-lane input is ours
// and is answered at once.

export const ARMED_DIALOG_TTL_MS = 30_000;
const MAX_MESSAGE_CHARS = 200;
const ANSWER_WINDOW_MS = 60_000;
const MAX_ANSWERS_PER_WINDOW = 3;
const ANSWER_DELAY_MS = 500;
/** A hung input call stops counting as in flight after this. */
const DISPATCH_TTL_MS = ARMED_DIALOG_TTL_MS;
/** A handler often raises its dialog a moment after the input returns. */
const DISPATCH_TAIL_MS = 500;

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
  open?: { type: string; message: string; capNoted: boolean; raisedByInput: boolean; openedAt: number };
  armed?: { accept: boolean; text?: string; expires: number };
  /** Input dispatches in flight. Only a dialog raised during one may use an armed answer. */
  dispatches: Set<{ expires: number }>;
}

export class GuestDialogs {
  private readonly surfaces = new Map<string, SurfaceDialogs>();
  /** Across all tabs: the boxes these leave all land on the same window. */
  private answeredAt: number[] = [];

  constructor(private readonly deps: GuestDialogsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private surface(surfaceId: string): SurfaceDialogs {
    let state = this.surfaces.get(surfaceId);
    if (!state) {
      state = { dispatches: new Set() };
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
    const now = this.now();
    const raisedByInput = [...state.dispatches].some((dispatch) => dispatch.expires > now);
    state.open = { type, message: capped, capNoted: false, raisedByInput, openedAt: now };
    // The lease can end just before a handler's deferred dialog opens. That dialog
    // is still the agent's, and otherwise the page would wait for its next call.
    if (driven || raisedByInput) this.settleWhenDue(surfaceId, state);
  }

  /** Settle now if the open dialog is ours or has had its delay; otherwise when it has. */
  private settleWhenDue(surfaceId: string, state: SurfaceDialogs): void {
    const opened = state.open;
    if (!opened) return;
    const wait = opened.raisedByInput ? 0 : opened.openedAt + ANSWER_DELAY_MS - this.now();
    if (wait <= 0) {
      this.settle(surfaceId, state);
      return;
    }
    this.defer(() => {
      if (state.open === opened) this.settle(surfaceId, state);
    }, wait);
  }

  private defer(fn: () => void, ms: number): void {
    if (this.deps.defer) this.deps.defer(fn, ms);
    else setTimeout(fn, ms).unref?.();
  }

  /** `Page.javascriptDialogClosed`: answered by anyone, including the person. */
  closed(surfaceId: string): void {
    const state = this.surfaces.get(surfaceId);
    if (state) state.open = undefined;
  }

  /** A lease just started on this surface. */
  leaseStarted(surfaceId: string): void {
    const state = this.surfaces.get(surfaceId);
    if (state) this.settleWhenDue(surfaceId, state);
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
    const now = this.now();
    for (const old of state.dispatches) if (old.expires <= now) state.dispatches.delete(old);
    const dispatch = { expires: now + DISPATCH_TTL_MS };
    state.dispatches.add(dispatch);
    return () => {
      dispatch.expires = Math.min(dispatch.expires, this.now() + DISPATCH_TAIL_MS);
    };
  }

  forget(surfaceId: string): void {
    this.surfaces.delete(surfaceId);
  }

  private settle(surfaceId: string, state: SurfaceDialogs): void {
    const open = state.open;
    if (!open) return;
    const now = this.now();
    this.answeredAt = this.answeredAt.filter((at) => now - at < ANSWER_WINDOW_MS);
    if (this.answeredAt.length >= MAX_ANSWERS_PER_WINDOW) {
      if (!open.capNoted) {
        open.capNoted = true;
        this.deps.note(surfaceId, { type: open.type, message: open.message, answer: 'left open for a person (too many in a row)', at: now });
      }
      return;
    }
    const armed = open.raisedByInput && state.armed && state.armed.expires > now ? state.armed : undefined;
    if (armed) state.armed = undefined;
    state.open = undefined;
    this.answeredAt.push(now);
    // Report only what happened. A failed answer means something else got there
    // first, and it reports its own, or the page is gone.
    void this.deps.answer(surfaceId, armed?.accept ?? false, armed?.text).then(
      () => this.deps.note(surfaceId, {
        type: open.type,
        message: open.message,
        answer: armed ? (armed.accept ? 'accepted (pre-armed)' : 'dismissed (pre-armed)') : 'dismissed',
        at: now,
      }),
      () => undefined,
    );
  }
}
