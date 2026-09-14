# WSL directories and Claude session recovery

On Windows, choose `C:\Windows\System32\wsl.exe` as the terminal shell. Select
the WSL distribution in Settings, then set an absolute Linux startup directory, such as `/home/user/project`. `~` and
`~/project` resolve inside WSL. An existing Windows directory is translated with
`wslpath`. UNC paths and paths containing double quotes are not supported;
wmux rejects them before spawning WSL rather than risk splitting ConPTY argv.

wmux validates the directory inside the distribution resolved by the distro picker and records the actual distribution
and Linux user with the pane. Saved distro arguments and the captured target come
from that same resolution. Changing the default affects new panes; existing panes
keep their captured target. A stale picker choice retains the picker’s fallback
to the system default, while an unavailable saved recovery target fails visibly. After a daemon restart, it restores that target and
the last reported Linux directory. A missing directory or unavailable target
produces an error rather than silently opening a different project. The Windows
PTY host directory is separate from the Linux working directory.

The daemon publishes WSL panes as pending, then starts recovery concurrently
without waiting for cold distributions during startup. Panes beyond the startup
recovery cap retry when they reconnect. Exec units can recover in the background
without a GUI. Probes run asynchronously with a 60-second
budget; simultaneous requests for the same target and directory share the pending
probe. Completed results are not cached, so a deleted directory or changed Linux
user is detected on the next attempt.

If recovery fails, the pane shows the error and **Retry connection**. The original
pane ID, conversation binding and buffer remain saved across further restarts,
without expiring while recovery is pending. Fix the distro/directory and retry;
closing the pane explicitly discards the pending recovery. A missing exec-session
directory also keeps the pane pending instead of running `--resume` in another
project.

## Claude resume

Launch `claude` normally inside the pane. wmux adds per-launch Claude settings
with SessionStart, Stop and StopFailure hooks. Those hooks pass the pane identity
through WSL interop to wmux's existing authenticated Windows hook bridge. The
captured conversation ID and Linux directory let Resume choose
`claude --resume <session-id>`, including when several panes share one project.
Closing the window and reattaching to a live daemon keeps the original process;
a full daemon shutdown restores the shell and offers conversation recovery.

Neither the Windows nor Linux `~/.claude/settings.json` is modified by this
integration. Claude merges the additional settings with its normal settings.
See [Claude settings](https://code.claude.com/docs/en/settings) and the
[CLI reference](https://code.claude.com/docs/en/cli-reference).

### Existing panes

Panes created before this integration may have no saved conversation ID. wmux
cannot safely infer which conversation belongs to each pane. Open a fresh WSL
pane in the project directory and run `claude --resume` to select the old
conversation once. Its SessionStart hook then records the exact ID for future
recovery. A pane already running under the old daemon must be recreated under
the updated daemon to receive the integration.

## Requirements and scope

- WSL with Bash and Windows executable interop enabled. wmux starts Bash and
  loads `~/.bashrc`, then restores the requested directory even if that file
  contains `cd ~`. Custom login shells such as zsh and fish are not selected by
  this WSL integration.
- Exec units skip interactive startup files to keep output free of banners and
  prompt markers. Their commands must use the non-interactive Linux PATH (or set
  PATH explicitly); interactive panes still source `~/.bashrc`.
- Claude must be installed on the Linux PATH. The integration uses a pane-local
  PATH shim. An alias/function or absolute path that bypasses that shim, or a
  later explicit `--settings` override, can bypass these hooks.
- `WMUX_SHELL_INTEGRATION=0` disables the shell markers and Claude shim while
  retaining the directory and normal Bash startup setup.
- Directory restoration also applies to other programs in WSL. This change does
  not implement new Codex hooks or Windows access to Linux transcript files for
  the chat view.

## Regression test

On Windows with WSL, Bash, Python 3 and the project's Node dependencies installed:

```powershell
npm run build:daemon
npm run build:cli
$env:WMUX_TEST_WSL = '1'
npx vitest run --config vitest.runtime.config.ts src/daemon/__tests__/wslRecovery.runtime.test.ts
```

The test starts a separate daemon with a unique data suffix. A fake Claude CLI
runs the real per-launch hook and Windows bridge, without model requests or
changes to global Claude settings. It checks two distinct IDs in one quoted,
Unicode Linux path, live detach/reattach, two daemon restarts, exact resume
commands, pinned distribution/user, Linux home expansion and missing-directory
failure. It also removes the project directory, verifies that failed retries and
another restart retain both pane IDs and scrollback, restores the directory,
and retries the same conversations. Set `WMUX_TEST_WSL_DISTRO` to exercise a specific installed distribution. Each test cleans up its own fixtures and daemon.

To exercise Electron's packaged runtime too, set
`WMUX_TEST_DAEMON_EXECUTABLE` to the built `wmux.exe` and `WMUX_TEST_DAEMON_BUNDLE` to its
`resources/daemon-bundle/index.js` before running the test.
