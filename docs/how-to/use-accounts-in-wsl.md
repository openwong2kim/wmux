# Use workspace accounts in WSL panes

A workspace bound to a Claude Code or Codex account runs that account in every
pane. On Windows the pane's agent uses the account's folder. A WSL pane cannot
use that folder: it holds Windows-only hooks, MCP servers and notify commands
that fail on every Linux start. So in WSL each bound account gets its own
folder inside the distro, and you sign in to it there once.

## What happens in a WSL pane

- **Bound workspace.** The pane's `claude` runs with `CLAUDE_CONFIG_DIR`, and
  its `codex` with `CODEX_HOME`, set to the account's own folder in the distro:
  `~/.wmux/accounts/<vendor>-<key>` (`~/.wmux<suffix>/…` for an instance started
  with a data suffix). wmux creates the folder on first use, readable only by
  you.
- **Unbound workspace.** Nothing changes: the pane uses the distro's own
  `~/.claude` and `~/.codex`.
- **Signing in.** Until the account has a sign-in in this distro, a new pane
  prints one line saying so. Sign in from a bound pane (`/login` in `claude`,
  or `codex login`). That signs in this account only; other workspaces and
  unbound panes keep their own sign-ins.
- **Signed out later.** If the agent in a bound WSL pane loses its sign-in,
  **Sign in again** on the notice opens the sign-in in a WSL tab of the same
  distro, for that account's WSL folder. A Windows pane of the same account
  has its own notice.
- **Continue on another account.** In a WSL pane, **Continue on <account>**
  stops Claude, copies the conversation into that account's folder in the
  same distro (created if needed, as your pane's user), and resumes it there
  in the same pane. If that account has no sign-in in this distro yet, Claude
  asks you to sign in. When that account (or your pane) signs in with a
  stored token, the conversation opens in a new WSL pane beside this one
  instead, in the same distro and as the same Linux user, and this pane is
  left as it was.
- **Stored token.** A pane on an account that signs in with a stored token
  gets the token in the distro too, and its WSL folder is marked as past
  Claude's first-run setup, so Claude uses the token instead of asking you to
  sign in. If that folder already has a `.claude.json` from an earlier Claude
  run, wmux leaves it alone, and Claude may ask once.
- **Shared settings.** If the account was created with sharing on, its new WSL
  folder links the distro's own skills, commands, agents and plugins (Codex:
  prompts) and copies its `settings.json` and `CLAUDE.md` (Codex: `config.toml`
  and `AGENTS.md`) once. Nothing is taken from the Windows folder.
- **Each distro separately.** Every distro has its own folder per account, so
  you sign in once per account in each distro you use.

## Things to know

- The folder is tied to the account's Windows folder. If you move or rename
  the account's Windows folder, the WSL pane gets a new, empty folder and you
  sign in again.
- Deleting an account in wmux leaves its WSL sign-in folder in each distro.
  Remove `~/.wmux/accounts/<vendor>-<key>` yourself if you no longer want it.
- Logging in from **Settings › Accounts** still signs in the account's Windows
  folder, which Windows panes use. It does not sign in a WSL folder.
- A `CLAUDE_CONFIG_DIR` or `CODEX_HOME` that you set in a workspace profile, or
  in your Windows environment, is not an account: WSL panes ignore it, as
  before.
- Codex in WSL needs the Linux `codex` installed in the distro. The Windows one
  on the `PATH` does not run there.
