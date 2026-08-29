# Schedule a prompt for one agent session

Session prompt schedules let wmux deliver a prepared prompt to a specific AI-agent pane at a future local time. This is useful for quota reset windows, delayed follow-ups, and recurring checks that should continue in an existing conversation.

## Create a schedule

1. Focus a terminal pane where wmux has detected an AI agent.
2. Reveal or pin the agent toolbar, then choose **Schedule**.
3. Enter the exact prompt and choose a local date and time. The **+1h**, **+5h**, and **+24h** shortcuts set common targets quickly.
4. Optionally choose a repeat interval, then choose **Add**.

The popover lists schedules for only the focused PTY. A row can be paused, resumed, or deleted. Existing rows remain manageable if the agent later exits; creation stays disabled until wmux detects an agent in that pane again.

## Delivery contract

- A schedule is permanently bound to the PTY id and agent family detected at creation. wmux never silently retargets it to another pane.
- At delivery time, wmux verifies the agent identity again. This prevents a prompt prepared for Codex, for example, from executing as a shell command after Codex exits.
- If the agent is running a turn or showing an approval prompt, the schedule remains due and retries when the agent is ready for normal input.
- Prompts use sanitized bracketed paste, followed by a separate submit write. Multiline prompts use the same protected delivery path as other structured wmux messages.
- A successful one-shot is disabled. A repeating schedule advances to its next future occurrence rather than replaying every missed interval.
- If the paste succeeds but the submit write fails, wmux records a delivery error and consumes that occurrence. Automatic retry could otherwise duplicate part of the prompt.

Schedules are stored locally and survive wmux app restarts. The app must be running to deliver them; if it was closed at the due time, it catches up after reopening. The original PTY must still exist and the same supported agent family must be detectable. A missing or changed session stays queued as **waiting for session** until it becomes valid again or you remove it.

Session schedules are different from **Command Deck schedules**. Deck schedules begin a new orchestrator turn for a workspace. Session schedules write only to one existing agent conversation and therefore use stricter PTY and agent-identity checks.

Scheduled prompt text is persisted as local application data, not encrypted. Do not place credentials or other secrets in a schedule.
