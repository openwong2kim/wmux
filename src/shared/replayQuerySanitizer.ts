/**
 * Ring-replay query sanitizer (CPR feedback-storm RCA 2026-07-04).
 *
 * When the renderer reattaches, the daemon replays the persisted ring buffer
 * verbatim and xterm.js RE-EXECUTES every sequence in it — including one-shot
 * terminal queries the dead session's TUI once emitted. Each replayed query
 * fires a live auto-reply through terminal.onData → pty.write into whatever
 * process now owns the pty. After a daemon restart that process is a FRESH
 * shell that never asked: zsh's ZLE eats the `ESC[?` prefix, beeps, and
 * self-inserts the rest (`40;3R`...), and that junk echo is appended to the
 * ring — so every subsequent reattach re-fires the whole batch again.
 *
 * Incident evidence: a claude pane left running while the renderer was
 * detached (app restart window) had no responder, retried DECXCPR, and
 * accumulated 3,653 raw `\x1b[?6n` in its ring. On reattach xterm answered
 * all of them into the fresh zsh → 8,125 `40;3R^G` echoes, O(n²) ZLE line
 * redraws, zsh 98% / daemon 100% CPU.
 *
 * The sibling guard STALE_REPLAY_INPUT_MODE_RESETS cannot cover this class:
 * it un-latches MODES after the replay, but queries are one-shot — the reply
 * has already been sent by the time any reset could run. The only correct
 * point is to strip queries from the replay payload BEFORE xterm sees it.
 * Replay is display-only, and queries have zero display value, so stripping
 * is lossless for the user.
 *
 * Applied at DaemonClient.setupSessionPipe, the single choke point where the
 * full replay exists as one contiguous buffer cleanly separated from live
 * bytes by FLUSH_DONE_MARKER — no streaming/chunk-boundary state needed, and
 * live queries from running TUIs are never touched.
 */

/**
 * Every sequence family xterm.js answers with an auto-reply. Finals are
 * unambiguous: CSI `n` is only DSR, CSI `c` only DA, CSI `$p` only DECRQM.
 * XTVERSION requires the `>` prefix so DECSCUSR (`CSI Ps SP q`, cursor
 * style — display-relevant) is never matched.
 */
const REPLAY_QUERY_SEQUENCES = new RegExp(
  [
    // DSR / DECDSR — CSI Ps n, CSI ? Ps n (incl. the CPR offender \x1b[?6n)
    '\\x1b\\[\\??[0-9;]*n',
    // DA1 / DA2 / DA3 — CSI c, CSI > c, CSI = c
    '\\x1b\\[[>=]?[0-9;]*c',
    // XTVERSION — CSI > Ps q
    '\\x1b\\[>[0-9;]*q',
    // DECRQM — CSI Ps $ p, CSI ? Ps $ p (claude probes ?2026 sync output)
    '\\x1b\\[\\??[0-9;]*\\$p',
    // OSC color queries — OSC 4/5/10..19 whose last param is "?" (BEL or ST
    // terminated). Titles (OSC 0/2) never match, even ones ending in "?".
    '\\x1b\\](?:4|5|1[0-9])(?:;[0-9]*)*;\\?(?:\\x07|\\x1b\\\\)',
    // DCS queries — DECRQSS (DCS $ q .. ST) and XTGETTCAP (DCS + q .. ST)
    '\\x1bP[$+]q[^\\x1b]*\\x1b\\\\',
    // XTWINOPS size reports — CSI 14/16/18 t (text area / cell / grid size).
    // The inline-image addon (#1641) enables these. Only the query forms:
    // 22/23 t are title push/pop and >= 24 t is DECSLPP, both display state.
    '\\x1b\\[(?:14|16|18)(?:;[0-9]*)?t',
    // XTSMGRAPHICS — CSI ? Pi ; Pa ; Pv S (sixel palette / geometry query,
    // #1641). The `?` prefix keeps plain CSI Ps S (scroll up) untouched.
    '\\x1b\\[\\?[0-9;]*S',
    // ENQ — answerback query
    '\\x05',
  ].join('|'),
  'g',
);

/**
 * Strip auto-reply-triggering query sequences from a ring-replay payload.
 * Returns the input buffer unchanged (same reference) when nothing matched.
 */
export function stripReplayQuerySequences(replay: Buffer): Buffer {
  // latin1 gives a 1:1 byte↔char mapping, so multi-byte UTF-8 text round-trips
  // untouched and the regex only ever removes ASCII-range sequences.
  const text = replay.toString('latin1');
  const stripped = text.replace(REPLAY_QUERY_SEQUENCES, '');
  if (stripped.length === text.length) return replay;
  return Buffer.from(stripped, 'latin1');
}
