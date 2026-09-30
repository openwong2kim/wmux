/**
 * Stale-replay input-mode reset (reboot-reattach RCA 2026-07-02, resume-pill
 * self-dismiss).
 *
 * When the daemon recovers a session after an OS reboot, attaching replays the
 * persisted ring buffer verbatim. If the pane was running a TUI agent when
 * Windows killed it (exitCode 0x40010004), the replayed bytes contain the
 * agent's DECSET arming sequences — mouse tracking (?1000/?1002/?1003/?1006),
 * focus reporting (?1004), bracketed paste (?2004) — with no matching disable,
 * because the process never got to shut down. xterm re-executes them, so the
 * FRESH shell now sitting in the pane inherits input-reporting modes it never
 * asked for:
 *
 *  - ?1003 (any-motion tracking) makes xterm emit SGR mouse reports through
 *    onData the moment the pointer crosses the pane. The onData "user typed →
 *    retract resume offer" heuristic in useTerminal only exempts focus
 *    reports, so moving the mouse TOWARD the resume pill is what dismissed it.
 *  - The same report bytes are written to the shell's stdin as junk input.
 *
 * This string disables every input-REPORTING mode xterm.js implements, plus
 * bracketed paste (a leaked ?2004h wraps pastes in markers the fresh shell
 * never negotiated). Written to the TERMINAL only (terminal.write), never to
 * the PTY. Display state (?1049 alt screen, ?25 cursor) is intentionally left
 * alone — resetting it would visibly alter the restored scrollback.
 *
 * Callers must NOT apply this blindly — see staleReplayResetLevel() for which
 * of the two constants below a given pane has earned. This full reset is only
 * safe when the mode-arming process is KNOWN DEAD (daemon-boot recovery, or a
 * dead-session snapshot paint), because ?2004 in particular is owned by the
 * live shell, not just by TUIs.
 */
export const STALE_REPLAY_INPUT_MODE_RESETS =
  '\x1b[?9l' + // X10 mouse
  '\x1b[?1000l' + // VT200 mouse (click)
  '\x1b[?1002l' + // button-event tracking (drag)
  '\x1b[?1003l' + // any-event tracking (motion — the pill killer)
  '\x1b[?1006l' + // SGR extended mouse encoding
  '\x1b[?1004l' + // focus in/out reporting
  '\x1b[?2004l'; // bracketed paste

/**
 * The reset for panes we believe are STALE but whose shell is alive: every
 * input-reporting mode a SHELL never arms for itself.
 *
 * Mouse tracking (?9/?1000/?1002/?1003/?1006) and focus reporting (?1004) both
 * qualify — they are TUI features, and a shell sitting at its prompt has no use
 * for either. Both also leak the same way: xterm emits their reports through
 * onData, and useTerminal forwards onData to the PTY unconditionally (the
 * CSI I / CSI O guard there only spares the resume hint, it does not stop the
 * write). So a leaked ?1004h types `ESC[I` into the prompt on every focus
 * change, exactly as a leaked ?1003h types `ESC[<35;9;12M` on every mouse move.
 *
 * ?2004 is the one exclusion, and it is not symmetric with the others: a shell
 * at its prompt arms bracketed paste ITSELF, and wmux decides whether to wrap a
 * paste in `ESC[200~` by reading xterm's OWN `modes.bracketedPasteMode`
 * (clipboardChunk.ts, Terminal.tsx, useTerminal.ts). Clearing it terminal-side
 * desynchronizes the two: the shell still expects wrapped pastes, wmux stops
 * sending them, and a multi-line paste lands as N separate commands the shell
 * executes immediately. That is far worse than the junk this reset prevents, so
 * ?2004 stays confined to known-dead panes.
 */
export const STALE_REPLAY_ALIVE_SHELL_RESETS =
  '\x1b[?9l' + // X10 mouse
  '\x1b[?1000l' + // VT200 mouse (click)
  '\x1b[?1002l' + // button-event tracking (drag)
  '\x1b[?1003l' + // any-event tracking (motion — the junk-input source)
  '\x1b[?1006l' + // SGR extended mouse encoding
  '\x1b[?1004l'; // focus in/out reporting (CSI I / CSI O — same leak, no shell owner)

