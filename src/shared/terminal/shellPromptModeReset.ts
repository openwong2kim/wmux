/**
 * Live-pane input-mode reset (#1792).
 *
 * A TUI agent (Claude Code, Codex, ...) arms mouse tracking (?1000/?1002/
 * ?1003 + ?1006) and focus reporting (?1004) while it runs and disarms them on
 * a clean exit. When it ends without disarming (killed, crashed, Ctrl+C at a
 * bad moment) the shell takes the prompt back but xterm keeps the modes, so
 * every pointer move and focus change is typed into the prompt as
 * `ESC[<35;12;7M` / `ESC[I` junk. STALE_REPLAY_ALIVE_SHELL_RESETS already
 * cures this on a stale replay; this guard applies the same reset to a LIVE
 * pane, at the moment the shell proves it owns the pane again.
 *
 * The evidence is read from the pane's own output, in stream order, through
 * xterm parser hooks:
 *
 *  - OSC 133;A (prompt start) — the shell is printing its prompt. 133;C
 *    (command start) hands the pane back to a command. wmux's shell
 *    integration emits both (src/daemon/shell-integration.ts).
 *  - DECSET of a reporting mode — who armed what, and when. Mouse tracking
 *    (?9/?1000/?1002/?1003) is never armed by a shell or by the PTY host, so
 *    it counts wherever it appears. Focus reporting (?1004) is ambiguous:
 *    ConPTY sends `ESC[?1004h` itself at the start of every Windows session.
 *    So before the first prompt mark a focus arm counts only when a mouse
 *    mode is already armed (a TUI replayed mid-run arms both; ConPTY's
 *    preamble arms focus alone), and after it, it counts as the command's.
 *  - `terminal.modes` — what is actually armed right now.
 *
 * A reset is owed at 133;A when a reporting mode was armed since the previous
 * prompt (by the command that just ended) and is still armed. It is never
 * written while a command owns the pane, or when anything re-armed a
 * reporting mode after the prompt.
 *
 * Process truth (desktop). A prompt mark proves the shell is reading input,
 * not that the arming process is dead: a TUI launched in the background
 * (`Start-Process -NoNewWindow`, `cmd &`) or stopped with Ctrl+Z is still
 * alive behind the prompt, and `fg` gives it the pane back without it
 * re-arming anything. When the caller supplies `isForegroundGone`, the reset
 * is written only once that hook answers `true`; `false` (a live process
 * still owns the modes) drops the owed reset, and `undefined` (no answer yet,
 * or a stale one) keeps it owed and asks again after `recheckMs`. Without the
 * hook (phone page, remote mirror) the prompt mark alone decides, as before.
 *
 * Input drop. While a reset is owed but not yet applied (the truth is being
 * asked for, or the reset is queued behind pending output — xterm parses in
 * ~12 ms slices), mouse and focus REPORTS are dropped from onData through
 * `dropsReport()`. The drop ends when the reset applies, when a new owner
 * shows up (133;C or a reporting DECSET), or when process truth says a live
 * process owns the modes.
 *
 * Alternate screen is deliberately NOT a condition. Claude Code 2.1.289
 * enters ?1049 and arms ?1000/?1002/?1003/?1006/?1004, and after `taskkill`
 * PowerShell draws its prompt on that alternate screen with every mode still
 * armed. Gating on the normal screen would skip exactly the case this guard
 * exists for. Only the input-reporting modes are cleared.
 *
 * ConPTY focus (win32). Only the modes the dead command armed are cleared. A
 * command that armed only the mouse leaves ConPTY's own ?1004h on. A command
 * that armed ?1004h itself is indistinguishable from ConPTY's arm (one mode
 * bit), so focus reporting is cleared and stays off for the rest of that
 * session. It is deliberately NOT re-armed: xterm answers every ?1004h with an
 * immediate `ESC[I`/`ESC[O`, and a killed TUI (Claude Code) leaves the console
 * in VT-input mode, so a re-arm would type that report — and every later
 * focus change — into the prompt, which is the junk this guard removes.
 * ConPTY only turns focus reports into FOCUS_EVENT records, which a shell at
 * its prompt does not read; the next TUI that wants focus arms it again.
 *
 * Ordering. `terminal.write()` from inside a parser handler appends to the END
 * of xterm's write queue, so output already queued behind the prompt is parsed
 * before the reset lands. The reset therefore re-validates WHERE IT APPLIES:
 * it is wrapped in a private OSC marker carrying a per-terminal nonce and the
 * resolution's id, and when the parser reaches the marker the conditions are
 * checked again. If they no longer hold, the DECRSTs inside are swallowed.
 *
 * `reset()` must be called next to every `terminal.reset()`: a pane switch or
 * a snapshot replay starts a new stream (ConPTY's preamble included), and the
 * guard's phase from the old one would otherwise count that preamble's ?1004h
 * as a command's arm.
 *
 * Written to the terminal only, never to the PTY. ?2004 (bracketed paste) is
 * not touched: the shell arms it for itself, see STALE_REPLAY_ALIVE_SHELL_RESETS.
 */
