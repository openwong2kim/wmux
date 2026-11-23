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

An agent another PC starts on a headless host (`wmux daemon headless on`) gets
`WMUX_TASK_PORT` the same way: the range is read from the `wmux.json` in its new
worktree, and the port is recorded with the start, so no other agent running on
that host gets it, nor one started after a daemon restart while it is held.

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

## `fanout.copy`

A list of git-ignored files (project-relative, e.g. `[".env", ".env.local"]`)
copied from your checkout into each new worktree before `setup` runs, so the
setup command and the agent find them. The **New workspace setup** dialog (command palette,
or Edit setup in the wmux.json dialog) lists the candidates, with the `.env`
family ticked, suggests a setup command from your lockfile, and writes these
settings for you.

- Only plain files that are git-ignored in your checkout are copied (a link is
  followed only to a file inside the checkout). A file that the new worktree
  would not ignore is removed again, so a copy can never be committed by
  accident, and `git worktree remove` deletes the copies with the folder.
- An existing file in the worktree is never overwritten.
- Copies stay on this computer: a phone request copies on the desktop, and only
  counts reach the phone.
- By default files are copied only into worktrees a person opened (the Git
  page, start from an issue, Quick Launch, a phone request). Fan-out and bot
  worktrees get them only with **`"copyIntoAutomated": true`** (the dialog's
  "Also copy into bot and fan-out workspaces", under Advanced): an agent there
  can read them, and one misled by a prompt could send them elsewhere.
- A selected file that is not found, or refused, is reported with the result.

`copy` and `setup` run on every path that creates a worktree, not only fan-out.

### Trust gating

`wmux.json` is checked into the repo, so a pull request can edit it. The setup
hook is a shell command and is therefore gated exactly like supervised panes:

- It runs **only** when you have explicitly trusted the file's current bytes.
- Any edit to `wmux.json` demotes it to *stale* and the hook stops running until
  you review and approve again.
- The hook command and the `copy` list are shown verbatim in the trust dialog
  before you approve. Saving from the New workspace setup dialog approves exactly
  the bytes it writes, and only when the file holds no commands or layout you
  have not approved yet (those are reviewed in the trust dialog first).

When a hook is declared but the config isn't trusted, the fan-out still runs and
reports why the hook was skipped (`untrusted`, `stale`, `denied`) instead of
failing silently. A hook the schema rejected reports `malformed` — the two
fields validate independently, so neither typo can quietly disarm the other.

`portRange` is not trust-gated: the only thing the file can choose is a number,
and that number never reaches a shell — it stays inside `WMUX_TASK_PORT`.
