### Fixed

- An unanswered decision no longer silently kills the delegation loop. A
  workspace with a pending decision is never auto-woken — that part is
  deliberate — but until now the events it blocked were dropped without a
  trace, so a decision left over from a previous session ate every fan-out
  worker's "I'm done" and the orchestrator simply looked asleep. The block is
  now logged (once per workspace per minute, and again straight away for a new
  decision), naming how many events it blocked and which delegated tasks they
  belonged to. A worker's own events are no longer thrown away either: they are
  parked in the same durable backlog that already holds events for a workspace
  with no orchestrator, so they survive an app restart — the decision does —
  and answering the decision replays them into the turn that follows. Answering
  also restores the auto-wake budget the wait may have eaten. Ambient chatter is
  still dropped, as before.

- `fanout_start` now warns you at the moment it accepts when the launching
  workspace has a pending decision, instead of starting workers whose reports
  will not reach anyone until it is answered. The warning leads the tool's
  answer as its own line, not just a field an agent can skim past.

- A refused `task_adopt`, `task_close` or `task_pr` now says so in a sentence
  before it says so in JSON. The answer opens with `REFUSED (<reason>):
  <error>`, states that nothing was adopted / closed / opened, and names the
  one move that clears it — because an orchestrator reading an envelope for a
  commit sha was skimming past `ok: false` and reporting an adopt that had
  never happened. Refusals from the permission gate (an approval declined or
  expired, a task that is not yours) now name their real cause instead of
  reading as "unknown", and the JSON itself is left untouched so anything that
  parses it still works.

- The task ledger explains itself when it refuses a status change. An illegal
  transition now lists the statuses that ARE reachable from the current one —
  and only the ones the caller is actually allowed to set, so it never suggests
  a move that would be refused a moment later. The `ledger_update` tool text
  states the whole table, says plainly that a task can only be completed from
  `review_requested`, and that an orchestrator may set that itself when the
  worker cannot — with `force` and a reason as the way past a missing gate.
