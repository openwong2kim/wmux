# jcode

[jcode](https://github.com/1jehuang/jcode) reports its status to wmux through
its observer hooks ([docs/HOOKS.md](https://github.com/1jehuang/jcode/blob/master/docs/HOOKS.md)).
`bin/wmux-jcode-bridge.mjs` turns jcode's `JCODE_HOOK_*` environment into the
shared hook bridge's payload (flavour `jcode`):

| jcode event | wmux signal |
| --- | --- |
| `session_start` | `agent.session_start` (`create` → startup, `resume` → resume; `attach` sends nothing) |
| `turn_start` | `agent.user_prompt_submit` |
| `turn_end` | `agent.stop` |
| `session_end` | `agent.session_end` |

Only the event name, session id, cwd and start source are read. The reply
text, tool input and `JCODE_HOOK_PAYLOAD` are never read or forwarded. jcode
has no approval event yet, so "waiting on you" still comes from the screen.

Install it with:

```sh
wmux setup-hooks --agent jcode           # add wmux's command to each event
wmux setup-hooks --agent jcode --status  # current / stale / absent
wmux setup-hooks --agent jcode --remove  # take only wmux's commands out
```

It edits `[hooks]` in `~/.jcode/config.toml` (`$JCODE_HOME/config.toml` when
set) one line at a time, next to any hooks you already have, and keeps your
comments. Where it cannot do that (a multi-line array, an inline `hooks`
table), it writes nothing and prints the lines to set, for example:

```toml
[hooks]
turn_end = ["~/bin/your-hook", "node \"/home/you/.wmux/hooks/wmux-jcode-bridge.mjs\""]
```

jcode parses the line shell-style, so write Windows paths with forward slashes.
Resume offers jcode's own picker (`jcode --resume`).

The row is built from jcode's docs and has not been measured against a live
jcode yet.
