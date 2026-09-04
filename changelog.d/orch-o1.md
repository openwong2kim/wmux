### Fixed

- `terminal_send({ submit: true })` now reports whether the prompt was actually
  committed. The result carries `accepted` — true only when the pane was
  observed to move (its turn started, or the input line cleared) — plus
  `agentStatusAfter`, and the pane's last screen lines when it did not. The
  Enter is re-sent once before giving up. Previously `submitted: true` meant
  only "a carriage return was written", so an orchestrator reported progress on
  panes whose prompt was still sitting uncommitted in the composer.

- An orchestrator brain can finally reach the agents in its own workspace. A
  brain owns no pane, so every same-workspace A2A reply it sent to an ADDRESSED
  pane was suppressed as an "unverified sender" and merely stored — the brain
  was told the message landed while the worker sat waiting. A caller carrying
  the daemon-validated commander binding, for the workspace that binding names,
  now satisfies that one guard. An anchorless reply is still suppressed (it
  would fall back to whichever pane happens to be focused), and the self-loop
  protection for pane callers is unchanged.

- An automated approval press is now scoped to panes that were actually
  delegated: the target's workspace must be a task workspace with autonomy on,
  the prompt must have come from a hook rather than the screen-regex detector,
  and a re-read must still show it. A fact the daemon cannot establish counts
  as a refusal, and a refusal leaves the request live for a human to answer.
  People are not subject to any of this — approving or denying from the phone
  or the web works exactly as before — and a DENY is always allowed, from any
  caller, because refusing one would keep a pane blocked in the name of safety.

- A channel wake nudge now carries the first line of the message it is waking
  you for, so an agent no longer has to spend a turn reading just to find out
  whether the nudge mattered. It rides only into panes wmux can name as an
  agent TUI, with shell metacharacters stripped: the text comes from another
  workspace and is committed with an Enter, so a pane that is really a shell
  would run it. A nudge that never landed (the pane died mid-race) marks that
  member's own rows, over the message range it announced, `target_gone` instead
  of leaving them looking pending forever — and a later ack promotes them back
  to `delivered`. A nudge that DID land is still not a delivery receipt.

- `wmux channel unread` and the `channel_unread` tool now answer from the same
  daemon call and report the same set. The CLI no longer takes the member from
  `$WMUX_MEMBER_ID` (only an explicit `--member`, matching the tool) and no
  longer hides caught-up rows, so the two surfaces can no longer contradict
  each other about what you owe. Each row names its member, and a workspace
  holding several says so, since without `--member` the rows shown are the
  whole workspace's and not only yours.
