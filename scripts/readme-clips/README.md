# README clip kit

Records the GIFs in `docs/readme/` from an isolated copy of the installed wmux.
Frames come from a CDP screencast of the renderer, so recording works while the Mac
is locked or someone is using it, and the clip never contains other windows.

Requirements: `npm ci` in the repo root (for `playwright-core`), `ffmpeg`/`ffprobe` on
PATH, `/Applications/wmux.app`. Run every command from the repo root. Commands that
touch the instance's sockets or CDP port must run outside the Bash sandbox.

| File | What it does |
|---|---|
| `launch.sh <suffix> [--reuse]` | Starts `/Applications/wmux.app` with `WMUX_DATA_SUFFIX=<suffix>`, saves its PIDs and CDP port |
| `down.sh <suffix>` | Kills only the PIDs that instance owns |
| `rec.mjs` | Connects over CDP, records the renderer while a scenario module drives it, writes an mp4 |
| `rec-chrome.mjs` | The same for a tab of the instance's dedicated Chrome |
| `export.sh` | mp4 to an 880 px GIF under 3 MB, with hard cuts between spans |
| `frame-check.sh` | Samples a clip into frames, a contact sheet and OCR flags for the privacy review |
| `rpc.mjs` | One RPC to the isolated daemon (for example `daemon.hooks.signal`) |

## Identity rule

The owner's public identity, GitHub `openwong2kim` and `open.wong2kim@gmail.com`, may
appear. Nothing else may: no other email or account name, no hostname, IP address,
token, home path, or Korean text. That goes for every frame, file name, commit, PR text
and log. If anything else shows in a clip, re-record it. Do not cover it with a blur.

The kit already removes the usual leaks:

- Panes run zsh with a neutral `~/path %` prompt and no user rc files or history
  (`launch.sh` points `ZDOTDIR` at a scratch folder). The default prompt shows
  `user@host`.
- The app gets no caller identity: `launch.sh` drops `WMUX_PTY_ID`, `WMUX_WORKSPACE_ID`,
  `WMUX_SURFACE_ID`, `WMUX_MEMBER_ID`, `WMUX_SOCKET_PATH` and every `CLAUDE*`,
  `ANTHROPIC*`, `AI_AGENT*` variable, so agent CLIs in its panes start clean.

The rest depends on the scene:

- Use a demo repo under `~/projects/<name>` (the iPhone card shows two path levels).
  Give it an English `CLAUDE.md`, because the global one makes agents answer in Korean.
  Add `.claude/settings.json` with `"statusLine": {"type": "command", "command": "true"}`, because the statusline shows the
  account.
- HOME is shared with the real setup. In the first-run wizard, use **Skip**
  (`first-run-wizard-skip`). Never click hooks, statusline or register install
  (`first-run-wizard-hooks-install`, `-statusline-install`, `-register`). They write to the
  real `~/.claude`. Treat any other button that installs into `~/.claude` or
  `~/.claude.json` the same way.
- Never point the wmux CLI or MCP at the real instance, and never touch `~/.wmux` or
  `~/.claude`. Use `ctx.cli([...])` in a scenario, or
  `env -u WMUX_PTY_ID -u WMUX_WORKSPACE_ID -u WMUX_SURFACE_ID -u WMUX_MEMBER_ID -u WMUX_SOCKET_PATH WMUX_DATA_SUFFIX=<suffix> wmux ...`.

## Record a clip end to end

```bash
# 1. Start a fresh instance. A suffix that was used before is refused unless you pass --reuse.
scripts/readme-clips/launch.sh readme5

# 2. Write a scenario (keep it local, e.g. scripts/readme-clips/scenes/, which is gitignored).
# 3. Record it.
node scripts/readme-clips/rec.mjs --suffix readme5 --scenario scripts/readme-clips/scenes/fleet.mjs --name fleet
#    -> $TMPDIR/readme-clips/fleet/{frames/, marks.json, fleet.mp4}

# 4. Cut and export. Spans are seconds (a-b) or mark names (a..b).
scripts/readme-clips/export.sh $TMPDIR/readme-clips/fleet/fleet.mp4 docs/readme/fleet.gif \
  --cut "asked..answered,moved-on..end"

# 5. Privacy review: read every frame, not just the sheet.
scripts/readme-clips/frame-check.sh docs/readme/fleet.gif

# 6. Stop the instance.
scripts/readme-clips/down.sh readme5
```

