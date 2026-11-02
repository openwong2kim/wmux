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
