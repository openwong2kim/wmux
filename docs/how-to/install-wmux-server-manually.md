# How to install wmux-server on a Linux host by hand

> **Goal:** put the headless wmux runtime (daemon, CLI and `wmux web`) on a
> Linux machine yourself, for a host the desktop app cannot download to (no
> outbound internet, a proxy it does not know about) or when you want to see
> every step.

"Add PC over SSH" in the desktop app does all of this for you. The manual
install produces the same layout, so the app picks it up afterwards.

## Prerequisites

- **Linux on x64 or arm64 with glibc.** The artifact's minimum glibc is listed
  as `glibcMin` in the release's `server-manifest.json` (2.28 at the time of
  writing: Ubuntu 20.04, Debian 11, RHEL 8 or newer). musl distributions such
  as Alpine are not supported.
- **The wmux desktop app is not installed on that host.** The runtime and the
  desktop app share `~/.wmux` and would replace each other's daemon. On a
  machine that already runs the desktop app, use `wmux web` from that app
  instead.
- No root needed and no system Node: the artifact carries its own.

## Steps

1. **Pick the release and your architecture.** Always use a versioned tag,
   never `latest`. Replace `4.3.1` and `x64` (`arm64` on ARM) below.

   ```bash
   VER=4.3.1
   ARCH=x64
   NAME=wmux-server-$VER-linux-$ARCH.tar.gz
   BASE=https://github.com/openwong2kim/wmux/releases/download/v$VER
   ```

2. **Download and verify.** The `.sha256` file is published next to the
   tarball; the desktop app checks the same hash from the manifest it ships
   with.

   ```bash
   cd "$(mktemp -d)"
   curl -fLO "$BASE/$NAME" -O "$BASE/$NAME.sha256"
   sha256sum -c "$NAME.sha256"
   ```

   Copy both files over first if the host has no internet access.

3. **Install under `~/.wmux/runtime`.** The tarball holds one directory named
   after the version. Extract it next to its final place, then rename it in
   one step so a half-written install is never mistaken for a good one. If
   `~/.wmux/runtime/$VER` already exists, that version is installed: skip to
   step 4.

   ```bash
   RT=~/.wmux/runtime
   rm -rf "$RT/$VER.partial"
   mkdir -p "$RT/$VER.partial"
   tar -xzf "$NAME" -C "$RT/$VER.partial" --strip-components=1
   mv "$RT/$VER.partial" "$RT/$VER"
   ln -sfn "$VER" "$RT/current"
   ```

4. **Start the daemon and the web server.** Call the CLI by absolute path:
   non-interactive SSH sessions do not read your shell profile, so `PATH`
   cannot be relied on.

   ```bash
   W="$HOME/.wmux/runtime/current"
   "$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon start
   "$W/node/bin/node" "$W/resources/cli-bundle/index.js" web --allow-input
   ```

   `wmux web` listens on loopback only; the desktop app reaches it through an
   SSH tunnel. `--allow-input` lets paired devices type into the host's
   terminals, which means running arbitrary commands as your user there.
   Leave it off for a watch-only host.

5. **Check it.**

   ```bash
   "$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon status
   ```

   `spawnedByVersion` must show the version you installed.

Then add the PC from the desktop app. It finds the running server and keeps
its port and flags.

## Pair the host with a desktop for agent-to-agent work

The host can join a desktop's pairing invite from the command line, with no
desktop app on the host. The host only connects out to the desktop; nothing
on it starts listening.

1. On the desktop, open Settings → LAN and make an invite. Copy the
   `wmux-a2a://…` line.
2. On the host, join it. With `-` the invite is read from stdin, so it stays
   out of your shell history:

   ```bash
   "$W/node/bin/node" "$W/resources/cli-bundle/index.js" remote join -
   ```

   Paste the invite, then press Ctrl-D. The command prints the desktop's host
   id and certificate fingerprint.
3. List what the host is paired with, or end a pairing:

   ```bash
   "$W/node/bin/node" "$W/resources/cli-bundle/index.js" remote peers
   "$W/node/bin/node" "$W/resources/cli-bundle/index.js" remote unpair <host-id>
   ```

