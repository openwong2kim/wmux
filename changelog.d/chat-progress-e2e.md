### Fixed
- Desktop Chat now distinguishes sending, active response, confirmed completion, unconfirmed completion, lost updates, and ended agent sessions. Quiet output alone does not imply completion; the status includes a Terminal shortcut.
- Preserve conversation history and drafts when updates fail, and reject stale snapshots arriving after disconnect. Resolve live agent identity even when terminal name detection is empty.
- Reconcile terminal repaint activity with recorded `end_turn` only when no newer submitted or hook-signaled work exists. After an unconfirmed interruption, block chat sends so a new request cannot append to Claude's restored terminal draft; continue that turn in Terminal first.
- Add a real-Claude desktop E2E script covering send/completion, view switching, draft preservation, interruption, and optional isolated-daemon timeout/recovery.

Validation: seven live E2E checks passed on Claude Code 2.1.278 in the disposable `-chat-e2e` profile, including a real daemon SIGSTOP/SIGCONT timeout and recovery. 266 focused regression tests and TypeScript checking passed. Permission-gate races are covered by automated tests; approving tools in the live CLI was not part of this E2E run.
