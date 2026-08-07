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

Written as `"min-max"`, inclusive, within 1024–65535 and at most 512 ports wide
(the window is probed by binding, so a whole-ephemeral-space range would mean
tens of thousands of probes before the first task starts). Each spawned task is
assigned one free port from the window and gets it as **`WMUX_TASK_PORT`** in
its pane's environment, so eight parallel `npm run dev` runs don't fight:

```jsonc
// package.json
"scripts": { "dev": "vite --port ${WMUX_TASK_PORT:-3000}" }
```

Ports are probed for availability on both IPv4 and IPv6 loopback and assigned
before any task spawns, so no two tasks in one fan-out get the same number. A
port that has just been handed out stays claimed for 10 minutes, so a *second*
fan-out started while the first one's dev servers are still booting doesn't
reuse those numbers either. If the window runs out, the remaining tasks simply
start without `WMUX_TASK_PORT` — nothing fails, you just get the old behavior
for those tasks. The probe is advisory: nothing holds the port between the check
and your dev server's own bind.

A `portRange` the schema rejects (typo, privileged or inverted bounds, wider
than the cap) is dropped and reported — it never disables your `setup` hook, and
it is never confused with "no range declared".

## `fanout.setup`

A shell command run **inside each fresh worktree, before the agent starts**. Use
it for the per-worktree preparation you'd otherwise type into every agent's
first turn — copying secrets that aren't in git, installing dependencies,
generating a local config. It sees `WMUX_TASK_PORT` too, and its working
directory is the new worktree, so `../..` reaches out toward your main checkout.

If the hook fails (non-zero exit, or 5 minutes elapsed), that task is **not**
spawned: its mission is closed and the worktree is preserved for inspection,
because an agent that starts in a half-prepared tree just burns a turn
discovering it. Other tasks continue — a failure or timeout is scoped to the one
task it happened in. On timeout the hook's whole process tree is killed, not
just the shell, so a background `npm` can't outlive it and keep writing into the
preserved worktree.

The hook's output is not capped: a chatty install is truncated only in the
failure report, never killed mid-run.

> **Budget note.** Hooks currently run **serially**, one per task, each with its
> own 5-minute ceiling — so a fan-out of 8 tasks whose hooks all time out can
> spend ~40 minutes before the last task spawns. Keep the hook short (prefer a
> warm cache: `npm ci` against a shared store, not a cold full build). Running
> the hooks in parallel is a follow-up.

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
failing silently. A hook the schema rejected reports `malformed` — the two
fields validate independently, so neither typo can quietly disarm the other.

`portRange` is not trust-gated: the only thing the file can choose is a number,
and that number never reaches a shell — it stays inside `WMUX_TASK_PORT`.