All three talk to the daemon, so it must be running (step 4). They exit with
code 1 on any failure, and `--json` prints the raw result. If `join` reports
no answer in time, run `remote peers` before trying again: the pairing may
have completed anyway.

## Let a desktop start agents on the host

Once paired, the desktop can ask the host to start an agent in a folder. The
host decides what it accepts. Without a desktop app on the host, write that
policy from its command line:

```bash
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" remote allow \
  --from <host-id> --root /home/worker/src/project --agent claude
```

- `--from` is the desktop's host id, as `remote peers` prints it. A name is
  accepted only when exactly one paired PC has it, and the command then
  prints that PC's host id and certificate fingerprint for you to check.
- `--root` must be the top level of a git repository. Each agent works in a
  fresh worktree of it.
- `--sub <path>` grants one folder below the root. A rule covers exactly the
  folder it names, not the folders below it.
- `--agent` is one of the agents wmux can start unattended (`claude`,
  `codex`, `grok`, …). The command warns when it cannot find it on the PATH.

Before it saves, the command states what the rule grants and asks you to
type `yes`. It needs a terminal, and it refuses to run from inside an agent
session or a wmux pane: a person runs it. What the rule grants:

- That PC can start the agent in that folder, with prompts it writes,
  without an approval on the host for each request.
- The agent runs as the account the wmux daemon runs as, with that
  account's access to the machine. Use a dedicated user account for a
  worker box, with access only to the repositories it should work on.
- Saving a rule turns remote spawn on and sets approval to the allow list.
  Both are policy-wide: rules saved earlier for other PCs take effect as
  well, and the command names them.

Follow-ups and the permission mode the agent runs in are policy-wide too, so
they apply to every allowed PC. The command changes them only when asked:
`--follow-ups ask|direct`, `--permission-mode <mode>`. Running with
`bypassPermissions` also needs `--bypass-permissions`.

To see or remove what is allowed:

```bash
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" remote allowed
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" remote revoke --from <host-id> --root /home/worker/src/project
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" remote revoke --from <host-id>
```

`revoke` with `--root` removes that PC's rules for the folder (add `--sub`
for one sub-folder); with `--from` alone, that PC may no longer ask the host
to start agents. `unpair` removes a PC's rules as well.

## Let the daemon start the agents itself (headless mode)

On a desktop, the desktop app starts an agent a paired PC asked for. A host
that runs only the daemon has no app to do it, so a request there waits. To
have the daemon start agents itself, turn on headless mode:

```bash
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon headless on
```

The command states what it turns on and asks you to type `yes`. Like
`remote allow`, it needs a terminal and refuses to run from inside an agent
session or a wmux pane. It is refused on an install where the desktop app has
been used: there the app starts the agents.

With headless mode on:

- The daemon keeps running while it waits for requests. Without headless
  mode it exits about six minutes after its last client and terminal are
  gone. It is not started again by itself after a reboot or a crash: on Linux,
  `daemon install-service` installs a systemd user unit that starts it at boot
  (it runs `daemon run`, the foreground entry, for the manager to watch);
  otherwise start it with `daemon start` as above. `headless on` and
  `headless status` say this too.
- While the daemon is down, a PC that asks for an agent here sees its request
  as sent and waiting. It is started once the daemon is back, unless the
  request expired first.
- A request an allow rule matches is started at once: the daemon makes a
  fresh worktree of the folder (branch `wmux/remote/sp-…`, named after the
  asking PC and its spawn id), starts the
  agent in it with the permission mode set by `remote allow`, and tells the
  asking PC which session it runs in.
- The asking PC's prompt is typed into the agent as soon as it is ready, and
  when the agent's turn ends, its last answer goes back to the asking PC as
  the reply (the task then waits for more input there). The answer is read
  from the agent's own conversation file, so no hooks are installed on the
  host. The task fails, with the reason shown on the asking PC, when the
  agent is given other input on the host during its turn, when its turn is
  interrupted or ends on an error, or when the agent ends before answering
  (its session ends, its link ends, headless mode is turned off, or the
  daemon restarts). A usage-limit pause is waited out. In this version only
  the first task is typed in; messages the asking PC sends afterwards are not
  yet, and an answer larger than 32 KiB fails the task.