import { STALE_REPLAY_ALIVE_SHELL_RESETS } from './staleReplayModeReset';

interface Disposable {
  dispose(): void;
}

type CsiParams = (number | number[])[];

/** The slice of an xterm `Terminal` (desktop or headless) the guard uses. */
export interface ShellPromptModeResetTerminal {
  readonly parser: {
    registerOscHandler(ident: number, callback: (data: string) => boolean): Disposable;
    registerCsiHandler(
      id: { prefix?: string; intermediates?: string; final: string },
      callback: (params: CsiParams) => boolean,
    ): Disposable;
  };
  readonly modes: {
    readonly mouseTrackingMode: string;
    readonly sendFocusMode: boolean;
  };
  write(data: string): void;
}

/**
 * Process truth for the arming process. `true`: it is gone, reset. `false`: a
 * live process still owns the modes, leave them. `undefined`: unknown or
 * stale, ask again later (the input drop covers the wait).
 */
export type ForegroundGoneProbe = (ctx: { promptAt: number }) =>
  boolean | undefined | Promise<boolean | undefined>;

export interface ShellPromptModeResetOptions {
  /** Desktop only. Omit to let the prompt mark alone decide. */
  isForegroundGone?: ForegroundGoneProbe;
  /** Delay before asking again after an `undefined` answer. Default 5 s. */
  recheckMs?: number;
  /** Answers asked for per prompt before giving up (the drop then stays until a new owner). Default 8. */
  maxProbes?: number;
  /** Timer seam (tests). Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Clock seam (tests). */
  now?: () => number;
}

/** Mouse tracking modes that make xterm emit reports. Encodings (?1005/?1006/?1015) emit nothing alone. */
const MOUSE_TRACKING_MODES: ReadonlySet<number> = new Set([9, 1000, 1002, 1003]);
const FOCUS_REPORTING_MODE = 1004;
const FOCUS_RESET = '\x1b[?1004l';
/** The alive-shell reset without focus: what a mouse-only leak gets. */
const MOUSE_ONLY_RESETS = STALE_REPLAY_ALIVE_SHELL_RESETS.replace(FOCUS_RESET, '');

/**
 * One whole report as xterm emits it through onData (one per event): SGR
 * (`ESC[<b;x;yM/m`, also SGR-pixels), X10/UTF-8 (`ESC[M` + 3), urxvt
 * (`ESC[b;x;yM`), focus (`ESC[I` / `ESC[O`). Anchored: typed text that merely
 * contains such bytes is never matched.
 */
// eslint-disable-next-line no-control-regex -- intentional: matches the ESC-led report bytes xterm emits
const REPORT_RE = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+;\d+M|\x1b\[[IO])+$/;

/** True when `data` is nothing but mouse / focus reports. */
export function isMouseOrFocusReport(data: string): boolean {
  return REPORT_RE.test(data);
}

/**
 * Private OSC identifier for the reset's guard marker. Only this xterm ever
 * sees it: the marker is written terminal-side and is not part of the pane's
 * output, its ring buffer, or anything sent to the PTY.
 */
