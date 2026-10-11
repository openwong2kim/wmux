### Fixed

- **A message Moa never received no longer blocks the chat later.** If Moa
  could not start (Claude Code not found, or Claude's first-time setup was
  still open), your message was still remembered as an open request. The next
  time you opened wmux, Moa asked "A request from before this wmux session is
  still on the books. Resume it, or drop it?" and would not take new messages
  until you answered. A message that never reached Moa is now forgotten right
  away, so you can just send again.
