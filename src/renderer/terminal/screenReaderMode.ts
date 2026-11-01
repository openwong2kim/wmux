// xterm's screen-reader mode, following whether a screen reader is on
// (utils/screenReader.ts). xterm 6.1 builds its accessibility tree when the
// option turns on and tears it down when it turns off, so a live change is one
// option write. The IME residue guard follows the mode: under it xterm keeps
// the textarea text for announcement, which the guard would wipe.

export interface ScreenReaderModeTerminal {
  options: { screenReaderMode?: boolean };
}

/** Sets the terminal's mode to `on`. Returns whether it changed. */
export function syncScreenReaderMode(terminal: ScreenReaderModeTerminal, on: boolean): boolean {
  if ((terminal.options.screenReaderMode ?? false) === on) return false;
  terminal.options.screenReaderMode = on;
  return true;
}

export type ImeResidueGuardStep = 'attach' | 'detach' | 'keep';

/** What a live mode change does to the IME residue guard: the mode turning on
 *  drops an attached guard; turning off brings one back only when the setting
 *  asks for it and none is attached. */
export function imeResidueGuardStep(state: {
  attached: boolean;
  screenReaderMode: boolean;
  settingOn: boolean;
}): ImeResidueGuardStep {
  if (state.screenReaderMode) return state.attached ? 'detach' : 'keep';
  return !state.attached && state.settingOn ? 'attach' : 'keep';
}

export interface ScreenReaderFollow {
  on(): boolean;
  subscribe(fn: () => void): () => void;
  guardSettingOn(): boolean;
  guard: { attached(): boolean; attach(): void; detach(): void };
}

/** Keeps the terminal's mode and its IME residue guard on the screen-reader
 *  state at every change. Returns the unsubscribe. */
export function followScreenReader(terminal: ScreenReaderModeTerminal, deps: ScreenReaderFollow): () => void {
  return deps.subscribe(() => {
    const on = deps.on();
    if (!syncScreenReaderMode(terminal, on)) return;
    const step = imeResidueGuardStep({
      attached: deps.guard.attached(),
      screenReaderMode: on,
      settingOn: deps.guardSettingOn(),
    });
    if (step === 'detach') deps.guard.detach();
    else if (step === 'attach') deps.guard.attach();
  });
}
