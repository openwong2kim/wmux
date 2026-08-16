### Added

- **Grok is a first-class agent.** The detector recognizes the Grok TUI (startup banner, Help improve Grok, live composer `Grok 4.6 (high) · always-approve`) and the roster / pane names show Grok instead of a generic terminal.

### Changed

- **Agent verbs left the bottom toolbar.** Compose (`⌘G`), attach, and new conversation live on the focused pane's tab cluster. Broadcast is a compose target (`This pane` / `All N terminals`, with a 4-second arm on All N). Multi Task sits on the selected workspace card (`Start agents` when the fleet is empty; the Agent deck header only when the sidebar is collapsed). The 36px workspace-spanning strip is gone.

### Fixed

- **Grok panes no longer show up as Claude Code.** A Grok TUI that reads this repo (or any file quoting Claude's banner/footer) used to trip Claude's compound gate. Identity now requires per-line TUI chrome, and another agent's status patterns cannot steal the pane back.
- **Grok's transcript scrolls with the wheel.** Grok runs in the alt screen, so xterm had no scrollback. The wheel now sends PageUp/PageDown, which is how Grok itself scrolls.
