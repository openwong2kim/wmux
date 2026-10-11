### Fixed

- **A message Moa never received no longer blocks the chat later.** If Moa
  could not start (Claude Code not found, or Claude's first-time setup was
  still open), your message was still remembered as an open request. The next
  time you opened wmux, Moa asked "A request from before this wmux session is
  still on the books. Resume it, or drop it?" and would not take new messages
  until you answered. A message that never reached Moa is now forgotten right
  away, so you can just send again.
- **"Drop it" clears an old request right away.** If an older version already
  left such a request behind, choosing "Drop it" on Moa's card now removes it
  immediately, even when Moa itself cannot start yet. Before, the drop waited
  on Moa, so the card could never go away. Your typed message also stays in
  the box when Moa could not receive it, so you can send it again.
