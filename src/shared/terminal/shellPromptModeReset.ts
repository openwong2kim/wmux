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
 *  - OSC 133;A (prompt start) — the shell is printing its prompt, so whatever
 *    ran before it is gone. 133;C (command start) hands the pane back to a
 *    command. wmux's shell integration emits both (src/daemon/shell-integration.ts).
 *  - DECSET of a reporting mode — who armed what, and when. Mouse tracking
 *    (?9/?1000/?1002/?1003) is never armed by a shell or by the PTY host, so
 *    it counts wherever it appears. Focus reporting (?1004) counts only once
 *    the stream has shown a prompt mark: ConPTY sends `ESC[?1004h` itself at
 *    the start of every Windows session, so a focus mode armed before any
 *    prompt belongs to the host, not to a TUI, and is left alone.
 *  - `terminal.modes` — what is actually armed right now.
 *
 * The reset is queued at 133;A only when a reporting mode was armed since the
 * previous prompt (by the command that just ended) and is still armed. It is
 * never written while a command owns the pane (after 133;C), while anything
 * re-armed a reporting mode after the prompt, or while the alternate screen is
 * active (vim, less, htop, a full-screen TUI that is still drawing).
 *
 * Ordering. `terminal.write()` from inside a parser handler appends to the END
 * of xterm's write queue, so output already queued behind the prompt (a hidden
 * pane's backlog, a reconnect replay, a vim launched right after the prompt)
 * is parsed before the reset lands. The reset therefore re-validates WHERE IT
 * APPLIES: it is wrapped in a private OSC marker carrying a per-terminal nonce,
 * and when the parser reaches the marker the same conditions are checked
 * again. If they no longer hold, the DECRSTs inside the marker are swallowed.
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
  readonly buffer: { readonly active: { readonly type: string } };
  write(data: string): void;
}

/** Mouse tracking modes that make xterm emit reports. Encodings (?1005/?1006/?1015) emit nothing alone. */
const MOUSE_TRACKING_MODES: ReadonlySet<number> = new Set([9, 1000, 1002, 1003]);
const FOCUS_REPORTING_MODE = 1004;

/**
 * Private OSC identifier for the reset's guard marker. Only this xterm ever
 * sees it: the marker is written terminal-side and is not part of the pane's
 * output, its ring buffer, or anything sent to the PTY.
 */
export const PROMPT_MODE_RESET_GUARD_OSC = 7792;

type Phase = 'unknown' | 'prompt' | 'command';

export interface ShellPromptModeReset extends Disposable {
  /** Test seam: how many resets were applied (not merely queued). */
  readonly appliedCount: number;
}

const installed = new WeakMap<object, ShellPromptModeReset>();

function makeNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Install the guard on `term`. Idempotent per terminal instance: a terminal
 * adopted by a new mount keeps the guard (and the state it has folded) it got
 * on first install. The handlers live as long as the terminal; dispose the
 * returned handle only to remove them early.
 */
export function installShellPromptModeReset(term: ShellPromptModeResetTerminal): ShellPromptModeReset {
  const existing = installed.get(term);
  if (existing) return existing;

  const nonce = makeNonce();
  const begin = `\x1b]${PROMPT_MODE_RESET_GUARD_OSC};${nonce};begin\x07`;
  const end = `\x1b]${PROMPT_MODE_RESET_GUARD_OSC};${nonce};end\x07`;

  let phase: Phase = 'unknown';
  /** A reporting mode was armed since the last prompt mark (by whatever ran). */
  let armedSincePrompt = false;
  /** A reset is queued for the current prompt and nothing has invalidated it. */
  let pending = false;
  /** Inside a guard marker whose re-validation failed: swallow its DECRSTs. */
  let veto = false;
  let applied = 0;

  const reportingArmed = () =>
    term.modes.mouseTrackingMode !== 'none' || term.modes.sendFocusMode;
  /** The shell owns the pane and a mode it never asks for is still armed. */
  const leaked = () =>
    phase === 'prompt' && term.buffer.active.type === 'normal' && reportingArmed();

  const onPromptMark = (data: string): boolean => {
    // `A`, `B`, `C`, `D;<exit>`, sometimes with `;k=v` options after the kind.
    const kind = data.charAt(0);
    if (kind === 'A') {
      phase = 'prompt';
      const armedByCommand = armedSincePrompt;
      armedSincePrompt = false;
      if (armedByCommand && leaked() && !pending) {
        pending = true;
        term.write(begin + STALE_REPLAY_ALIVE_SHELL_RESETS + end);
      }
    } else if (kind === 'C') {
      phase = 'command';
      pending = false;
    }
    return false; // observe only: other OSC 133 consumers still see it
  };

  const onDecset = (params: CsiParams): boolean => {
    for (const p of params) {
      if (typeof p !== 'number') continue;
      if (MOUSE_TRACKING_MODES.has(p) || (p === FOCUS_REPORTING_MODE && phase !== 'unknown')) {
        // Something armed a reporting mode after the prompt: it is the new
        // owner, so a reset queued for that prompt must not land.
        armedSincePrompt = true;
        pending = false;
      }
    }
    return false; // observe only: xterm still applies the mode
  };

  const onDecrst = (): boolean => veto;

  const onGuardMarker = (data: string): boolean => {
    if (data === `${nonce};begin`) {
      const apply = pending && leaked();
      pending = false;
      veto = !apply;
      if (apply) applied++;
      return true;
    }
    if (data === `${nonce};end`) {
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
    dispose() {
      for (const d of disposables) d.dispose();
      installed.delete(term);
    },
  };
  installed.set(term, handle);
  return handle;
}
