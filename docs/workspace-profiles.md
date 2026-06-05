# Workspace Profiles

Workspace profiles let each workspace define **environment variables** and an
optional **startup command** that apply to **new panes only**. They are the
building block for running different tool accounts side by side — e.g. two
Claude Code accounts and two Codex accounts at the same time, one per
workspace.

> **What this is:** process-environment separation for the shells wmux spawns.
> **What this is not:** an OS-level security sandbox. Whether "account
> isolation" actually holds depends on the CLI you run (see
> [Per-tool recipes](#per-tool-recipes)). wmux only controls the environment of
> the child shell; it never reads or manages your credential files.

---

## Mental model

When you open a **new** pane in a workspace, wmux builds its environment like
this:

```
safe inherited env  →  + your profile env  →  + forced WMUX_* identity  →  (+ shell-integration vars)
```

The first three steps are resolved together in the main process
(`resolveSpawnEnv`); shell-integration vars (OSC 133 hooks) are layered last by
whichever spawner runs — the local PTY manager or the daemon. Only local-mode
spawns also force `WMUX_SOCKET_PATH`; daemon-mode panes reach the daemon by its
pipe-name file, so they force only `WMUX_WORKSPACE_ID` / `WMUX_SURFACE_ID`.

Consequences worth internalizing:

- **New panes only.** Changing a profile never touches panes that are already
  open. Open a fresh pane to pick up the change.
- **Restart-safe.** When the daemon persists a session it stores the *merged*
  environment, so after "Quit (keep sessions running)" → relaunch, each
  recovered pane keeps the exact environment it was created with. The profile
  is **not** re-applied on recovery (so a startup command does **not** re-run on
  restart).
- **No cross-workspace leakage.** A pane only ever sees its own workspace's
  profile.
- **Identity is protected.** The wmux identity vars are forced last, so a
  profile cannot override them, and any `WMUX_*` key you type is rejected.
  (`WMUX_WORKSPACE_ID` / `WMUX_SURFACE_ID` in both modes; `WMUX_SOCKET_PATH`
  in local mode only — see the mental-model note above.)
- **Profile env overwrites, it does not append.** If you set `PATH` in a
  profile it *replaces* the inherited `PATH` — almost never what you want. Set
  tool-specific vars (config-dir pointers), not `PATH`.

---

## Configuring a profile (UI)

1. **Right-click** a workspace in the sidebar → **"Configure profile…"**.
2. Add environment variables as `NAME = value` rows. Invalid or reserved
   (`WMUX_*`) names are flagged in red and dropped on save. Secret-looking
   names (`*_KEY`, `*_TOKEN`, `*_SECRET`, …) are **also dropped by policy** —
   profiles are stored in plaintext, so wmux won't persist a raw credential;
   point at a config directory instead (see below).
3. Optionally set a **startup command** — written into each new pane's shell
   after it starts (it is *not* spawned as the executable, so your shell,
   quoting, and shell integration all behave normally).
4. **Save.** A small ⚙ badge marks workspaces that have a profile.

Limits (enforced on save): ≤64 env entries, key ≤128 chars, value ≤8192 chars,
startup command ≤4096 chars.

### Where values are stored

Profile values live in plaintext in your local wmux session file
(`session.json` under Electron's `userData`). They are **never** logged, and
**never** included in "Copy session info" / drag-export markdown.

**Paths, not secrets — enforced.** A profile points at a *config directory*
(e.g. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) that holds the real credentials; it
does not hold the credentials themselves. Secret-named keys (`*_KEY`, `*_TOKEN`,
…) are dropped on save rather than written to `session.json` in plaintext. (If
first-class encrypted secret storage is added later it will go through the OS
keystore via Electron `safeStorage`, not the plaintext session file.)

---

## The credentials folder (you own it)

wmux does not create, read, scan, or manage any credential files. You decide
where each account's config lives. A common layout — **folder names and
locations are entirely up to you**:

```
<your-credentials-root>\
  claude-accounts\
    a\            ← CLAUDE_CONFIG_DIR for Claude account A
    b\            ← CLAUDE_CONFIG_DIR for Claude account B
  codex-accounts\
    1\            ← CODEX_HOME for Codex account 1
    2\            ← CODEX_HOME for Codex account 2
```

You create these folders yourself; wmux only stores the *path string* you type
into the profile and hands it to the new pane's shell as an environment
variable. Keep this folder **outside** any git repo and never commit the paths
or account mappings.

---

## Per-tool recipes

### Claude Code — multiple accounts

Claude Code reads `CLAUDE_CONFIG_DIR` to decide where its config (including the
logged-in session) lives. Point each workspace at a different directory.

| Workspace | Env | Startup command (optional) |
|-----------|-----|----------------------------|
| Claude A  | `CLAUDE_CONFIG_DIR` = `<root>\claude-accounts\a` | `claude` |
| Claude B  | `CLAUDE_CONFIG_DIR` = `<root>\claude-accounts\b` | `claude` |

**First-time login (once per account):**

1. Open a new pane in *Claude A*. Confirm the env is set:
   `echo $env:CLAUDE_CONFIG_DIR` → should print the A path.
2. Run `claude`, then `/login`, and complete auth. Credentials are written into
   the A directory.
3. Repeat in a *Claude B* pane against the B directory.

After that, every new pane in A is account A and every new pane in B is account
B — concurrently. Logins persist on disk and survive wmux restarts.

> ⚠️ `CLAUDE_CONFIG_DIR` is **not** part of Claude Code's official documented
> settings; it is a widely-used, community-supported mechanism. It works in
> practice (verify with the `echo` check + a `/login` per directory), but
> behavior could change between Claude Code releases. There is also a known
> upstream quirk where local-installation *detection* can ignore
> `CLAUDE_CONFIG_DIR`; it does not affect account isolation.

### Codex — multiple accounts (read the caveat)

Codex reads `CODEX_HOME` to relocate its config directory (default `~/.codex`,
which holds `auth.json`). **But by default Codex stores credentials with the
`auto` mode, which uses the OS credential store (Windows Credential Manager) —
a single shared store.** With `auto`, two `CODEX_HOME` folders will *not*
isolate two logins: the second login shares/overwrites the first in the OS
keyring.

**To make `CODEX_HOME` actually isolate accounts, force file-based credential
storage in each Codex home.** Put this in `<CODEX_HOME>\config.toml`:

```toml
# <root>\codex-accounts\1\config.toml   (and likewise for ...\2\)
cli_auth_credentials_store = "file"
```

That keeps each account's tokens in its own `<CODEX_HOME>\auth.json`.

| Workspace | Env | config.toml | Startup command (optional) |
|-----------|-----|-------------|----------------------------|
| Codex 1   | `CODEX_HOME` = `<root>\codex-accounts\1` | `cli_auth_credentials_store = "file"` | `codex` |
| Codex 2   | `CODEX_HOME` = `<root>\codex-accounts\2` | `cli_auth_credentials_store = "file"` | `codex` |

**First-time login (once per account):**

1. Create the folder and its `config.toml` with the `file` store line.
2. Open a new pane in *Codex 1*. Confirm: `echo $env:CODEX_HOME`.
3. Run `codex login` and complete auth → `auth.json` lands in the 1 directory.
4. Repeat for *Codex 2*.

> Alternative to per-home config: set `cli_auth_credentials_store = "file"`
> once in your global `~/.codex/config.toml`. But the per-home file is the most
> explicit and self-contained.

### Other tools (SSH, cloud CLIs, anything env-driven)

The same pattern works for any CLI whose account/config is selectable via an
environment variable or config-dir pointer — e.g. `GIT_SSH_COMMAND` for an SSH
key wrapper, `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`,
`KUBECONFIG`, `GOOGLE_APPLICATION_CREDENTIALS`, etc. These name a *path* (a
reference, not the secret itself), so they're allowed even though some match
the secret-name policy — `GOOGLE_APPLICATION_CREDENTIALS` and
`AWS_SHARED_CREDENTIALS_FILE` are on the path-pointer allowlist. If the tool
keys off the OS keyring or a hardcoded path, profile env alone won't isolate it
(same class of caveat as Codex's `auto` mode).

---

## Can I run 2 Claude + 2 Codex accounts at once? — Yes

Create four workspaces, one profile each:

- **Claude A / Claude B** → different `CLAUDE_CONFIG_DIR`, log in once each.
- **Codex 1 / Codex 2** → different `CODEX_HOME` **and**
  `cli_auth_credentials_store = "file"` in each, log in once each.

All four can run simultaneously in their own panes. Each new pane gets its
workspace's environment at spawn time, so the four CLIs read four independent
accounts. Open multiple panes within a workspace and they all share that
workspace's account (each pane is a separate CLI process, same account).

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| New pane doesn't have my var | You edited the profile but reused an **existing** pane. Open a fresh pane. |
| `echo $env:VAR` is empty | Save didn't take, or the key was invalid/reserved (look for the red flag in the modal). |
| Both Codex workspaces show the same account | Default `auto` store is using the shared OS keyring. Add `cli_auth_credentials_store = "file"` to each `CODEX_HOME\config.toml`, then `codex login` again. |
| Startup command didn't run after restart | By design — recovery restores the environment but does **not** re-run the startup command. |
| Shell can't find executables after setting a profile | You probably set `PATH` in the profile, which *replaces* it. Remove it; use tool-specific vars instead. |
| Startup command ran before the shell was ready | The command is written ~200 ms after spawn (best-effort). For a very slow profile, run it manually or rely on the env alone. |

---

## Security notes

- Environment separation is **not** a confidentiality boundary against other
  processes running as the same OS user. For hard isolation use separate OS
  users, containers, or VMs.
- Profile values are stored in plaintext locally and are excluded from logs and
  session-info exports — but anyone with read access to your `session.json`
  can see them. Prefer config-dir paths over embedded secrets.
- wmux never reads your credential directories; it only passes the env values
  you configure to newly spawned shells.
