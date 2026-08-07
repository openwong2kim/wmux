# Give fan-out tasks a port and a prepared worktree

A fan-out turns one prompt into up to 8 tasks, each in its own git worktree. Two
things break at that scale: every task's dev server wants the same port, and
every task starts in a worktree with no `node_modules` and no `.env`.

Both are declared once, in your repo's `wmux.json`:

```json
{
  "version": 1,
  "fanout": {
    "portRange": "3000-3010",
    "setup": "cp ../../.env . && npm ci"
  }
}
```

## `fanout.portRange`

Written as `"min-max"`, inclusive, within 1024–65535. Each spawned task is
assigned one free port from the window and gets it as **`WMUX_TASK_PORT`** in
its pane's environment, so eight parallel `npm run dev` runs don't fight:

```jsonc
// package.json
"scripts": { "dev": "vite --port ${WMUX_TASK_PORT:-3000}" }
```

Ports are probed for availability and assigned before any task spawns, so no two
tasks in one fan-out get the same number. If the window runs out, the remaining
tasks simply start without `WMUX_TASK_PORT` — nothing fails, you just get the
old behavior for those tasks. The probe is advisory: nothing holds the port
between the check and your dev server's own bind.

## `fanout.setup`

A shell command run **inside each fresh worktree, before the agent starts**. Use
it for the per-worktree preparation you'd otherwise type into every agent's
first turn — copying secrets that aren't in git, installing dependencies,
generating a local config. It sees `WMUX_TASK_PORT` too, and its working
directory is the new worktree, so `../..` reaches out toward your main checkout.

If the hook fails (non-zero exit, or 5 minutes elapsed), that task is **not**
spawned: its mission is closed and the worktree is preserved for inspection,
because an agent that starts in a half-prepared tree just burns a turn
discovering it. Other tasks continue.

### Trust gating

`wmux.json` is checked into the repo, so a pull request can edit it. The setup
hook is a shell command and is therefore gated exactly like supervised panes:

- It runs **only** when you have explicitly trusted the file's current bytes.
- Any edit to `wmux.json` demotes it to *stale* and the hook stops running until
  you review and approve again.
- The hook command is shown verbatim in the trust dialog's command list before
  you approve.

When a hook is declared but the config isn't trusted, the fan-out still runs and
reports why the hook was skipped (`untrusted`, `stale`, `denied`) instead of
failing silently.

`portRange` is not trust-gated: the only thing the file can choose is a number,
and that number never reaches a shell — it stays inside `WMUX_TASK_PORT`.