- A request no rule matches is refused at once; nothing waits for an
  approval. The asking PC sees `not-allowed` when it may not ask this host,
  `agent-not-allowed` when it may but not for that agent, and
  `folder-not-allowed` when the folder is outside what it may use. A policy with the
  `manual` permission mode is refused too: nobody is at the host to answer
  the agent's questions.
- Only Claude Code is started this way. Its launcher (`claude`) must be on
  the login PATH of the account the daemon runs as, or in `~/.local/bin`,
  where its installer puts it. The agent must be signed in on that account.
- An agent ends when its link ends (the asking PC closes it, or `unpair`),
  and the link breaks when the agent's session ends. Restarting the daemon
  ends every agent it started: they do not come back. The restarted daemon
  ends them within moments of starting; `daemon headless status` then lists
  the worktrees they left, and the daemon log has one line per agent ended.
- When an agent ends, its worktree and branch are kept, with whatever the
  agent wrote there. Remove them yourself with `git worktree remove` and
  `git branch -D` once you no longer need them. A worktree the agent left
  unchanged (no commit, nothing modified or added) is removed with its
  branch.

See whether headless mode is in effect, which agents run (each with its spawn
id, the asking PC, since when and its worktree), and which worktrees ended
agents left, in all and per asking PC. A start whose agent left processes that
did not exit is listed apart, with its spawn id and their pids: its worktree
stays until they are gone, and the daemon checks again every minute. If the
daemon ever found its record of starts unreadable, it set that file aside and
started over: `status` then says so and lists the `remote-sp-*` worktrees no
record names, which you check and remove yourself. With the daemon running,
`status` asks it; otherwise it reads the daemon's data folder:

```bash
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon headless status
```

If such a start stays listed after you checked those processes are gone (or
stopped them yourself), drop its hold. Like `on`, this asks for a typed `yes`
and refuses to run from inside an agent session or a wmux pane:

```bash
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon headless release <spawn id>
```

Turn it off (no question asked). No new agent is started, and the ones
running end within a minute; their worktrees are kept:

```bash
"$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon headless off
```

If the desktop app is ever used on this install, headless mode turns off for
good, and the agents the daemon started end.

## Things to know

- **Do not restart `wmux web` with different flags** once devices are paired:
  changing how it is served revokes every paired device on the host.
- **Upgrading.** Install the new version the same way and repoint `current`.
  The running daemon keeps the old version until it restarts, and `daemon
  start` reuses a daemon that is already running. Restarting ends every
  process running in its terminals, so do it only when nothing you need is
  still running there:

  ```bash
  "$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon stop
  "$W/node/bin/node" "$W/resources/cli-bundle/index.js" daemon start
  "$W/node/bin/node" "$W/resources/cli-bundle/index.js" web --allow-input
  ```

  Start `wmux web` with the same flags it had before.
- **Terminal engine.** Terminals run on the Rust engine, which the server
  ships, by default. To run them on the Node engine, write
  `{"engine": "node"}` to `~/.wmux/terminal-core.json` (or start the daemon
  with `WMUX_TERMINAL_CORE=node` set), then restart the daemon as above. The
  daemon reads it once when it starts, and uses Node if the Rust engine cannot
  load.
- **Logging out may stop the daemon.** On systemd hosts with
  `KillUserProcesses=yes` in `logind.conf`, the daemon dies when your last SSH
  session ends, taking its terminals with it. Check with
  `busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses`
  (`b true` means it applies). Until wmux can run as a
  user service, keep one SSH session open on such hosts or ask the
  administrator to exempt your user (`KillExcludeUsers=`).
- **Multi-user hosts.** The server assumes no untrusted users share the host.
- A leftover `<version>.partial` directory is from an interrupted install;
  step 3 deletes it before installing again.