export const PROMPT_MODE_RESET_GUARD_OSC = 7792;

type Phase = 'unknown' | 'prompt' | 'command';
/** idle: nothing owed in flight. awaiting: asking process truth. queued: marker written. */
type Resolution = 'idle' | 'awaiting' | 'queued';

export interface ShellPromptModeReset extends Disposable {
  /** Test seam: how many resets were applied (not merely queued). */
  readonly appliedCount: number;
  /** True while mouse / focus reports are being held back (see `dropsReport`). */
  readonly dropping: boolean;
  /** Whether onData should drop `data`: a pure mouse/focus report while a reset is owed. */
  dropsReport(data: string): boolean;
  /** Forget everything folded so far. Call next to every `terminal.reset()`. */
  reset(): void;
}

interface Installed {
  handle: ShellPromptModeReset;
  setOptions(options: ShellPromptModeResetOptions): void;
}

const installed = new WeakMap<object, Installed>();

function makeNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/** The guard installed on `term`, if any (no install). */
export function shellPromptModeResetFor(term: object): ShellPromptModeReset | undefined {
  return installed.get(term)?.handle;
}

/**
 * Install the guard on `term`. Idempotent per terminal instance: a terminal
 * adopted by a new mount keeps the guard (and the state it has folded) it got
 * on first install. Passing `options` again replaces them, so an adopting
 * mount can bind its own process-truth probe. The handlers live as long as the
 * terminal; dispose the returned handle only to remove them early.
 */
