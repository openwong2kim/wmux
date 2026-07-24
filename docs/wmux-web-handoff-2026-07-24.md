# wmux web — Handoff (2026-07-24)

Status of the `feat/wmux-web-ttyd` branch: **feature-complete, verified end to
end, under review as [PR #578](https://github.com/openwong2kim/wmux/pull/578).**
This document was written as the pre-PR pickup point and is kept for the
architecture/verification record.

---

## 0. TL;DR

`wmux web` began as a read-only browser view of a pane. It is now a phone-usable
surface: a touch key bar, in-app attention notifications, a 6-character pairing
code, a fleet strip, and a titlebar toggle that starts the server without a
terminal. Read-only remains the default and is enforced server-side.

Everything below is committed on the branch, which is **rebased onto current
`origin/main` (3.32.0)** and verified end to end against a real daemon and a real
PTY.

---

## 1. What shipped on this branch

Seven commits, oldest first (post-rebase hashes):

| Commit | What |
|---|---|
| `d426ad03` | `wmux web` — read-only-by-default browser/PWA terminal |
| `99a6ad4d` | plan-review hardening: local-only default, scrollback warning, Bearer auth |
| `ac294400` | mobile-grade frontend: key bar, notifications, pairing code, fleet strip |
| `a9540fdd` | titlebar toggle (renderer → IPC → daemon RPC) |
| `6b4a64ed` | CHANGELOG entry |
| `2b276039` | localhost-service hardening (security review P1+P2) |
| `0eb3b8cf` | this handoff document |

True PR scope (three-dot vs `origin/main`): **28 files, +4299 / -2.**

### 1.1 Browser surface (`src/daemon/web/frontend/`)

No bundler, no **runtime** frontend deps — `index.html` + `styles.css` + `app.js`
are inlined into one `terminal.html` by `scripts/build-daemon-web.mjs`. Vanilla
ES5-ish JS. (The build itself still needs the repo's dev dependencies — `@xterm/*`
and `esbuild` — so `npm install` remains required before `build:daemon-web`.)

- **Chrome redesign** per `DESIGN.md`: custom session switcher + sheet (replaced
  the native `<select>`), dot-vocabulary connection chip, full
  loading/empty/error/auth state cycle, inline token form (replaced
  `window.prompt`), graphite xterm scrollbar.
- **Touch key bar**: `Esc Tab Ctrl Alt ← ↑ ↓ → | / ~ - _ Home End PgUp PgDn`.
  Modifiers follow the mobile-terminal convention: one tap arms for the next key
  (steel), double-tap within 400 ms locks (amber). Ctrl maps `@A-Z[\]^_` onto
  `0x00-0x1f`. A second row carries agent-steering keys: `Shift+Tab`, `Ctrl+C`,
  `Enter`, `yes`, `continue`, `/compact`, `/clear`, `/resume`.
- **Font size + two view modes.** `A-` / `A+` (8–22 px, persisted) and a `Fit`
  toggle. This split exists because the original code always CSS-scaled the
  terminal to the viewport width, which silently cancelled any font change — at
  100 cols on a 390 px screen the text was unreadable. `Fit` = whole-width
  overview; off = render 1:1 and scroll sideways (stays crisp, no CSS scale).
- **In-app notifications**: banners for `critical` / `notify` SSE events, with a
  colored left edge (danger / steel — no washes), tap-to-jump, 12 s auto-dismiss,
  `navigator.vibrate` on critical, and a `●` title badge while unacknowledged.
- **Fleet strip**: per-pane chips (amber = running, green = idle), steel underline
  on the current pane, red attention dot on panes that called for you, refreshed
  every 30 s, hidden below two sessions (dead-chrome rule).
- **Pairing screen** at `/pair`.

### 1.2 Server (`src/daemon/web/WebTerminalServer.ts`)

- **Event tee.** `start()` attaches listeners to `DaemonSessionManager`'s
  `session:critical` and `session:notification`; `stop()` removes them (tested for
  leak across restarts). Events are broadcast to **every** SSE client regardless
  of which session that stream watches — a viewer on pane A must hear that pane B
  needs an answer.
- **Pairing.** `GET /api/pair?code=` is the only unauthenticated API route. A
  6-char code (`A-Z2-9` minus `0O1I`) exchanges for the web token: single use,
  10-minute TTL, 5 attempts, `timingSafeEqual`, and it regenerates once burned
  (30 s cooldown).
- **Hardening** (from the security review): `X-Frame-Options: DENY` + CSP
  `frame-ancestors 'none'` + `nosniff` + `Referrer-Policy: no-referrer` on every
  response; a `Host` allowlist checked before routing.

### 1.3 GUI toggle

```text
StatusBar/WebToggle.tsx → IPC web:status|start|stop
  → main/ipc/handlers/web.handler.ts → DaemonClient.rpc
  → daemon.web.{status,start,stop} → WebTerminalServer
```

`src/shared/web.ts` is the single contract shared by all three layers so they
cannot drift. The handler registers **unconditionally** and resolves
`{running: false, error}` when the daemon is unreachable — a titlebar control must
never throw "No handler registered". The control lives in the bottom StatusBar
(the DESIGN.md "status footer instrument strip"), rendering as muted `web` at rest
and growing an amber alive-dot while the server runs.

---

## 2. Security model (do not regress this)

Read-only is **not** a UI state. `POST /api/input` returns `403` unless the server
was started with `allowInput`, so a tampered page or a raw `curl` still cannot
type. The frontend's `disableStdin` is cosmetic; the trust boundary is the
`pty.write` gate in the server. Changing the mode requires a restart, which
rotates both the token and the pairing code.

Other invariants worth preserving:

- Nothing listens until `daemon.web.start`. Default bind is loopback.
- The web token is minted per start; the daemon master token never goes on the
  network. Bearer-only on every route except `/api/stream` (EventSource cannot set
  headers), and the page strips `?token=` from its own URL after load.
- Even read-only exposes the selected pane's **full scrollback**. Every surface
  that starts the server says so.

---

## 3. Verification performed

| Check | Result |
|---|---|
| `vitest` (web server, IPC handler, WebToggle) | 72 passed |
| `npx tsc --noEmit -p tsconfig.json` | clean (note: there is no `npm run typecheck` script — see §4.4) |
| `eslint` on changed files | clean (the repo-wide `vitest/config` errors pre-exist on a clean tree) |
| `npm run build:daemon-web` | 539 KB `terminal.html` |
| API-reference drift guard | no drift |
| **Live dogfood, real daemon** | StatusBar `web` → Start → amber dot → popover showed URL + pairing code `MPC3AQ` → `GET /api/pair?code=MPC3AQ` returned the token → reuse returned `expired` → `/api/sessions` listed the real pane `daemon-580c77f2` (142×39) |
| Live hardening check | all four security headers present; `Host: evil.com` → `403 host not allowed`; normal request → `200` |

Screenshots were taken via CDP against both the isolated harness and the live dev
app. Note: Edge's `--screenshot` flag **hangs** on this page because the SSE
stream never lets the load event settle — drive `Page.captureScreenshot` over CDP
instead.

### End-to-end phone dogfood (post-rebase, real daemon, real PTY)

Run against the rebased branch with a 390×844 emulated phone driving the live dev
app. Every step used only what a phone has — no physical keyboard:

1. GUI titlebar `web` → checked **Allow input** → **Start**; popover issued
   pairing code `PY3M9K`.
2. Phone opened `/pair`, typed the code, submitted → redirected to `/` holding a
   token in `sessionStorage`.
3. Page reported `conn: live`, `mode: input enabled`, session `Users/rizz`
   (a **real** PowerShell pane), key bar rendered with all 17 keys.
4. Typed `echo PHONE_OK_777146` and pressed **Enter from the key bar's agent row**.
5. The real shell executed it and streamed the result back:

```text
PS C:\Users\rizz> echo PHONE_OK_777146
PHONE_OK_777146
PS C:\Users\rizz>
```

That closes what was previously the biggest unverified item.

### Still not verified

- **An actual phone.** All mobile verification was a 390×844 emulated viewport.
  iOS "Add to Home Screen", Android install, and real touch/IME behaviour are
  untested on hardware.
- Web push (deliberately out of scope — needs HTTPS; see §5).

---

## 4. Rebase (done — kept here as the record of how it went)

The branch was 13 commits behind `origin/main` (which had moved to 3.32.0). The
rebase is **done**; this section records what it hit, because the same traps will
recur on the next long-lived branch.

1. **The CHANGELOG conflict resolves the wrong way by default.** Our entries sit
   under `## [Unreleased]`; main had cut a release, so git offers the released
   `## [3.32.0]` block against our bullets. Taking the naive resolution files our
   feature under 3.32.0 — a changelog claiming a shipped release contained work it
   does not. Both hunks were resolved by keeping our bullets under `[Unreleased]`
   and letting the released section follow untouched. Verify after any future
   rebase: `awk '/^## \[Unreleased\]/,/^## \[3\./' CHANGELOG.md`.
2. **Three `#557` daemon commits were already upstream** as squash `ac84a50c`. Two
   were `git rebase --skip`ped, one git dropped on its own. The diff against main
   went from 10 897 deleted lines (a stale-branch illusion) to 2.
3. **A conflict marker survived into a commit and broke the build.** While
   resolving `registerHandlers.ts` the marker scan was run as
   `grep -n '^<<<<<<<...' | head -6` — there were three conflict regions (nine
   marker lines), so `head` hid the third. The follow-up sanity grep matched
   symbol names *inside* the unresolved block and looked fine. Nothing caught it
   until the Electron build failed with `Unexpected "<<"`. Fixed with
   `git commit --fixup` + `GIT_SEQUENCE_EDITOR=true git rebase --autosquash` so no
   commit in the final history contains a marker. **Never truncate a marker scan**;
   `git grep -n '^<<<<<<< ' -- .` over the whole tree is the check that cannot lie.
4. **`npm run typecheck` does not exist in this repo.** Running it prints nothing,
   which reads exactly like success — it is how the marker slipped past a "clean
   typecheck". The real check is `npx tsc --noEmit -p tsconfig.json`.

Re-run the tests after rebasing — main's newer commits touch the daemon.

Per repo policy, **do not bump `package.json`**; releases are an explicit,
separate owner action.

---

## 5. Follow-ups (not blockers)

From `docs/web-security-review-2026-07-24.md`, phases P3/P4:

- **W1 — `--expose` is cleartext.** The token and full scrollback cross the network
  in the clear. Currently mitigated by wording only. Real fix: native TLS or a
  `tailscale serve` wrapper.
- **W4 — full CSP.** Only `frame-ancestors` ships today; a hashed script-src policy
  needs build-script work and would contain any future XSS.

Product gaps still open against competitors (Pane, Moshi, xylocopa), from the
research in `docs/mobile-control-research-2026-07-22.md`:

- **Web push** (agent needs you while the tab is closed). Requires HTTPS —
  service workers only register in a secure context — plus VAPID key management.
  In-app notifications already cover the tab-open case over plain HTTP.
- Approving a tool call from the phone (the `critical` event is already on the
  wire; only the response path is missing).
- Clipboard paste, swipe-between-sessions, file browser / git diff, voice input.

---

## 6. Repo hygiene notes

- `integrations/claude/bin/wmux-statusline.mjs` is modified in the working tree but
  **deliberately uncommitted** — it is unrelated work (model-label handling) that
  happened to be dirty. Do not fold it into this PR.
- `scripts/_webserve-harness.ts` is a committed dev harness: it fakes two panes and
  emits synthetic `critical`/`notify` events every 20 s so the notification path
  can be exercised without a daemon. Any alarm you see coming from it is fake.
- `scripts/_webgui-launch.cmd` launches an isolated dev app
  (`WMUX_DATA_SUFFIX=-webgui`) so dogfooding does not disturb the production
  instance.
- During this work `node_modules` was mid-reinstall and `@xterm`, `esbuild`, and
  `node-pty` were all missing for a stretch. If builds fail in strange ways, check
  that first — `npm install` restored it in ~15 s.
