### Added
- Experimental Chat view can show and continue the same terminal conversation for Codex and OpenCode, alongside Claude Code, with provider-specific session identity and input guards. OpenCode TUI integration installs through `wmux setup-hooks` on supported versions.
- Shared agent-neutral conversation/activity UI and optional private managed Codex, OpenCode and ACP adapters. ACP is supplementary; opening Chat does not create a separate agent session.
- Start Claude or Codex from Chat with a first message in the same terminal, guarded against existing shell drafts and running processes (zsh/bash/sh with shell integration).
- Use one bottom composer for initial and follow-up messages, with explicit Claude Bypass and Codex YOLO startup mode selection.

- Add bottom-composer skill search for native Claude/Codex with keyboard navigation, agent-correct invocation, source labels, draft-preserving selection and honest discovery states. Keep idle connection text and session placeholders agent-neutral.

- Include native command destinations in the slash menu, add live Codex model/effort controls, and handle app/daemon version skew without restarting existing terminal sessions.

- Reduce Chat re-entry waits by overlapping history reads and subscription setup, preloading the view, and reusing bounded history only after fresh conversation and file identity checks.

- Preserve native Korean/IME composition in the Chat composer with synchronous input state, and prevent composition-confirming Enter from submitting a message.

- Right-align content-sized user bubbles inside transcript wrappers; keep agent replies left-aligned.

- Include the external WebSocket runtime in packaged apps so native chat support does not prevent startup.
