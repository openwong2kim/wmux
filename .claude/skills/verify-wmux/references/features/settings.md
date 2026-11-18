# Settings

Settings is a full rail page (not a modal) with a searchable nav of 16 tabs grouped as general, Agents and Connections. UI preferences (theme, language, font size, scrollback, sidebar options) apply immediately and are saved to the profile's `session.json`.

## Sub-features

- `settings-open` / `settings-close`: open from the More menu or ⌘,; close with "Close" or Escape (⌘, toggles).
- `settings-nav`: tabs General, Appearance, Terminal, Keyboard, Notifications, Claude Code, Accounts, Bots, Roles & fan-out, Token usage, Browser, Computer use, Plugins, Remote & phone, LAN, About.
- `settings-plugins`: Installed/Discover lists, explicit UI plugin approval, enable/disable, managed uninstall, and embedded connectors.
- `settings-search`: "Search settings" with grouped results and an empty state.
- `settings-theme`: Appearance › Theme radio cards (Tint, Paper, Mono, …).
- `settings-language`: General › Language select (`en`, `ko`, `ja`, …).
- `settings-persist`: values survive in `<userData>/session.json`, where `<userData>` is the `userData` field `control-wmux doctor` (or `launch`) prints.
- `settings-terminal-engine`: Node/Rust selection, running-host read-back and restart guidance; requires a native-enabled build for Rust.

## How to get to it (user POV)

- Rail "More" button › "Settings ⌘," ("Settings Ctrl+," on Windows/Linux).
- Shortcut ⌘, (Ctrl+,), which toggles.
- Other features link into tabs (the room dock's factory-off view opens the Factory tab).

## Driving it with control-wmux

Preconditions:

- Baseline state (wizard dismissed, Settings closed).

- **Open via menu.** Run `control-wmux click --label More`, then `control-wmux click --role menuitem --name "Settings ⌘,"`, then `control-wmux wait-settle --testid settings-page-title`. `control-wmux snapshot --as settings` shows `heading "Settings"`, `navigation "Settings"` and `heading "General"`.
- **Read a value.** Run `control-wmux inspect --js "({ page: document.querySelector('[data-testid=settings-page-title]')?.textContent, language: document.querySelector('select[aria-label=Language]')?.value, autoUpdate: document.querySelector('[role=switch][aria-label=Auto-update]')?.getAttribute('aria-checked') })"`. Returns `{page: "General", language: "en", autoUpdate: "true"}` on a fresh profile.
- **Close / reopen by keyboard.** `control-wmux press --key Escape`, then `control-wmux wait-settle --testid settings-page-title --state hidden`; `control-wmux press --key Meta+Comma` reopens it.
- **Switch tab.** Run `control-wmux click --selector '[data-settings-tab="appearance"]'`. The tab gets `aria-current="page"` and the title reads "Appearance".
- **Change theme.** Run `control-wmux click --role radio --name Paper`. `control-wmux inspect --js "document.documentElement.dataset.theme"` returns `"paper"` immediately.
- **Persistence (second view).** The UI autosaves every 5 s, so poll the profile file with a bound instead of sleeping. The file is `<userData>/session.json`, with `<userData>` taken from `doctor`'s output, never a hard-coded path: the app logs where its userData really is, and a guessed path can hold a stale file from an earlier run. This prints `paper` (anything else after 15 s, or a `userDataSource` other than `logged`, is NOT VERIFIED):

  ```sh
  python3 - <<'PY'
  import json, os, subprocess, sys, time
  d = json.loads(subprocess.run(["node", "scripts/control-wmux.mjs", "doctor"], capture_output=True, text=True).stdout)
  if d.get("userDataSource") != "logged":
      sys.exit(f"userData not logged by the app: {d.get('userData')} ({d.get('userDataSource')})")
  f = os.path.join(d["userData"], "session.json")
  end, theme = time.time() + 15, None
  while time.time() < end:
      if os.path.exists(f):
          theme = json.load(open(f)).get("theme")
          if theme == "paper":
              break
      time.sleep(0.5)
  print(theme)
  PY
  ```

  Restore with `control-wmux click --role radio --name Tint`.
- **Search.** Run `control-wmux click --testid settings-search`, `control-wmux type --text theme --testid settings-search`. `control-wmux wait-settle --testid settings-search-results` passes. `type` appends, so clear first (`control-wmux press --key Meta+a --testid settings-search`, `press --key Backspace`); a nonsense query such as `zzzqqq` shows `settings-search-empty` ("No settings match “zzzqqq”.").
- **Proof.** `control-wmux screenshot --as settings-general` shows the Settings page with the General tab.
- **Terminal engine.** A read-only status row (the Rust core is the only engine; there is no picker). Open Terminal and hover the row before a screenshot to bring it into view. It shows a **Rust** badge; read `window.electronAPI.settings.getTerminalCore()`: `host: daemon`, `runtime.effective` `rust`, `runtime.available` true. With the packaged module renamed away (a test build only) and the daemon restarted (`control-wmux stop`, then `launch` with the same suffix: a running daemon keeps the module it loaded), the row says the module is missing and shows the reason, `available` is false, and a new pane shows the typed error instead of a shell.

## Plugins lifecycle in an isolated profile

Open `[data-settings-tab="plugins"]`, select the Discover radio, and install
Agent status. Installed must show Not approved without a rail contribution.
Click Review permissions to open, inspect the permission dialog, then Approve.
Open must display the Agent status page. Return to Settings › Plugins and
Disable: the rail contribution disappears. Restart with the driver and run
doctor, then reopen Plugins: Disabled must persist. Independently read
`~/.wmux<suffix>/ui-plugins.json`.

Enable must preserve the explicit approval. Uninstall requires a second click
after its confirmation appears (Cancel receives focus); verify the bundle under
`~/.wmux<suffix>/plugins/agent-state-page` is gone. Reinstall must require fresh
approval. Manual bundles have no Uninstall action. Capture the full window in
Paper, and stop the owned app and daemon after the check.

Connector credentials use the OS secure store even in an isolated profile.
If it is unavailable, record save/connect flows as blocked; never bypass it or
change Keychain access rules. Discover remains available for read-only browsing.

In Discover, browser sign-in recipes show Connect without endpoint or client
fields. Show advanced connections reveals recipes requiring provider setup;
manual presets and registry browsing are under Details and manual setup.
With an authorized test account and available secure storage, Connect must
reuse the same endpoint or save a connection with no allowed tools or bot
scope, show the existing recipient consent, open browser sign-in, then check
the server automatically. A failed check must not show Connected and checked.
Disconnect must discard any late check result. Do not count a disabled Connect
button or a mocked OAuth test as a completed provider sign-in.

## Gotchas

- ⌘, toggles: pressing it with Settings open closes it.
- While a search query is present no tab is `aria-current` and the page title is replaced by results; clicking a tab clears the search.
- All labels are translated. After switching Language, English names stop matching; use `data-settings-tab` and test ids. Switch back to English before the next recipe.
- The font-size slider is on Appearance, not Terminal.
- Settings that write outside the profile: Claude Code tab installers (hooks, statusline), Accounts (CLI logins), Remote & phone and LAN pairing, Computer use permissions. Read them, do not toggle them.
- `~/.wmux<suffix>/config.json` is daemon config; the Settings UI does not write UI preferences there. A `terminal-core.json` from an older build is ignored (Rust is the only terminal engine).
