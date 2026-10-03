/**
 * Separates what a viewer TYPED from what its terminal ANSWERED.
 *
 * xterm (and the image addon) answer device queries in the output by
 * themselves — DA1/DA2, status and cursor reports, DECRPM, window and
 * XTSMGRAPHICS reports, colour queries — and deliver the answer through the
 * same `onData` that carries typing. A terminal that only mirrors a pane owned
 * by another machine must never send those answers: that machine's terminal is
 * the one the pane asked, and a second answer lands in the live shell as
 * typed garbage.
 *
 * Matching answers by shape cannot work: a modified F3 (`CSI 1 ; 2 R`) is
 * byte for byte a cursor report, and every query form the list misses leaks.
 * xterm already knows the difference: everything that comes from the user
 * (keys, IME, paste, mouse reports, `term.input`) goes through
 * `triggerDataEvent(data, true)`, which fires `onUserInput` synchronously just
 * before the matching `onData`. Answers fire `onData` alone. So data is
 * forwarded only when a user-input signal immediately preceded it.
 *
 * Focus reports (`CSI I` / `CSI O`) are the one exception that xterm sends
 * without the signal: they only follow a real focus change in this viewer,
 * so they pass.
 *
 * Reads `term._core.coreService` (xterm 5/6). Without it the gate cannot tell
 * the two apart and forwards everything, which is how a terminal without the
 * gate behaved: typing must never be the casualty.
 */

interface Disposable {
  dispose(): void;
}

/** The slice of an xterm `Terminal` the gate reads. */
export interface UserInputTerminal {
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => Disposable;
    };
  };
}

export interface UserInputGate {
  /** Wrap an `onData` listener. */
  (data: string): void;
  /** False when the terminal exposes no user-input signal (forwards everything). */
  readonly gated: boolean;
  dispose(): void;
}

const FOCUS_REPORTS: ReadonlySet<string> = new Set(['\x1b[I', '\x1b[O']);

/**
 * An `onData` listener for `term` that calls `send` only for data the user
 * produced. Register it with `term.onData(gate)`; dispose it with the terminal.
 */
export function gateUserInput(term: UserInputTerminal, send: (data: string) => void): UserInputGate {
  const onUserInput = term._core?.coreService?.onUserInput;
  let pending = false;
  const subscription = typeof onUserInput === 'function'
    ? onUserInput.call(term._core?.coreService, () => { pending = true; })
    : null;
  const gate = ((data: string) => {
    const fromUser = pending;
    pending = false;
    if (!subscription || fromUser || FOCUS_REPORTS.has(data)) send(data);
  }) as UserInputGate;
  Object.defineProperty(gate, 'gated', { value: subscription !== null });
  gate.dispose = () => { subscription?.dispose(); };
  return gate;
}
