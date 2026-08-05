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
 * Callers must gate on the daemon's `resumeAgent` field from pty.list: it is
 * only present for sessions recovered THIS daemon boot whose agent has not
 * been re-detected, i.e. exactly the panes where the mode-arming process is
 * known dead. A live reconnect (agent still running and legitimately using
 * the mouse) never carries it, so its modes are never clobbered.
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
 * Whether a replaying attach-flush should disable the replayed input-reporting
 * modes.
 *
 * `resumeAgent` alone was too narrow (#805): it is populated only on DAEMON
 * boot, so quitting and relaunching the APP while the daemon survives left
 * every gate false. The replay still re-armed the dead TUI's mouse tracking,
 * and the next pointer move over the pane wrote an SGR report into the fresh
 * shell's stdin — the literal `35;9;12M` junk on the prompt.
 *
 * `commandRunning === false` closes that hole with the precise condition: OSC
 * 133 says the shell is at its prompt, so NO foreground process exists that
 * could legitimately own mouse/focus/paste reporting, and whatever the replay
 * armed is by definition stale. It also covers non-agent TUIs (vim, htop) that
 * `resumeAgent` never described.
 *
 * `true` (a live command owns the PTY) and `undefined` (no shell integration —
 * no evidence either way) both decline, so a running TUI's modes are never
 * clobbered.
 */
export function shouldResetStaleReplayModes(session: StaleReplayModeGateInput | undefined): boolean {
  if (!session) return false;
  return Boolean(session.resumeAgent) || session.commandRunning === false;
}
