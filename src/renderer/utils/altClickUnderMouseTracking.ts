/**
 * Keep xterm's Option/Alt+click-moves-cursor off while the app owns the mouse.
 *
 * With `macOptionClickForcesSelection` on (#1437), an Option+mousedown under
 * mouse tracking is taken by xterm's SelectionService instead of being
 * reported to the app. A short Option+click then ends in `_handleMouseUp`'s
 * `altClickMovesCursor` branch, which writes synthesized arrow keys to the
 * PTY. In an app like Claude Code that is not "move the cursor here" — Up/Down
 * walk the prompt history and replace what the user was typing.
 *
 * So the behaviour is tied to the mode: on at a shell prompt (tracking off),
 * where click-to-move is what the user expects, off while an app tracks the
 * mouse. The listener runs in the capture phase on the terminal's container,
 * before xterm's own mousedown handler, so the option is right for the click
 * that is starting — the app may have toggled tracking since the last one.
 */

export interface AltClickTerminal {
  modes: { mouseTrackingMode: string };
  options: { altClickMovesCursor?: boolean };
}

export function syncAltClickToMouseTracking(term: AltClickTerminal): void {
  const wanted = term.modes.mouseTrackingMode === 'none';
  if (term.options.altClickMovesCursor !== wanted) term.options.altClickMovesCursor = wanted;
}

/** Wires the sync to `container`; returns the teardown. */
export function installAltClickTrackingGuard(container: HTMLElement, term: AltClickTerminal): () => void {
  const onMouseDown = () => syncAltClickToMouseTracking(term);
  container.addEventListener('mousedown', onMouseDown, true);
  return () => container.removeEventListener('mousedown', onMouseDown, true);
}
