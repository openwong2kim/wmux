# Browser backends: what agents can drive, and what they cannot

wmux drives a browser over the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
(CDP). That choice buys a lot — no browser to install, no fork to maintain, and
the same MCP tool surface across backends — and it costs a few things outright.
This page is the honest list of both, so you can pick a backend knowing what it
will refuse to do.

## The three backends

Settings → Browser picks one. It applies to every workspace.

| Backend | What it is | When to use it |
| --- | --- | --- |
| `builtin` (default) | A webview inside the wmux window | Ordinary page work you want to *watch* in the same window as your panes |
| `chrome` | A real Chrome instance wmux launches with its own profile directory — or, with the `live` profile, an attach to the Chrome you are already running | Sites that reject embedded browsers (Google sign-in), or when logins must persist |
| `external` | Hand the URL to your normal browser and stop | Anything an agent should not be driving at all |

`external` is not a degraded mode. It is the right answer when a site is hostile
to automation, and it is always available as an escape hatch.

## Choosing a Chrome profile: three levels of exposure

On the `chrome` backend, each workspace binds to a profile
(workspace card → right-click → **Chrome profile**). The choice is a security
decision, not a convenience one.

### 1. A wmux profile, not signed in — safest

`default`, or any profile you create with **New profile…**. Its own
`--user-data-dir`, empty on first launch. An agent that misbehaves here has no
session to lose, because there is none.

### 2. A wmux profile you signed into once — the intended way to use accounts

Same mechanism. You open the agent's Chrome window and sign in yourself, once;
the login persists in that profile directory. Workspace A can drive an
account-A Chrome while workspace B drives account B.

Blast radius is that one profile and that one account. This is the option to
reach for when you want per-workspace accounts.

### 3. Live Chrome — your real browser, read wholly, written narrowly

`Live Chrome (your browser)` attaches to the Chrome you are already running,
with the tabs and logins you already have. What that grant covers is asymmetric,
on purpose:

- **Reads see the whole browser.** `browser_tabs list`, snapshots, screenshots,
  text and data extraction, console, network, cookie and storage reads work on
  any tab. Binding a workspace to Live Chrome IS that consent — the point of the
  backend is an agent working inside a session you signed into yourself.
- **Writes are confined to the agent's own tabs.** Navigating, clicking, typing,
  pressing keys, hovering, dragging, evaluating JavaScript, setting cookies,
  emulating, resizing, closing, uploading a file, answering a dialog, starting a
  trace: each of those succeeds only on a tab wmux opened for that workspace, or
  a tab you have explicitly lent it. Anything else fails before it touches the
  page, with an error beginning `agent_window_scope:` that names the tab and how
  to ask for it.

Ownership is exact, not merely "wmux opened it": a tab opened for workspace A is
a foreign tab from workspace B, and is refused the same way one of yours is.

Three separate consents gate the attach itself — you enable remote debugging once
from the **Remote debugging** item in the `chrome://inspect` sidebar
(Chrome 144+), you confirm the binding in wmux, and Chrome itself asks on every
connection — because even a read-only view of your whole browser is a large
grant. Use it when you genuinely want an agent working inside your own session,
and prefer option 2 when you do not.

#### Lending the agent one of your tabs

When the agent needs to act on a tab it did not open — a page you have already
signed into and navigated to the right place — it asks:

```
browser_tabs action:"borrow" surfaceId:"<id from browser_tabs list>"
```

That raises the ordinary wmux permission prompt (the same dialog and Fleet
approvals inbox every MCP permission request uses), reading
`Agent in workspace <name> wants to control tab "<title>" (<origin>)`. You have
60 seconds; if nobody answers, the request is **denied**. The three refusals are
distinguishable to the agent, because its next move differs: `user_denied:`,
`borrow_timeout:` and `borrow_pending:` (one request for that tab is already on
screen — a second cannot be stacked on you).

A grant covers one tab, for one workspace, for as long as the session lasts.
`browser_tabs action:"return"` hands it back; changing that workspace's Chrome
profile binding, quitting wmux, or Chrome disconnecting clears every grant.
Teardown closes nothing on this backend — not a tab you lent, and not the
agent's own tabs either, because on Live Chrome those are windows on your
desktop. (An agent can still close a tab it owns, or one you lent it, by asking.)

**You lend a tab, not a site.** The prompt names the origin so you know what you
are handing over, but the grant follows the TAB: an agent that navigates a lent
tab somewhere else keeps writing to it, which is usually the point (that is how
a flow proceeds through a site). Return it when the job is done rather than
leaving it lent, and prefer lending a tab you opened for the task over one that
also holds something you care about.

