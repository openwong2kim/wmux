# WSL directories and agent session recovery

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
outliving the ordinary 7-day suspended-session retention. Fix the distro/directory
and retry; closing the pane explicitly discards the pending recovery. A missing
exec-session directory also keeps the pane pending instead of running `--resume`
in another project.

When the directory itself is gone, the pane says so and offers **Start fresh in
home** beside Retry, because retrying reopens the same missing directory and
fails the same way for as long as it is missing. Starting fresh keeps the pane's
ID and its saved buffer and gives up exactly the two things that cannot be
honoured: it opens your home directory instead, and runs the pane's original
command instead of resuming the recorded conversation — that conversation
belonged to the directory that is gone. It is never automatic: landing in home
by itself would resume an unrelated project's conversation.

A pending pane is retained for 30 days, not forever. The 30 days start when the
pane becomes pending, and opening the pane again restarts them: opening the
workspace mounts the pane, which retries the connection, and each retry renews
the retention. So a pane you keep opening is kept. A pane whose surface or
workspace was removed without an explicit close is never opened again, so it is
discarded 30 days later, along with the per-boot background retry it was
costing. The retention is never shorter than `session.suspendedTtlHours`, and a
pane restored from an older wmux starts its 30 days at the first launch after
the upgrade. A pane reachable only through wmux web or a remote host has no
renewal path today, so it keeps the flat 30 days.

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

## Codex resume

Launch `codex` normally inside a new WSL pane. A pane-local launcher supplies
Codex's `notify` command for that invocation. After a completed interactive
turn, the notification carries its exact thread ID and Linux working directory
through WSL interop to wmux's existing authenticated Windows Codex bridge.
Resume can then type `codex resume <thread-id>`, including when several panes
share the same project. Press Enter to execute the typed recovery command.

Capture requires a completed turn; merely opening Codex does not emit this
notification. Existing panes without a binding still offer `codex resume --last`.
In a new pane, use `codex resume` to select the correct old conversation and
complete one turn to bind it. The integration matches the reported UUID to its
rollout filename under `CODEX_HOME/sessions/YYYY/MM/DD` and checks only the first
`session_meta` record for a top-level CLI session. It does not guess the newest
session in a shared directory. This rejects notifications from temporary title
generation and subagents, which must not replace the pane’s conversation binding.
It relies on Codex’s current rollout layout; missing or malformed metadata is
ignored rather than bound to an unverified session.

No Windows or Linux Codex settings are written. The launcher checks user,
profile, system and ancestor project configuration (including `CODEX_HOME` and
`--cd`) before injecting a per-launch override. If any of those layers or an
explicit `-c`/`--config` argument configures `notify`, it launches Codex unchanged
and reports that capture was not injected. This deliberately conservative check
also preserves notifiers in profiles or project layers that Codex might not
select or trust. Unreadable/malformed settings or an unavailable helper likewise
leave the original launch intact. Linux Node and Python are not required by the
integration: the small TOML guard and notification bridge use wmux's Windows
runtime. User hooks and their trust settings are not changed or bypassed.

## Requirements and scope

- WSL with Bash and Windows executable interop enabled. wmux starts Bash and
  loads `~/.bashrc`, then restores the requested directory even if that file
  contains `cd ~`. Custom login shells such as zsh and fish are not selected by
  this WSL integration.
- Exec units skip interactive startup files to keep output free of banners and
  prompt markers, so their commands see the non-interactive Linux PATH;
  interactive panes still source `~/.bashrc`. Set PATH explicitly for any other
  program an exec unit runs.
- Claude/Codex must be installed in the distribution. The integration uses
  pane-local PATH shims. When the non-interactive PATH does not contain
  `claude`, the Claude shim asks an interactive shell for its PATH once — so a
  `claude` installed by nvm, which lives only on the PATH `~/.bashrc` sets, is
  found in an exec unit as well. That lookup's own output is discarded and never
  reaches the pane. The Codex shim has no such fallback: in an exec unit, `codex`
  must be on the non-interactive PATH. An alias/function or absolute path that
  bypasses a shim, or a later explicit Claude `--settings` override, can bypass
  capture.
- `WMUX_SHELL_INTEGRATION=0` disables the shell markers and agent shims while
  retaining the directory and normal Bash startup setup.
- Directory restoration also applies to other programs in WSL. This integration
  does not provide Windows access to Linux transcript files for the chat view.

## Regression test

On Windows with WSL, Bash, Python 3 and the project's Node dependencies installed:

```powershell
npm run build:daemon
npm run build:cli
$env:WMUX_TEST_WSL = '1'
npx vitest run --config vitest.runtime.config.ts src/daemon/__tests__/wslRecovery.runtime.test.ts
```

The test starts a separate daemon with a unique data suffix for each agent. Fake
Claude and Codex CLIs run the real per-launch adapters and Windows bridges,
without model requests or changes to global agent settings. It checks two distinct IDs in one quoted,
Unicode Linux path, live detach/reattach, two daemon restarts, exact resume
commands, pinned distribution/user, Linux home expansion and missing-directory
failure. It also removes the project directory, verifies that failed retries and
another restart retain both pane IDs and scrollback, restores the directory,
and retries the same conversations. Set `WMUX_TEST_WSL_DISTRO` to exercise a specific installed distribution. Each test cleans up its own fixtures and daemon.

On Linux/WSL or macOS, the optional real Codex CLI check uses a private config
directory and a loopback model stub (no account or model requests). It verifies
that a completed interactive turn fires `notify`, then resumes that exact thread
and checks the next notification's ID. It has been exercised with Codex 0.154.0:

```bash
WMUX_TEST_CODEX_BINARY="$(command -v codex)" npx vitest run \
  --config vitest.runtime.config.ts src/shared/__tests__/wslCodexIntegration.runtime.test.ts
```

To exercise Electron's packaged runtime too, set
`WMUX_TEST_DAEMON_EXECUTABLE` to the built `wmux.exe` and `WMUX_TEST_DAEMON_BUNDLE` to its
`resources/daemon-bundle/index.js` before running the test.
