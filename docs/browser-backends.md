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
| `chrome` | A real Chrome instance wmux launches with its own profile directory | Sites that reject embedded browsers (Google sign-in), or when logins must persist |
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

### 3. Live Chrome — your real browser, and everything in it

`Live Chrome (your browser)` attaches to the Chrome you are already running,
with the tabs and logins you already have. There is no way to scope it to one
tab or one profile: the agent gets the browser.

Three separate consents gate it — you enable remote debugging once at
`chrome://inspect/#remote-debugging` (Chrome 144+), you confirm the binding in
wmux, and Chrome itself asks on every connection — because the grant is that
large. Use it when you genuinely want an agent working inside your own session,
and prefer option 2 when you do not.

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
Sign in yourself when a site requires one; the session persists afterwards.

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

Attaching CDP is observable from inside the page: `navigator.webdriver`, and
the side effects of enabling the `Runtime` domain, are signals the browser emits
about itself. Bot-detection vendors have used them for years. wmux does not try
to suppress them — it is a tool for driving *your* browser and *your* sessions,
not for evading a site that has decided it does not want automated traffic. When
a site blocks you, `external` hands it to your normal browser.

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
