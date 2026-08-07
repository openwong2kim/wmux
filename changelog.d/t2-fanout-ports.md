### Added

- **Fan-out tasks can each get their own port.** Declare `fanout.portRange`
  (e.g. `"3000-3010"`) in your repo's `wmux.json` and every task a fan-out
  spawns is assigned one free port from that window, exported to its pane as
  `WMUX_TASK_PORT`. Before this, eight tasks that all ran `npm run dev` fought
  over one port and seven of them died on startup. Ports are probed and assigned
  before any task spawns, so no two tasks in a fan-out collide — and a port just
  handed out stays claimed for ten minutes, so a second fan-out started while
  the first one's servers are still booting doesn't reuse it either. Windows are
  capped at 512 ports; if one runs out, the remaining tasks simply start without
  the variable.

- **Worktree setup hook for fan-out.** `fanout.setup` in `wmux.json` is a shell
  command run inside each freshly created worktree *before* its agent starts —
  the `cp ../../.env .` and `npm ci` you used to type into every agent's first
  turn. It is trust-gated exactly like supervised panes: the command is shown
  verbatim in the trust dialog and runs only against `wmux.json` bytes you have
  explicitly approved, so a hook arriving via a pull request is inert until you
  review it. An edit demotes the file to stale and the hook stops running. When
  a declared hook is skipped for lack of trust the fan-out says so instead of
  quietly doing nothing, and a hook that fails leaves its task unspawned with
  the worktree preserved rather than starting an agent in a half-prepared tree —
  only that task; the rest of the fan-out continues. Output is never capped (a
  chatty `npm ci` won't be killed), and a hook that hits its five-minute ceiling
  has its whole process tree killed, so a background install can't outlive it
  and keep writing into the preserved worktree.
  See `docs/how-to/fan-out-task-environment.md`.
