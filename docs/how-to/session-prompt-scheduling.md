# Schedule a prompt for one agent session

Session prompt schedules let wmux deliver a prepared prompt to a specific AI-agent pane at a future local time. This is useful for quota reset windows, delayed follow-ups, and recurring checks that should continue in an existing conversation.

## Create a schedule

1. Confirm wmux is connected to its daemon, then focus a terminal pane where wmux has detected an AI agent.
2. Reveal or pin the agent toolbar, then choose **Schedule**.
3. Enter the exact prompt and choose a local date and time. The **+1h**, **+5h**, and **+24h** shortcuts set common targets quickly.
4. Optionally choose a repeat interval, then choose **Add**.

The focused PTY is the creation target. The popover also lists schedules from other sessions, so unavailable or orphaned rows remain pausable and deletable. Explicitly closing a pane removes all schedules bound to that PTY. If an agent exits while its pane remains open, its existing rows remain manageable; creation stays disabled until wmux detects a live agent there again.

## Delivery contract

- A schedule is permanently bound to the PTY id and agent family detected at creation. wmux never silently retargets it to another pane.
- Delivery is daemon-only. Local fallback mode cannot prove child-process identity strongly enough for unattended terminal input, so it fails closed and leaves schedules queued.
- At delivery time, the daemon verifies canonical agent identity again. This prevents a prompt prepared for Codex, for example, from executing as a shell command after Codex exits.
- A verified `idle`, `waiting`, or `complete` agent is ready. Running turns, approval prompts, and PTYs with input in the previous three seconds stay due and retry later.
- Prompts use sanitized bracketed paste, followed by a separate submit write. During that delay the daemon re-verifies identity, post-paste state, and the input revision; its own paste echo cannot cancel a valid idle delivery, while concurrent human input cancels Enter and records an error instead of submitting mixed text. Multiline prompts use the same protected delivery path as other structured wmux messages.
- A successful one-shot is disabled. A repeating schedule advances to its next future occurrence rather than replaying every missed interval.
- Every occurrence is claimed durably before terminal input begins. A delivery error consumes the occurrence; a claim left unfinished by an app/daemon interruption is consumed after a one-minute safety timeout. This at-most-once policy can miss an occurrence if the process stops just before writing, but it never automatically duplicates unattended input.

Schedules are stored locally and survive wmux app restarts. The app must be running to deliver them; if it was closed at the due time, it catches up after reopening. The original daemon PTY must still exist and the same supported agent family must be detectable. A temporarily missing or changed session stays queued as **waiting for session** until it becomes valid again or you remove it from any session-schedule popover.

Session schedules are different from **Command Deck schedules**. Deck schedules begin a new orchestrator turn for a workspace. Session schedules write only to one existing agent conversation and therefore use stricter PTY and agent-identity checks.

Scheduled prompt text is persisted as local application data, not encrypted. Do not place credentials or other secrets in a schedule.
