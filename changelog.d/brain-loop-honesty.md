### Fixed

- An unanswered decision no longer silently kills the delegation loop. A
  workspace with a pending decision is never auto-woken — that part is
  deliberate — but until now the events it blocked were dropped without a
  trace, so a decision left over from a previous session ate every fan-out
  worker's "I'm done" and the orchestrator simply looked asleep. The block is
  now logged once per workspace per minute, naming how many events it held and
  which delegated tasks they belonged to, and a worker's own events are no
  longer thrown away: they are held and delivered on the turn that follows the
  answer. Ambient chatter is still dropped, as before.

- `fanout_start` now warns you at the moment it accepts when the launching
  workspace has a pending decision, instead of starting workers whose reports
  will not reach anyone until it is answered.

- A refused `task_adopt`, `task_close` or `task_pr` now says so in a sentence
  before it says so in JSON. The tool answer opens with `REFUSED (<reason>):
  <error>`, states that nothing was adopted / closed / opened, and names the
  one move that clears it — because an orchestrator reading an envelope for a
  commit sha was skimming past `ok: false` and reporting an adopt that had
  never happened.

- The task ledger explains itself when it refuses a status change. An illegal
  transition now lists the statuses that ARE reachable from the current one,
  and the `ledger_update` tool text states the whole table in one line — which
  moves belong to the worker, which to the orchestrator, and that `force` with
  a reason is the orchestrator's only way past a worker that cannot report for
  itself.
