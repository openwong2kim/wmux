### Added
- Chat view is off by default while experimental; enable it under Settings → Appearance ("Chat view for Claude Code sessions"). Off hides the Terminal / Chat switch and shows every pane as a terminal; the choice persists.
- Switch local session panes between Terminal and an assistant-ui based Chat view, preserving the running terminal and Minimal mode.
- Read Claude Code conversation history, tool results and expandable code; send messages to the verified session with approval and session-change guards, refusing while a Claude Code dialog (such as `/model`) owns the keyboard.
- Use the official assistant-ui Thread layout with a constrained conversation column, rounded composer, scroll-to-latest button and per-conversation drafts.