`browser_tabs list` labels every row `agent` (wmux opened it for this
workspace), `borrowed` (you lent it) or `user` (everything else), and
`scope:"agent"` / `scope:"user"` filters the list. The default is still every
tab.

#### Window grouping is best-effort; ownership is not

The first tab a workspace opens asks Chrome for a new window, and later ones are
opened with one of that workspace's own tabs activated, which is what makes
Chrome place them beside it. That usually produces one "agent window" you can
watch, minimise or move as a unit — but it is a request, not a guarantee, and
**CDP has no command that moves an existing tab from one window to another**
(neither the `Target` nor the `Browser` domain offers one). So a tab can end up
in a window of its own.

Nothing about the permission follows the window. A tab that landed somewhere
unexpected is still that workspace's tab, and a tab in the agent's window that
the agent did not open is still yours. Grouping is for your eyes; ownership is
the recorded fact.

#### The operator opt-out

`liveWriteScope` in `browser-backend.json` (`%APPDATA%\wmux\browser-backend.json`
on Windows, `~/Library/Application Support/wmux/` on macOS,
`~/.config/wmux/` on Linux) takes `"agent"` (the default, described above) or
`"all"`:

```json
{ "backend": "chrome", "liveWriteScope": "all" }
```

`"all"` restores the pre-policy behaviour: every live tab is writable. Be clear
about which direction that moves — it is the **larger** grant of the two. Under
`"agent"` a mistake costs one of the agent's own tabs; under `"all"` the blast
radius is every session in the browser, every tab you have open, including the
ones you would never have handed over if asked. It has no Settings toggle for
the same reason: it should cost an edit to a file, not a click.

