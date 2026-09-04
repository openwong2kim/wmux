### Added

- Channel composer now tells you where an @mention will actually land: a mention
  of a roster member is pinned to that member's own agent pane (the only shape
  that reaches an idle agent), with a "will reach …" hint under the input. A
  member with no live agent pane is offered as a badge-only mention and labelled
  as one instead of silently reaching nobody.
- Channel messages you post now show what actually happened to them: delivered
  as soon as any recipient got it, target gone when none did, and "no answer —
  nudges exhausted" when the wake worker gave up on a mentioned agent. A post
  that never gets an outcome now reads "delivery unconfirmed" instead of
  claiming to still be sending forever.
- Fleet's approval inbox shows the auto-reject countdown on every approval that
  has a deadline, and keeps a short "auto-rejected" log of the ones that expired
  while you were away instead of letting them vanish like an answered prompt.
- The Missions section header now opens the task cleanup scan, and a close that
  fails on a worktree still holding uncommitted work offers two next steps on
  the row itself: "Commit & close", which types a ready-to-run
  `git -C <worktree> add -- <the changed paths> && git -C <worktree> commit -m
  "wip: <task>"` into the task's own shell without running it, and "Open
  worktree". The commit line is offered only when the task's pane is a shell (in
  an agent's TUI it would become a chat message) and only on POSIX shells.

### Changed

- A pane that joined a channel over MCP or the CLI is now named the way the rest
  of wmux names it — its rename, else `w<workspace>-<pane>(<agent>)` — in the
  members roster and on the transcript's sender chip, instead of the opaque
  spawn-stamped member id it used to print.

### Fixed

- The channel composer's "no channel or workspace identity" post failure and the
  agent mention-loop warning are translated (en/ko/pl) instead of always English.
- The members roster's agent liveness dot carries an accessible label, so a
  screen reader reports whether an agent's pane is live or gone.
- Two channel members of the same workspace that have no live pane can both be
  @mentioned in one post — the second mention used to be dropped silently.
- A "no answer — nudges exhausted" mark applies only to the messages that were
  already posted when the wake worker gave up, and clears once that member
  catches up, leaves, or the channel is archived. It used to stick to every
  message you ever posted in that channel.
