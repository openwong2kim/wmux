### Added

- `browser_replay` gained `promote` and `demote`. Promoting a proven recorded
  flow keeps it permanently — it carries its own copy of the steps, so it
  survives the 30-day expiry of the recording it came from — and has it offered
  to you automatically whenever a navigation lands on its page, naming the exact
  call that runs it. A flow must have succeeded at least three times to be
  promoted; a refusal says how many more runs it needs. Promoted flows live in
  `~/.wmux/promoted-skills/`, one file per workspace per flow, are archived
  after 30 idle days and deleted from the archive after 90 — nothing is deleted
  straight out of the live tree — and `demote` undoes a promotion without
  touching the underlying recording. Note that promoting stores the flow's
  typed values in plain text indefinitely; password fields were never captured,
  but variable-ise any other sensitive value before promoting.
