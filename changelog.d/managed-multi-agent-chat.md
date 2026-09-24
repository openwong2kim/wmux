### Added
- Experimental Chat view can show and continue the same terminal conversation for Codex and OpenCode, alongside Claude Code, with provider-specific session identity and input guards. OpenCode TUI integration installs through `wmux setup-hooks` on supported versions.
- Shared agent-neutral conversation/activity UI and optional private managed Codex, OpenCode and ACP adapters. ACP is supplementary; opening Chat does not create a separate agent session.
- Start Claude or Codex from Chat with a first message in the same terminal, guarded against existing shell drafts and running processes (zsh/bash/sh with shell integration).
