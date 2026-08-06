# How to attach a remote machine's workspaces

> **Goal:** watch and, optionally, type into another machine's live panes
> from your local sidebar, over a Tailscale-fronted `wmux web` connection.

This is the desktop app's remote attach feature, not a protocol client — no
code required. If you are writing an external client instead, see
[Connect to wmux](./connect-to-wmux.md).

## Prerequisites

- The **remote** machine runs wmux with the web server exposed over
  Tailscale:

  ```
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

1. On the remote machine, run `wmux web --tailscale --allow-input` (or
   without `--allow-input` for read-only). It prints a URL with a bearer
   token embedded — this is what you'll paste locally.

2. Locally, open the titlebar `+` menu and choose **"Attach remote
   workspace…"**.

3. In the modal, paste the printed URL into the add-host field (the input is
   masked, like a password field — the token travels in the URL, so it's
   never echoed back to you in the UI or in error messages) and give it a
   label if you want one, then click **Add host**.

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
- **Old remotes are refused at add-time.** If the URL you paste points at a
  wmux build that predates this feature (no `/api/config` remote-attach
  probe), adding the host fails with an explicit "too old" error rather than
  silently misbehaving.
- **`--allow-input` doesn't mean "safe."** Typing into a remote pane runs
  real commands on that machine, same as being at its terminal. Treat a
  writable remote attach with the same care as SSH access.

## Security notes

The pasted URL's embedded token is a bearer credential: it grants scrollback
read, and — if the remote was started with `--allow-input` — keystroke
injection on that machine, to anyone who has it. Treat it like a password.
Locally, registered hosts (including their tokens) are stored in a
permission-hardened file (owner-only read/write) alongside your other wmux
state, the same discipline used for the daemon's existing token files.

## See also

- [Connect to wmux](./connect-to-wmux.md) — the underlying protocol, if
  you're building your own client instead of using the desktop app's attach
  flow.
- [`docs/SECURITY.md`](../SECURITY.md) — `wmux web`'s exposure model,
  `--tailscale`, `--expose`, and TLS options on the remote side.