export function installShellPromptModeReset(
  term: ShellPromptModeResetTerminal,
  options?: ShellPromptModeResetOptions,
): ShellPromptModeReset {
  const existing = installed.get(term);
  if (existing) {
    if (options) existing.setOptions(options);
    return existing.handle;
  }

  let opts: ShellPromptModeResetOptions = options ?? {};
  const nonce = makeNonce();
  const marker = (id: number, edge: 'begin' | 'end') =>
    `\x1b]${PROMPT_MODE_RESET_GUARD_OSC};${nonce};${edge};${id}\x07`;

  let phase: Phase = 'unknown';
  /** A reporting mode was armed since the last prompt mark (by whatever ran). */
  let armedSincePrompt = false;
  /** ...and focus reporting was among them (item: ConPTY focus is kept otherwise). */
  let focusArmedSincePrompt = false;
  /** A reset is owed: armed by a command that is gone from the stream. Survives a 133;C with no arming. */
  let owed: { focus: boolean } | null = null;
  let resolution: Resolution = 'idle';
  /** Id of the current resolution; stale probe answers and markers carry an older one. */
  let resolutionId = 0;
  let promptAt = 0;
  let probes = 0;
  let cancelTimer: (() => void) | null = null;
  /** Inside a guard marker whose re-validation failed: swallow its DECRSTs. */
  let veto = false;
  let applied = 0;

  const now = () => (opts.now ?? Date.now)();

  const stopResolving = () => {
    resolution = 'idle';
    resolutionId++;
    probes = 0;
    if (cancelTimer) { cancelTimer(); cancelTimer = null; }
  };

  /** The shell owns the pane and a mode the dead command armed is still armed. */
  const leaked = () =>
    phase === 'prompt' && owed !== null
    && (term.modes.mouseTrackingMode !== 'none' || (owed.focus && term.modes.sendFocusMode));

  const queueMarker = () => {
    if (!owed) return;
    resolution = 'queued';
    const resets = owed.focus ? STALE_REPLAY_ALIVE_SHELL_RESETS : MOUSE_ONLY_RESETS;
    term.write(marker(resolutionId, 'begin') + resets + marker(resolutionId, 'end'));
  };

  const askTruth = () => {
    const probe = opts.isForegroundGone;
    if (!probe) { queueMarker(); return; }
    const id = resolutionId;
    probes++;
    const settle = (gone: boolean | undefined) => {
      if (id !== resolutionId || resolution !== 'awaiting') return; // superseded
      if (gone === true) {
        if (leaked()) queueMarker();
        else { owed = null; stopResolving(); }
      } else if (gone === false) {
        // A live process still owns the modes: it keeps its mouse.
        owed = null;
        stopResolving();
      } else if (probes < (opts.maxProbes ?? 8)) {
        cancelTimer = (opts.setTimer ?? defaultTimer)(() => {
          cancelTimer = null;
          if (id === resolutionId && resolution === 'awaiting') askTruth();
        }, opts.recheckMs ?? 5000);
      }
      // Out of probes: stay 'awaiting' (reports keep being dropped) until a
      // new owner, a reset() or the next prompt mark.
    };
    let answer: boolean | undefined | Promise<boolean | undefined>;
    try {
      answer = probe({ promptAt });
    } catch {
      answer = undefined;
    }
    if (answer && typeof (answer as Promise<unknown>).then === 'function') {
      (answer as Promise<boolean | undefined>).then(settle, () => settle(undefined));
    } else {
      settle(answer as boolean | undefined);
    }
  };

  const onPromptMark = (data: string): boolean => {
    // `A`, `B`, `C`, `D;<exit>`, sometimes with `;k=v` options after the kind.
    const kind = data.charAt(0);
    if (kind === 'A') {
      phase = 'prompt';
      if (armedSincePrompt) {
        owed = { focus: focusArmedSincePrompt || (owed?.focus ?? false) };
      }
      armedSincePrompt = false;
      focusArmedSincePrompt = false;
      if (owed && !leaked()) owed = null; // disarmed cleanly
      if (owed && resolution === 'idle') {
        stopResolving();
        resolution = 'awaiting';
        promptAt = now();
        askTruth();
      }
    } else if (kind === 'C') {
      phase = 'command';
      // The command now owns input; nothing to drop for it. A reset still owed
      // is re-examined at its prompt unless it arms something itself.
      if (resolution !== 'idle') stopResolving();
    }
    return false; // observe only: other OSC 133 consumers still see it
  };

  const onDecset = (params: CsiParams): boolean => {
    let mouseOn = term.modes.mouseTrackingMode !== 'none';
    for (const p of params) {
      if (typeof p !== 'number') continue;
      const mouse = MOUSE_TRACKING_MODES.has(p);
      const focus = p === FOCUS_REPORTING_MODE && (phase !== 'unknown' || mouseOn);
      if (mouse) mouseOn = true;
      if (mouse || focus) {
        // Something armed a reporting mode: it is the new owner, so a reset
        // owed for an earlier prompt must not land.
        armedSincePrompt = true;
        if (focus) focusArmedSincePrompt = true;
        owed = null;
        if (resolution !== 'idle') stopResolving();
      }
    }
    return false; // observe only: xterm still applies the mode
  };

  const onDecrst = (): boolean => veto;

  const onGuardMarker = (data: string): boolean => {
    const [n, edge, idText] = data.split(';');
    if (n !== nonce) return false;
    if (edge === 'begin') {
      const current = Number(idText) === resolutionId && resolution === 'queued';
      const apply = current && leaked();
      veto = !apply;
      if (current) {
        if (apply) applied++;
        owed = null;
        stopResolving();
      }
      return true;
    }
    if (edge === 'end') {
      veto = false;
      return true;
    }
    return false;
  };

  const disposables: Disposable[] = [
    term.parser.registerOscHandler(133, onPromptMark),
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, onDecset),
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, onDecrst),
    term.parser.registerOscHandler(PROMPT_MODE_RESET_GUARD_OSC, onGuardMarker),
  ];

  const handle: ShellPromptModeReset = {
    get appliedCount() { return applied; },
    get dropping() { return resolution !== 'idle'; },
    dropsReport(data: string) {
      return resolution !== 'idle' && isMouseOrFocusReport(data);
    },
    reset() {
      stopResolving();
      phase = 'unknown';
      armedSincePrompt = false;
      focusArmedSincePrompt = false;
      owed = null;
      veto = false;
    },
    dispose() {
      stopResolving();
      for (const d of disposables) d.dispose();
      installed.delete(term);
    },
  };
  installed.set(term, { handle, setOptions: (o) => { opts = o; } });
  return handle;
}