> **Why your existing Chrome profiles are not in the list.** Since Chrome 136,
> Chrome refuses `--remote-debugging-port` when the profile is the default user
> data directory ([announcement](https://developer.chrome.com/blog/remote-debugging-port)).
> Pointing wmux at `Profile 3` would produce a browser no tool could drive.
> Live Chrome exists precisely because it is the supported path to a real
> profile.

## What the tools will not do

These are limits of driving a browser from outside, not bugs to be filed.

### Real passkeys and hardware authenticators

An agent cannot complete a passkey, FIDO2, or security-key login. CDP's
`WebAuthn` domain exists to *test* WebAuthn: it configures **virtual**
authenticators, and has no command that drives the platform authenticator
holding your real credential ([spec](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/)).
Sign in yourself when a site requires one; the session persists afterwards. An
agent can ask you to do it in place with `browser_request_help`, which puts a
Done / Cancel bar on the pane and waits.

### Canvas-rendered interfaces

Figma, Flutter web, and anything else painting its UI into a `<canvas>` exposes
no DOM and no accessibility tree. `browser_snapshot` returns an empty canvas
element because that is genuinely all there is. Screenshots still work; nothing
else meaningfully does.

### Coordinates during compositor-driven animation

`transform`, `opacity`, `filter`, and `backdrop-filter` animate on the
compositor thread, and the main thread — which is where the accessibility tree
and `getBoundingClientRect` live — does not track them frame by frame. An
element's reported position can lag what is on screen mid-animation. Wait for
the animation to settle before acting on a coordinate.

### Sites that detect automation

A page can tell it is being automated. `navigator.webdriver` and the browser's
own build fingerprint are signals the browser emits about itself, and
bot-detection vendors have used them for years. wmux does not try to suppress
them — it is a tool for driving *your* browser and *your* sessions, not for
evading a site that has decided it does not want automated traffic. When a site
blocks you, `external` hands it to your normal browser.

Which signals appear depends on the backend, and not in the way you would
guess. The next section is the measured detail.

## The automation fingerprint, by backend

Reach for an official API before reaching for a browser. If the service has one
— YouTube, Instagram, most of what an agent is asked to post to — OAuth is the
supported path: the user consents once in their real browser, the app holds a
refresh token, and no browser is being driven at all, so none of this section
applies. The rest of it is for the case where there is no API and an agent has
to work inside a session the user signed into themselves.

**wmux never types credentials into a login form**, on any backend. A person
signs in; automation runs after that. The differences below are there so you can
pick a backend knowing what it looks like, not to slip a login past a site's
defences.

### What actually sets `navigator.webdriver`

The launch flag, not the connection. Chrome sets the bit when it is *started*
with `--remote-debugging-port`, and it is already `true` before any client
attaches; connecting a debugger later never sets it. Measured on Chrome 151:

| How debugging was enabled | Debug port open? | `navigator.webdriver` |
| --- | --- | --- |
| `--remote-debugging-port` on the command line | yes | **`true`** |
| `chrome://inspect` consent, enabled at runtime | yes (9222) | `false` |
| `chrome.debugger` extension API | no | `false` |
| Not enabled at all | no | `false` |

The middle two rows are the point: the same CDP-over-WebSocket connection reads
as automated or not depending purely on how the browser was launched.

### The backends side by side

Measured on Chrome 151 / Electron 41 by opening a page and reading the values —
no accounts, no sign-in.

| Signal | `chrome` (wmux-launched profile) | `chrome` + Live Chrome | `builtin` (webview) |
| --- | --- | --- | --- |
| `navigator.webdriver` | **`true`** | `false` | `false` |
| `window.chrome` keys | full | full | **empty array** |
| `navigator.userAgentData` | brands present | brands present | **`null`** |
| `navigator.languages` | full list | full list | **single entry** |
| User agent | ordinary Chrome | ordinary Chrome | **contains `Electron/…`** |
| Banner while attached | none | **~56 px bar** | none |

So neither of the two "quiet" options is invisible, and the noisy one is noisy
in different ways: the wmux-launched Chrome profile announces itself through
`navigator.webdriver`, while `builtin` announces itself through four separate
Electron tells that no flag controls.

### Live Chrome is the user's own consent, not a workaround

Live Chrome reads clean on the fingerprint above for a straightforward reason:
Chrome is started normally, by the user, and remote debugging is turned on
afterwards through Chrome's own UI. Nothing is being disguised — the browser
genuinely is the user's, and the user genuinely allowed the connection.

That consent is what the read grant rests on, and it is also why writes do not
rest on it alone: agreeing to let an agent work in your browser is not the same
as agreeing to let it type into the tab you happen to have open. See
[Live Chrome](#3-live-chrome--your-real-browser-read-wholly-written-narrowly)
above for what that means in practice.

Enabling it, once:

1. Open `chrome://inspect` and click **Remote debugging** in the left sidebar
   (Chrome 144+), then tick the setting. The `#remote-debugging` fragment does
   not select that item — the page opens on **Devices** whatever fragment it is
   given.
2. **Restart Chrome.** The setting persists in the profile
   (`Local State` → `devtools.remote_debugging.user-enabled`), but the running
   instance does not open the endpoint — the port stayed closed for the ~17 s
   it was watched after the toggle.
3. From then on Chrome opens the endpoint on **port 9222** at every start.

What it costs, all of it measured:

- **A banner, the whole time a client is attached.** Roughly 56 px of viewport,
  gone again when nothing is attached. Enabling the setting alone shows nothing.
- **Connections after the first one did not complete.** One connection
  succeeded; three later attempts sat unanswered for 20–25 s. That is consistent
  with the per-connection permission prompt Chrome documents for this flow, but
  the prompt itself was not observed — no separate dialog window appeared, and
  the inside of the browser window was not inspected. Treat unattended,
  long-running use as unproven.
- **A fixed port.** 9222, not an ephemeral one, so anything else on the machine
  can find it.

### What was not measured

Stated plainly, because the gaps matter more than the table:

- **Whether Google blocks any of this.** Sign-in pages were opened and read
  *before* any credential was entered; no block screen appeared for any backend.
  That is not evidence that signing in would succeed. Control cases that should
  have produced a block — `--enable-automation`, an embedded-webview user agent
  on the OAuth endpoint — did not produce one either, so the check never
  demonstrated it could detect a block at all. **What happens after credentials
  are submitted is untested.**
- **Whether a signed-in session gets throttled once automation drives it.** No
  documentation was found either way.
- **The banner is a signal to the person at the keyboard**, not something page
  JavaScript can read. "No `navigator.webdriver`" is not "undetectable".

## Password values are redacted

Every tool result masks password field values as `[redacted:password]`:
accessibility and DOM snapshots, `browser_type` echoes, console output, network
URLs and bodies. A field is treated as a password when it is
`input[type=password]` or carries `autocomplete="current-password"` /
`"new-password"` — an attribute rule, not a guess from the label.

What survives on purpose: the field itself, its role, label, name, and `ref`.
You can still find and fill a login form. And because an empty field has no
value at all, a redacted value means the field **is** filled.

One deliberate exception: **`browser_evaluate` is not filtered.** Running
arbitrary JavaScript is the point of that tool, and a filter narrow enough to be
correct there does not exist. Treat it as the escape hatch it is.
