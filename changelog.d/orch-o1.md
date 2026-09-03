### Fixed

- `terminal_send({ submit: true })` now reports whether the prompt was actually
  committed. The result carries `accepted` — true only when the pane was
  observed to move (its turn started, or the input line cleared) — plus
  `agentStatusAfter`, and the pane's last screen lines when it did not. The
  Enter is re-sent once before giving up. Previously `submitted: true` meant
  only "a carriage return was written", so an orchestrator reported progress on
  panes whose prompt was still sitting uncommitted in the composer.

- An orchestrator brain can finally reach the agents in its own workspace. A
  brain owns no pane, so every same-workspace A2A reply it sent was suppressed
  as an "unverified sender" and merely stored — the brain was told the message
  landed while the worker sat waiting. A caller carrying the daemon-validated
  commander binding now satisfies that guard and the missing-anchor one, while
  the self-loop protection for pane callers is unchanged. A reply addressed at
  a brain is refused outright with `target_is_brain`: there is no pane behind
  it to write into.

- An automated approval press is now scoped to panes that were actually
  delegated: the target's workspace must be a task workspace with autonomy on,
  the prompt must have come from a hook rather than the screen-regex detector,
  and a re-read must still show it. A fact the daemon cannot establish counts
  as a refusal, and a refusal leaves the request live for a human to answer.

- A channel wake nudge now carries the first line of the message it is waking
  you for, so an agent no longer has to spend a turn reading just to find out
  whether the nudge mattered. A nudge that never landed (the pane died mid-race)
  marks that recipient `target_gone` instead of leaving the message looking
  pending forever; a nudge that DID land is still not a delivery receipt.

- `wmux channel unread` and the `channel_unread` tool now answer from the same
  daemon call and report the same set. The CLI no longer takes the member from
  `$WMUX_MEMBER_ID` (only an explicit `--member`, matching the tool) and no
  longer hides caught-up rows, so the two surfaces can no longer contradict
  each other about what you owe.
