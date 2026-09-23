### Changed

- **Every finished turn now reports its closing message, not just a closing question.** Main used to forward the agent's last message to the renderer only when it ended on a question. Each turn end now also sends the message tail per pane, cut to the same 140-character budget the phone list uses, so Fleet rows can show what an idle pane last said. Claude Code only for now; other agents, failed turns and new sessions clear it.