/**
 * Stale-replay display-state reset ("frozen scroll window" bug).
 *
 * A TUI agent that dies mid-run can leave a DECSTBM scroll region armed
 * (ESC[<top>;<bottom>r, used to pin its input box to the bottom of the
 * screen) with no matching ESC[r to release it. The replayed ring buffer
 * re-executes that sequence into the fresh xterm instance, which then only
 * scrolls inside that narrow region — new output renders into a fixed
 * window while everything outside it (including real prior scrollback)
 * stays frozen on screen. Scrolling up does not reach history; it reveals
 * whatever was frozen there when the region was armed.
 *
 * ESC[r resets the scroll region to full-screen WITHOUT erasing any cell,
 * so unlike the ?1049/?25 display state called out above, resetting it
 * cannot visibly alter restored scrollback — it only un-narrows where
 * future writes are allowed to scroll.
 *
 * xterm.js's CSI r handler also snaps the cursor to (0,0) as a side effect
 * of resetting the margins (see InputHandler.ts setScrollRegion), which
 * would otherwise clobber wherever the replayed buffer left the cursor.
 * DECSC/DECRC (ESC 7 / ESC 8) bracket the reset to save and restore the
 * cursor position across it, so releasing the region never moves the
 * cursor the replay positioned.
 */
export const STALE_REPLAY_DISPLAY_RESETS =
  '\x1b7' + // DECSC: save cursor position (CSI r below would otherwise clobber it)
  '\x1b[?6l' + // DECOM: origin mode off (cursor addressing absolute again)
  '\x1b[r' + // DECSTBM: scroll region back to full screen
  '\x1b8'; // DECRC: restore the cursor position saved above

/** The subset of a `pty.list` entry this gate reads. */
export interface StaleReplayModeGateInput {
  /** Daemon-boot recovery hint — set only for sessions recovered this boot
   *  whose agent has not been re-detected. */
  resumeAgent?: string;
  /** OSC 133 shell-integration state, surfaced only when the pane's shell
   *  actually emits prompt markers. `false` = the shell is sitting at its
   *  prompt with no foreground command. */
  commandRunning?: boolean;
}

/**
 * How much of the replayed input-mode state a pane has earned the right to
 * have cleared.
 *
 *  - `'full'`  — the arming process is known dead. Everything goes, ?2004
 *                included, because no live shell owns it either.
 *  - `'mouse'` — the pane looks stale but its SHELL is alive. Everything the
 *                shell does not arm for itself is cleared; see
 *                STALE_REPLAY_ALIVE_SHELL_RESETS for why ?2004 is the one mode
 *                left alone here.
 *  - `'none'`  — a live command owns the PTY, or there is no evidence.
 *
 * Why two levels rather than one boolean: `resumeAgent` alone was too narrow
 * (#807). It is populated only on DAEMON boot, so quitting and relaunching the
 * APP while the daemon survives left the gate false — the replay re-armed the
 * dead TUI's mouse tracking and the next pointer move wrote an SGR report into
 * the fresh shell's stdin, the literal `35;9;12M` junk on the prompt. Widening
 * to OSC 133's "shell is at its prompt" fixes that, but that signal proves only
 * that no FOREGROUND COMMAND is running — it says nothing about the shell,
 * which is very much alive and owns bracketed paste. Hence the split.
 *
 * `commandRunning === true` declines outright and outranks `resumeAgent`: a
 * recovered pane whose user has since started a fresh TUI has a live mode owner
 * regardless of what the daemon recorded at boot.
 */
export type StaleReplayResetLevel = 'full' | 'mouse' | 'none';

export function staleReplayResetLevel(
  session: StaleReplayModeGateInput | undefined,
): StaleReplayResetLevel {
  if (!session) return 'none';
  // A live foreground command owns the modes — never clobber it, even on a
  // pane the daemon flagged for resume.
  if (session.commandRunning === true) return 'none';
  if (session.resumeAgent) return 'full';
  if (session.commandRunning === false) return 'mouse';
  return 'none';
}