Run one instance at a time, because the machine is shared. Never use `pkill`, `killall`
or a pattern kill. If a scenario starts its own process, append `<pid> <command
substring>` to `<state>/extra.pids` and `down.sh` kills it too.

## Scenario modules

```js
// scenes/example.mjs
export default async function scene({ page, cursor, mark, sleep, setTheme, rpc, cli, app, log }) {
  await page.getByTestId('first-run-wizard-skip').click().catch(() => {});
  await setTheme('Paper');               // the light theme every clip uses
  mark('clip-start');
  await cursor.click('[data-testid="fanout-button"]');   // overlay glides there, then a real click
  await cursor.type('Add a CHANGELOG check');
  await cursor.press('Enter');
  await page.getByText('Needs you').waitFor();
  mark('asked');
}
```

| Name | What it is |
|---|---|
| `page` | Playwright `Page` of the wmux window (`main_window/index.html`) |
| `cursor` | Drawn cursor. `moveTo(sel)`, `click(sel)`, `drag(from, to)`, `type(text)`, `press(key)`. The CDP frames carry no OS cursor, so every move animates an overlay and then sends the real mouse event. |
| `mark(name)` | Records a named moment in `marks.json` so `export.sh --cut` can cut on it. Do not put `-` or `..` in names you cut on. |
| `setTheme(label)` | Picks a theme in Settings > Appearance. Use `'Paper'` (light) for every clip. |
| `rpc(method, params)` | The isolated daemon over `daemon.sock` and `daemon-auth-token` |
| `cli(args)` | The wmux CLI against the isolated instance, with identity stripped |
| `app` | `suffix`, `dataDir`, `userData`, `chromeProfile`, `stateDir`, `cdpPort` |

Use selectors only (`data-testid`, roles, text), never screen coordinates. A selector
fails loudly if the UI moves. A coordinate clicks whatever happens to be there.

Example for limits.gif: the usage-limit pause injected through the daemon. `ptyId` must be
the pane's exact PTY id. The reset time is epoch seconds:

```js
await rpc('daemon.hooks.signal', {
  kind: 'agent.stop_failure', agent: 'claude', cwd, ts: Date.now(), ptyId,
  payload: { error: 'rate_limit', last_assistant_message: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + 45}` },
});
```

## How the pieces behave

- Window size: `launch.sh` writes `window-state.json` (1280x800, which gives 2560x1600
  frames on Retina) before the first start, so every clip has the same frame. Override it
  with `READMECLIPS_WIDTH` and `READMECLIPS_HEIGHT`. `rec.mjs` warns if the viewport differs.
- Frames: a screencast sends a frame only when the page repaints. `rec.mjs` caps writes at
  30 fps, stores each frame's timestamp, and holds each frame until the next one, so the mp4
  keeps wall-clock time even across idle stretches. The mp4 is a constant 30 fps with a
  keyframe every 30 frames (`-g 30`), which is ready for HyperFrames
  (`npx hyperframes@0.8.64`, run only inside a scratch folder) if a clip needs captions.
- Two sources at once: run `rec-chrome.mjs` in a second terminal during the same take.
  Both `marks.json` files carry `t0`, the wall-clock time of video second 0, so you can
  align them. `rec-chrome.mjs` finds the Chrome CDP port from `DevToolsActivePort` in the
  instance's `chrome-agent-profile`, or takes `--port`.
- Size: `export.sh` steps down from 128 to 48 palette colours, then drops to 8 fps, until
  the GIF fits `--max-mb` (default 3). If it still does not fit, cut more. Cutting saves
  more than zooming.
- Frame check: `frame-check.sh` writes one frame per second at the clip's own resolution,
  a contact sheet, `ocr.tsv` (macOS Vision, English and Korean), and `flags.tsv`. Flags
  cover emails, IPs, token-like words, hostnames, home paths, Korean text, `user@`, and
  this machine's own names. Only frame names and the type of match are printed, so a leaked
  value is not copied into logs. A flagged frame means re-record. No flags does not mean
  the clip is clean: look at every frame yourself.

`node --test scripts/readme-clips/lib.test.mjs` covers the frame-timing helpers.
