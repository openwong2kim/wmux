# How to attach a remote machine's workspaces

> **Goal:** watch and, optionally, type into another machine's live panes
> from your local sidebar, over a Tailscale-fronted `wmux web` connection.

This is the desktop app's remote attach feature, not a protocol client — no
code required. If you are writing an external client instead, see
[Connect to wmux](./connect-to-wmux.md).

## Prerequisites

- The **remote** machine runs wmux with the web server exposed over
  Tailscale:

  ```bash
  wmux web --tailscale --allow-input
  ```

  `--allow-input` is optional. Without it, the remote is attachable
  read-only. `--tailscale` fronts the server with a valid HTTPS certificate
  on your tailnet's MagicDNS name and auto-allowlists that host — this is
  the supported path. A self-signed `--tls-cert`/`--tls-key` setup is
  **not** supported for remote attach: the attach client's HTTP/SSE
  connection runs through Node's `fetch`, which rejects a self-signed
  certificate outright, so the add-host step fails. Use `--tailscale`.

- The **local** machine is the desktop app you're attaching from.

## Steps

There are two ways to register the remote host locally: pairing with a code
(recommended), or pasting the URL `wmux web` prints. Both end up at the same
place — a registered host you can pick workspaces from.

### Pairing with a code (recommended)

1. On the remote machine, run `wmux web --tailscale --allow-input` (or
   without `--allow-input` for read-only), then open the **Web popover** in
   the titlebar. It shows an 8-character pairing code, valid for 10 minutes
   and single-use.

2. Locally, open the titlebar `+` menu, choose **"Attach remote
   workspace…"**, and stay on the default **"Pair with code"** tab. Enter
   the remote's host address (e.g. `https://office-mac.tailXXXX.ts.net`) and
   the code you just read, then click **Pair**.

3. The app exchanges the code for a token over `GET /api/pair` and registers
   the host — no token ever touches your clipboard or the URL bar.

This is the recommended path for two reasons: nothing sensitive is ever
copy-pasted, and the token this mints is **device-scoped** — the remote can
revoke just this one PC from its device list later, instead of every
attached device sharing (and losing access with) one long-lived token.

### Pasting the URL (fallback)

1. On the remote machine, run `wmux web --tailscale --allow-input` (or
   without `--allow-input` for read-only). It prints a URL with a bearer
   token embedded — this is what you'll paste locally.

2. Locally, open the titlebar `+` menu, choose **"Attach remote
   workspace…"**, and switch to the **"Paste URL"** tab.

3. Paste the printed URL into the add-host field (the input is masked, like
   a password field — the token travels in the URL, so it's never echoed
   back to you in the UI or in error messages) and give it a label if you
   want one, then click **Add host**.

### After registering a host

4. Select the host on the left. The right side lists its workspaces — this
   list is derived from the remote's **live panes right now**
   (`GET /api/workspaces` on the remote), not a saved workspace registry, so
   a workspace with no open panes won't appear.

5. Pick a workspace and click **Attach**. It appears in its own section in
   your local sidebar, showing a mirror grid of up to **6** of that
   workspace's panes at once. Each mirror pane reads the remote's scrollback
   live and, if the remote was started with `--allow-input`, accepts your
   keystrokes and forwards them to the remote pane.

6. If the remote is read-only (no `--allow-input`), the mirror view shows a
   read-only banner and typing has no effect.

## Detaching

Detach from the sidebar item. Detaching only tears down the local mirror
connection — it never creates, closes, or otherwise touches anything on the
remote. There is currently no way to create, rename, or close a remote
workspace from this view; attach/detach is all that's exposed.

## Removing a registered host

Each host row in the attach modal has a remove button (×) next to it.
Removing a host forgets its stored URL/token locally and tears down any
live mirror connections to it — it does not touch anything on the remote
machine. Use this when a host's token has been rejected (see above) and you
need to re-add it with a freshly printed URL.

## Limitations

- **Workspace list is live-pane-derived.** Only workspaces with at least one
  open pane on the remote show up. A workspace that exists but is empty
  won't be offered.
- **No remote workspace management.** Create, rename, close, and focus all
  stay local-only operations for now — this view is attach/detach only.
- **Attachments don't persist.** What you've attached lives for the current
  app run; restart the app and you'll need to re-attach. The registered
  hosts themselves (the ones you've added URLs for) do persist.
- **Pane geometry is frozen per connection.** If the remote pane is resized
  after you attach, the mirror keeps showing the old geometry until the
  stream reconnects — it does not renegotiate size live.
- **Old/unreachable/rejected remotes are refused at add-time**, with a
  distinct message for each cause rather than one catch-all failure:
  - *"that machine's wmux is too old for remote attach"* — the URL points
    at a wmux build that predates this feature (no `/api/config`
    remote-attach probe, or a response this app can't parse).
  - *"could not reach that host"* — the connection itself failed (host
    down, wrong Tailscale name, network blip).
  - *"token rejected — re-run wmux web on the remote and paste the new
    URL"* — the host was reached, but the embedded bearer token was
    refused (401/403). Re-running `wmux web` on the remote mints a fresh
    token; paste that new URL to re-add the host, or use the remove button
    on the old entry first if it's still listed.
- **A pairing code has a 10-minute window and 5 guesses.** After that, or on
  a duplicate/unreachable/too-old host, pairing fails with its own distinct
  message — an expired or exhausted code is fixed by opening the remote's
  Web popover again for a fresh one.
- **`--allow-input` doesn't mean "safe."** Typing into a remote pane runs
  real commands on that machine, same as being at its terminal. Treat a
  writable remote attach with the same care as SSH access.

## Security notes

Either registration path ends with a bearer credential granting scrollback
read, and — if the remote was started with `--allow-input` — keystroke
injection on that machine. Treat it like a password. Locally, registered
hosts (including their tokens) are stored in a permission-hardened file
(owner-only read/write) alongside your other wmux state, the same
discipline used for the daemon's existing token files.

The two paths differ in what that credential *is*: the pasted URL carries
the remote's shared operator token (the same one for every device that ever
pasted it), while pairing mints a fresh **device-scoped** token per PC —
the remote's device list can revoke this one machine without touching any
other attached device.

To revoke, go to the **remote** machine and open **Paired devices…** in its
titlebar Web popover. Each device is listed by the name it was given at pair
time; revoking one cuts its live connections immediately and permanently. A
revoked device comes back only by pairing again. The roster reads from the
device store rather than the running server, so it is available even after
`wmux web --stop` — worth checking after you stop sharing, since stopping
the server does not by itself retire the credentials it handed out.

Typing is granted per device. When you pair one, the Web popover asks
whether it may type; afterwards the grant is a checkbox on its row in
**Paired devices…**, so a device can be made read-only without revoking it.

`--allow-input` on the server is the **ceiling**, not the grant: a server
started without it lets nothing type regardless of what any device's row
says, and the roster tells you so. Devices paired before per-device grants
existed keep the access they had — they were typing under the server flag,
and an upgrade does not silently mute them.

## See also

- [Connect to wmux](./connect-to-wmux.md) — the underlying protocol, if
  you're building your own client instead of using the desktop app's attach
  flow.
- [`docs/SECURITY.md`](../SECURITY.md) — `wmux web`'s exposure model,
  `--tailscale`, `--expose`, and TLS options on the remote side.
