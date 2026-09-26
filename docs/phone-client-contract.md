# The contract a wmux phone client implements

Everything a native client needs from the daemon, extracted from the code that
serves it rather than written alongside it. The browser page in
`src/daemon/web/frontend/` is a working reference implementation of all of it.

Server: `src/daemon/web/WebTerminalServer.ts`. Push envelope:
`src/shared/push/pushEnvelope.ts`. Relay: `relay/`.

---

## 1. Transport, and the one rule that shapes everything else

The daemon can speak either HTTP or native HTTPS. The simplest encrypted remote
setup is `wmux web --tailscale`, which binds `127.0.0.1` and lets `tailscale
serve` terminate HTTPS on the tailnet. Operators with their own certificate can
instead use `--tls-cert <fullchain.pem>` and `--tls-key <privkey.pem>`; the
daemon then terminates HTTPS itself. Bare `--expose` remains plaintext HTTP.

**A device credential never expires.** That single fact drives most of the rules
below: the daemon refuses to mint one over a plaintext non-loopback bind, permits
minting on its own HTTPS listener, refuses to accept one from a query string,
and issues short-lived tickets for the one transport that cannot send headers.

Every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, and a CSP. Only the HTML response
carries the full hash-pinned policy; everything else carries
`frame-ancestors 'none'` alone, so a keystroke does not pay for script hashes it
has no use for.

### Host header

Every request is checked against an allowlist (loopback names, the bind address,
and anything passed to `--allow-host`). A `Host` the daemon does not recognise is
refused before routing — a DNS-rebinding guard. Send the host you dialed.

This is **not** treated as evidence of a secure transport anywhere. It used to
be, for minting; that was removed, because the caller writes the header.

### Protocol version

`GET /api/config` is the first authenticated call a client makes, and it carries
the handshake:

| Field | Meaning |
| --- | --- |
| `protocolVersion` | the phone contract this daemon speaks |
| `minProtocolVersion` | the oldest client contract it still accepts |
| `serverVersion` | the release the daemon was spawned from — display and bug reports only, never compared |

Read it once at connect, before anything else on the screen depends on a route
answering.

- **A missing `protocolVersion` is not an error.** A daemon predating the
  handshake answers the same body with all three keys absent; read that as
  protocol `0` and carry on exactly as before. Nothing that shipped before this
  section changed shape.
- **If your own protocol is below `minProtocolVersion`, stop and say so.** Show
  an explicit "update required" state naming the app, not the daemon — the
  operator's phone is the thing that has to move. Do not retry, do not fall
  back: the server has deleted the shape you speak, so every later call is a
  failure with a worse explanation attached.
- **If `protocolVersion` is above yours, keep going.** The number moves only on
  breaking changes, and the floor is what decides whether you are still served.
  A newer daemon that still accepts you is the normal case, not a warning.
- `serverVersion` is a string and may be the literal `unknown`. It is never a
  compatibility input — the two numbers above are the whole gate.

The version is deliberately not on a route of its own. A separate `/api/version`
would be a second round trip that only pre-handshake daemons could fail, which
is precisely the daemon the handshake exists to recognise.

---

## 2. Pairing

```
operator (desktop)                   phone
─────────────────────                ─────
daemon.web.pairStart {name}
  → {code, expiresAt}
        ── operator shares the 8-char code ───────▶
                                     GET /api/pair?code=ABCD2345
                                       → 200 {deviceId, deviceSecret, token}
```

`GET /api/pair?code=` is the **only** unauthenticated API route.

- Code: 8 characters (40 bits), 10 minutes, single use, 5 attempts. The
  32-character alphabet is `A-Z2-9` minus `0 O 1 I`, so it survives being read
  aloud.
- `Sec-Fetch-Site: cross-site` is refused with `403 {error: 'cross-site request
  refused'}` before the attempt counter is touched — this is the one
  unauthenticated route, so five guesses must not be burnable by an
  `<img src="http://127.0.0.1:7681/api/pair?code=…">` on someone else's page.
- The operator names the device *before* the code exists. A roster of UUIDs
  cannot be operated.
- A burned or expired code is replaced automatically, rate-limited to one
  regeneration per 30 s, so five wrong guesses cost the operator a short wait
  rather than a restart. The new code is read from the desktop.

Responses:

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{deviceId, deviceSecret, token}` | `token` is the composed `deviceId.deviceSecret` — store this one; the split fields are informational |
| 403 | `{error: 'invalid code', attemptsLeft}` | Wrong code |
| 403 | `{error: 'expired'}` | Code expired or burned; a fresh one is minted (rate-limited) for the operator to read |
| 403 | `{error: 'too many attempts'}` | Attempts exhausted |
| 403 | `{error: 'insecure-transport', detail}` | Plaintext non-loopback bind. `detail` is operator-facing prose; show it verbatim |
| 500 | `{error: 'pairing failed'}` | The roster could not be written. The code is **not** burned — the operator can retry |

Store `token` and nothing else. `deviceSecret` is returned exactly once and is
never recoverable; a phone that loses it re-pairs.

---

## 3. Authentication

```
Authorization: Bearer <deviceId>.<deviceSecret>
```

Header only. A device credential presented in a query string authenticates
nothing, on any route.

A 401 carries `{error: 'unauthorized', reason}` where `reason` is:

- `'revoked'` — the operator removed this device. Show that; do not retry. Note
  that this comes from a device-id lookup alone (the server deliberately does
  not verify the secret before answering, so a revoked phone reconnecting in a
  loop cannot force a key derivation per retry). It means "a credential naming
  this device was presented", not "the holder proved they are that device".
  Wording only — never key anything else on it.
- `'unknown'` — no such device, **or** a wrong secret on a known one. The two are
  deliberately indistinguishable.

Re-pair on either.

---

## 4. Streaming, and why tickets exist

`EventSource` cannot set headers. Rather than put a never-expiring credential in
a URL, a device trades it for a ticket:

```
POST /api/stream-ticket        (Authorization header, as always)
  → 200 {ticket, expiresAt}
  → 403 {error: 'tickets-are-for-devices'}   ← the operator token opens streams with ?token= directly
```

- TTL is about two minutes; `expiresAt` is absolute epoch milliseconds.
- **Reusable, not single-use.** `EventSource` retries the same URL on its own, so
  burning it on first use would make every ordinary reconnect a permanent
  failure.
- Bound to the device. Revoking the device drops its outstanding tickets in the
  same step that cuts its streams — a revocation with a two-minute hole in it
  would not be one.
- Renew on 401 from any stream: take a fresh ticket, reopen, resume from your
  cursor.

### `GET /api/stream?session=<id>&ticket=<t>` — one pane

| Event | Data |
| --- | --- |
| `meta` | `{cols, rows, truncated, omittedBytes}` |
| `snapshot` | base64 of the initial paint |
| `data` | base64 of live PTY bytes |
| `exit` | `1` |
| `agent.liveness` | `{sessionId, state, agent, at}` — what this pane's agent is doing right now |

The first paint is **capped**, and never cut mid-character or mid-escape. When
`truncated` is true, `omittedBytes` says how much history is above — surface it
rather than pretending the buffer starts there.

**`agent.liveness` on this stream is the terminal face's activity header.** Same
event name and same `state` union as the fleet copy in the next section, and the
same live-only rules — no backlog, no replay, no `id:`, so a reconnecting client
shows a neutral header until the next event. Three things are different, and all
three follow from this being a stream you opened for one pane by name:

- **No `/turns` read is needed, and `--allow-transcript` is irrelevant.** The
  fleet copy reaches a device only after it has read that pane's turn view,
  which is itself 403 without that flag. A client that only ever mirrors the
  terminal now gets the header anyway.
- **It is scoped to this pane.** `sessionId` always equals the `session` you
  opened with; it is carried so a client holding several streams can route the
  frame without tracking which reader it came from.
- **There is no `tool` field, ever.** The tool name is text the agent itself
  wrote, and widening the STATE to a pane mirror is the point while widening
  what the pane is typing is not — the same narrowing `/api/sessions` applies to
  its `liveness` field. Read `tool` off `/api/events` or not at all. `state`
  still reaches you as `tool` or `awaiting_permission` — render those as plain
  "working" and "waiting for you" here, never as a header with a hole where a
  tool name was going to go.

Liveness is a state rather than a "something changed" ping, so a duplicate frame
is idempotent: a client showing the same pane in two places can render both
copies and land in the same place. Render an unrecognised `state` as a neutral
"working" — the union is additive. The brain pane and any session the daemon
does not have are refused here, so a frame you receive always names your pane.

### `GET /api/events?ticket=<t>` — fleet-wide attention

Send `Accept: text/event-stream`. The same path without that header is a plain
JSON backlog fetch (Bearer only).

| Event | Data |
| --- | --- |
| `reset` | `{epoch, headId}` — **resync now**, discard your cursor |
| `critical` | `{...payload, tier, id, epoch}` |
| `notify` | `{...payload, tier, id, epoch}` |
| `approval` | `{sessionId, approvalId, phase, state, agent, createdAt, tier, risk?, ...}` |
| `transcript.nudge` | `{sessionId}` — the turn view for that pane has new content; re-fetch |
| `agent.liveness` | `{sessionId, state, tool?, agent, at}` — what the pane is doing right now |
| `gate.state` | `{gateEnabled}` — the permission gate was armed or disarmed |

`phase` is `create` / `resolve` / `expire` / `supersede`.

`state` is `busy` / `tool` / `awaiting_permission` / `awaiting_input` / `idle`,
and the union is **additive** — render an unknown state as a neutral "working"
rather than dropping the event, the same rule `TurnEventKind` follows. `tool`
carries the tool name when the daemon knows it, and only for the two tool
states. `at` is the ms epoch the state was entered: render elapsed time from it
rather than from when the event arrived, because the event may have waited out a
coalescing window.

Use this for a persistent activity header, and **do not derive that header from
the turn snapshot instead**. An agent that stalls mid-turn writes nothing, so a
snapshot-derived header cannot tell a stalled pane from a thinking one; this
channel can, because it is fed by the agent's own hooks.

`gate.state` fires when any device (or the operator) flips the permission gate,
which is daemon-wide state: without it, the other phones' toggles keep showing
what was true before. It is live-only like the two above — `GET /api/config`
holds the authoritative value, so read that on reconnect rather than trying to
replay transitions.

**These three events are the ones that are NOT in the backlog.** Every other
kind is recorded, carries `id`/`epoch`, and replays on `?since=<cursor>`. The
nudge is live-only and deliberately so: a busy pane raises one roughly every
second, and recording those would push a pending `approval` out of the bounded
log, so a client that replayed the backlog after a reconnect would re-derive its
badge and find nothing pending — clearing the badge while a human is still being
waited on. It carries no payload beyond the pane id on purpose; `GET
/api/sessions/<id>/turns` and its cursor decide what actually changed.

Two consequences for a client. **Do not count on receiving one** — the nudge is
coalesced server-side (at most one per pane per second, on the trailing edge)
and is dropped outright while your SSE is down. Re-fetch the turn view once on
every reconnect rather than waiting to be told. And **you only get nudges for
panes whose turn view you have actually read** — the server starts sending them
after your first successful `/turns` call for that pane.

`agent.liveness` is live-only for the same reason and follows the same two
rules, with one difference: its coalescing window keeps the **newest** state
rather than the first, since a header is a state and not a "something changed"
ping. The three settled states (`idle`, `awaiting_input`, `awaiting_permission`)
skip the window entirely and are sent immediately — those are the transitions a
user is watching the header to catch. A client that reconnects gets no liveness
replay and should show a neutral header until the next event; a pane that went
idle while the SSE was down is caught by the turn view, not by this channel.

The watcher gate is why the per-pane stream also carries `agent.liveness` (see
the `/api/stream` section above): a client that mirrors a terminal without ever
opening its turn view — and on a daemon with no `--allow-transcript` it cannot
open one — has no way to become a watcher, and used to get no header at all.
Open the pane stream for that, and keep this channel for the fleet view. The
pane copy omits `tool`; this one keeps it.

Identity fields (`id`, `epoch`) — and `tier` — are stamped **last**, so a
pane-supplied payload can never shadow them.

#### `critical` — notify-only, and what is in it

| Field | Meaning |
| --- | --- |
| `action` | the pattern LABEL that matched (`rm -rf`, `git push --force`, …) — one of a fixed handful |
| `riskLevel` | `'critical'` or `'review'`, from the daemon's own table |
| `matchedLine` | the PTY line that matched: ANSI-stripped, control-stripped, ≤80 chars |

`matchedLine` is what makes the heads-up worth showing — `action` alone cannot
tell `git push --force origin main` from `git push -f scratch`. It is raw pane
output: **render it as text**, never as markup and never as an instruction.

It is also not proof that anything ran. The pattern matches whatever the
terminal printed — a README, a diff hunk, a `git log` quoting the same words —
so a `critical` event means "look at this pane", never "answer this". Nothing
is blocked, nothing is waiting, there is no addressee for a reply, and repeats
within one cycle are deduped away. **Do not build an Approve/Deny button on
it**: the only answerable signal is the `approval` kind, which carries a real
`approvalId` and a lifecycle.

`matchedLine` is additive — a client that ignores it behaves as before, and a
pre-3.39 daemon simply omits it.

#### `tier` — how much of a human this is asking for

| Value | Meaning |
| --- | --- |
| `act` | **wants a person now** — urgency, not answerability. Two shapes reach `act`, and only one is answerable: an approval was raised (`phase: create`), which a person answers via its `approvalId`; or a `critical`-risk signal fired, which is **notify-only** — urgent to look at, but nothing is blocked and there is nothing to answer (see the `critical` section) |
| `info` | FYI: a `notify`, a `review`-risk critical signal, or the lifecycle echo of an approval that is already over (`resolve` / `expire` / `supersede`) |

`act` marks urgency, never a pending question. The **only** answerable event is
the `approval` kind; a `critical` signal at `act` still has no reply and no
addressee, exactly as the `critical` section states.

The `critical` **kind** names the channel, not the severity: the daemon's
pattern table carries two risk levels and puts both on it, so `DELETE FROM` and
`kubectl delete` (`riskLevel: 'review'`) arrive beside `rm -rf` and `terraform
destroy` (`riskLevel: 'critical'`). Only the latter are `act`. Anything other
than the exact literal `'review'` — including an absent value — is treated as
`act`, because the failure that matters is a destructive action delivered
quietly.

Server-authoritative, so urgency is decided in one place instead of re-derived
by each client. Map it to your own platform's notification model — the daemon
deliberately does **not** put a platform's vocabulary on the wire (no
`timeSensitive`, no channel ids): the wire states the fact, the client owns the
policy.

**Additive.** A client that ignores `tier` behaves exactly as before; `kind`
still means what it always meant. Treat a missing or unrecognised value as
`info` on a `notify` and as `act` on a `critical` — never fail a frame over it.

#### The cursor, and the reset you must honour

Each event carries an SSE `id:` of `<epoch>:<n>`. `epoch` is a fresh UUID per
daemon process; `n` never rewinds within one.

Resume with the standard `Last-Event-ID` header, or `?since=<epoch>:<n>` after a
cold start.

**A `reset` means you have a gap.** It fires when the epoch changed *and* when
your cursor sits below what the server still retains — the log keeps 100 entries
for 30 minutes, so a phone that slept through a busy stretch gets one. On
`reset`, drop local state and re-fetch; do not treat the events that follow as
contiguous with what you last saw.

The JSON shape of the same window:

```
GET /api/events?since=<cursor>     (Bearer)
  → 200 {epoch, headId, reset, events: [{...payload, tier, id, kind, at}]}
```

---

## 5. Panes

```
GET /api/config    → {allowInput, allowUpload, allowTranscript, liveActivityPush?,
                      gatedTools, gateEnabled?, fleetSidebar?, protocolVersion,
                      minProtocolVersion, serverVersion}
GET /api/sessions  → {sessions: [{id, cwd, spawnCwd?, cols, rows, state, agent, lastActivity,
                      workspace?, workspaceId?, shell?, lastDetectedAgent?, cwdLeaf?,
                      liveness?, lastAssistantText?, surfaceTitle?, paneName?}]}
POST /api/input?session=<id>   body: raw bytes
```

`agent` is null when the pane is not running one; `shell` then says what to call
it.

Every `?` field above is **additive and optional**, and absent always means "not
known" rather than a value. Naming a pane is a fallback chain — `agent`, then
`shell`, then `cwdLeaf` — and a client that ignores all of them behaves exactly
as it did before they existed.

`lastDetectedAgent` is the canonical slug of the agent the daemon last detected
in the pane (`claude`, `codex`, …). It exists because `agent` is a mixed
vocabulary — creation-time role metadata for some panes, this same slug for
others — so a client holding only `agent` cannot tell an unlabelled agent pane
from a plain shell, which is how every shell pane's chip collapsed to one word.
Two rules: treat an unrecognised value as "some agent" (the set is not closed on
the wire), and read it as **identity, not presence**. It is persisted, so it
outlives the agent process and every reboot — a pane that ran Claude keeps
saying so while the shell sits at a prompt. What is running *now* is `liveness`
and the `agent.liveness` frames, never this.

`spawnCwd` is the directory the daemon actually started the pane in. Unlike
`cwd`, which follows OSC 7 and the prompt and can name a deleted worktree or a
remote path, it existed when the shell started. Prefer it when choosing a
directory to open a new pane in. Absent for a session record that predates it.
A WSL pane's `spawnCwd` is a Linux path inside its distro.

`cwdLeaf` is the last segment of `cwd`, absent when there is no readable one —
an empty cwd, a root (`/` and `C:\` alike), or whitespace.
It is the label of last resort, computed once by the daemon so every client
agrees on it. Like `cwd` it is the directory the pane's own process last
claimed, so it is a label and never a path to act on.

`workspaceId` is the pane's workspace id — the same id `GET /api/workspaces`
lists — read from the pane's spawn environment. It comes from the daemon, so it
is present with or without the desktop app; it is absent only for a pane with
no wmux workspace. It is an address, never a label: `workspace` stays the name.
`surfaceTitle` and `paneName` come from the desktop sidebar and are present
only while the desktop is attached; see *Desktop sidebar fields* below.

`liveness` is `{state, at}` — the last agent state the daemon saw, with the same
`state` union as the SSE event and no `tool`, dropped once a `busy`/`tool` state
is too old to believe. `lastAssistantText` is a one-line cut of the agent's last
message; it rides `--allow-transcript` and is absent until the first poll after
the transcript changed.

`gatedTools` lists the tools whose calls wait for a remote answer, so a client
can say *why* something is pending. `gateEnabled` says whether that gate is
armed at all — it is what a settings toggle should open showing. **Absent is not
`false`**: a daemon that predates the field simply does not report it, and the
gate defaults to on, so treat a missing key as "unknown" and not as "off". The
gate is daemon-wide rather than per-device, so a change made from one phone
applies to every device; see `gate.state` above for the push that keeps them in
step, and re-read this route on reconnect for the authoritative value.

`POST /api/input` is **403 unless the server was started with `--allow-input`**.
Check `/api/config` and hide the keyboard rather than letting a user type into a
403. `fetch` resolves on 401 and 403 — a lone `.catch()` sees neither, which is a
mistake the browser client made and shipped.

It is **409 `{"error":"terminal-prompt-active","effect":"none"}`** while the pane
shows the agent's own permission dialog (a pending `terminal_prompt` record),
except for a lone Esc or a lone Ctrl-C — see
[`terminal_prompt`](#terminal_prompt--the-agents-own-permission-dialog).

Phone scrolling has two ownership modes. A terminal's normal buffer is local
scrollback and must remain local (ordinary shells and Kiro use this path).
Alternate-screen TUIs have no terminal scrollback. With `--allow-input`, a
vertical phone drag may send line-granular wheel events only while the remote
TUI has negotiated mouse reporting, and only encoded with that negotiated
protocol. If no mouse mode is active and no wheel event was sent, the completed
swipe may fall back to standard `PgUp`/`PgDn` terminal navigation. Claude Code's
fullscreen renderer documents both wheel scrolling and those keys for its
app-owned conversation history. Without `--allow-input`, send neither; never
forward generic taps or drags, guess a mouse protocol, or pretend the alternate
buffer is locally scrollable.

### Resizing a pane — the desk owns the size while it is actually showing it

```
POST /api/sessions/<id>/resize   body: {cols, rows}
  → 200 {cols, rows, owner: 'caller'}
  → 400 {error: 'bad-geometry'}          cols 40..1000, rows 8..1000, integers
  → 404 {error: 'session not found'}
  → 409 {error: 'desk-owns-size', cols, rows, owner: 'desk'}
  → 409 {error: 'resize-failed', detail} dead, suspended, or still recovering
  → 429 {error: 'resize-too-often', cols, rows, retryAfterMs}
```

A desk pane is commonly 151×47, and no readable phone font fits 151 columns. The
wrapping happens in the PTY, before any client sees a byte, so the daemon is the
only thing that can fix it.

**Ownership.** There is one PTY behind both views and it can have one geometry.
While a desk renderer has the pane wired (`state: 'attached'` in
`/api/sessions`) **and is actually showing it** — the pane's workspace and tab
are active and the window itself is visible — that geometry is the desk's: the
409 carries the current `cols`/`rows` so you can render to them without a
second request. A `detached` pane takes your numbers, and so does an attached
pane the desk is not looking at (background workspace, inactive tab, minimized
window): nobody is watching the layout your numbers would break. You cannot see
the desk's visibility in `/api/sessions` — the probe is the request itself. You
do not have to hand ownership back — a desk client re-derives its geometry from
its own bounds and resizes on attach and on every reveal, silently taking the
size back the moment somebody looks.

Do not treat the 409 as an error to retry in a loop. It is the answer: render
at the size it names. A fresh attempt is reasonable when something on YOUR side
changed (the pane was reopened, your viewport rotated) — the desk may have
stopped looking since.

**Render at the geometry in the 200, not at the one you asked for.** The daemon
answers with what it stored, which is not promised to equal the request.

**Debounce, and bound the geometry.** One session accepts a resize at most every
250 ms; anything sooner is `429` carrying `retryAfterMs` and the pane's current
size. This is not only about load — every accepted resize arms the daemon's
redraw guard, and a client resizing in a tight loop can stop new approvals from
being detected at all. Drive this from settled layout, never from an animation
frame.

The floor is `cols >= 40`, `rows >= 8` — well above the 10/2 the daemon itself
tolerates. That lower pair only promises the shell will not crash; a pane driven
to 10 columns hard-wraps everything it prints, and scrollback does not re-flow,
so those bytes stay ruined after the desk takes its size back.

The route is additive, so it does **not** move `protocolVersion` (§1). A daemon
that predates it has no such route and answers 404 for a pane you just listed —
which is the probe: treat a 404 for a live id exactly like the 409, render at the
pane's own `cols`/`rows`, and do not ask again this connection.

Available **without `--allow-input`**, unlike the keyboard and the two lifecycle
routes below: this delivers a SIGWINCH and changes two numbers. No byte reaches
the child's stdin and nothing is executed. The Bearer gate still applies.

### Creating and closing panes

```
POST   /api/sessions            body: {workspaceId?, cwd?}  → 201 <session row>
DELETE /api/sessions/<id>                                   → 204
```

Both are **403 without `--allow-input`**, same as the keyboard — an interactive
shell is arbitrary execution, and closing a pane destroys running work. Gate the
UI on `/api/config` exactly as you gate the keyboard.

`POST` answers with a single session row in the same shape `/api/sessions`
returns, so append it to the list rather than refetching. Omit `cwd` for the
home directory.

`workspaceId` stamps the new pane's workspace identity, so it is checked twice
before it is used. It must match `^[A-Za-z0-9_-]{1,64}$`, and **it must be a
workspace some live pane is already running in** — the daemon owns no workspace
registry (the desktop does), so a running session carrying the id is the only
evidence available to it that the workspace exists. Either check failing is a
400 (`invalid-workspace-id` / `unknown-workspace-id`) and nothing is spawned.
The consequence is real and accepted: a genuine workspace whose panes are all
closed cannot be named until one is open. Omit the field to spawn outside a
workspace — that always works. The human-readable label is copied from the same
live pane.

409 means the daemon refused (session cap, memory pressure, shutdown in
flight); `detail` is operator-facing copy worth showing verbatim. 404 on DELETE
means the pane is already gone — treat it as success.

A pane created this way is a real daemon session: it is listed, streamable,
typeable, monitored and recovered. It has **no pane in the desktop GUI's
layout** — only the renderer can create one of those, and the daemon
deliberately cannot reach it.

### What did this agent change?

```
GET /api/sessions/<id>/diff  → 200 {files: [{path, status, from?}], patch,
                                    truncated, omittedBytes, patchIncomplete}
                               409 {error: 'not-a-git-repo'}
                               429 {error: 'busy'}
                               500 {error: 'git-failed'}
```

Read-only, and **available on a read-only server** — it runs `git diff`,
`git diff --cached` and `git status` in the pane's own working directory and
returns text. Nothing in the request names a directory or a ref. The response
is `Cache-Control: no-store`: it is the payload an approval is decided against
and must never be replayed from a cache.

`status` is the raw two-character porcelain code (`' M'`, `'M '`, `'??'`, `'R '`,
`'UU'`, …): the index column and the worktree column are independent and any
one-word summary loses one of them. `patch` is the staged patch, then the
working-tree patch, then an add-hunk for each untracked file (the first 20 of
them). It is capped at 512 KB, and `truncated` says the tail was cut.

**`patchIncomplete` is the flag you must not ignore.** It means `files[]` is
accurate but `patch` is missing content for a reason that is *not* the cap: a
git command timed out or failed, there were more than 20 untracked files, the
untracked pass ran out of its overall time budget, an untracked entry was a
whole directory (a nested repository, or an unreadable one) that has no single
file to render, or **the tree changed while the diff was being collected** —
the pane's own agent staging a file mid-read produces a change that is in
neither patch. Do
not render a `patchIncomplete: true` response as a diff a human can approve
against — say the patch is partial and offer the desktop. `truncated` and
`patchIncomplete` are independent: `truncated` alone means "you have the first
512 KB of a complete patch", which is a normal thing to show.

The directory read is the one the pane was **spawned** in, not the one it is in
now. A `cd` inside the pane does not move the diff. That is deliberate: the live
directory is tracked from terminal escape sequences, which any process in the
pane can emit, so acting on it would let a pane point this route anywhere on the
machine.

| Status | Body | Meaning |
| --- | --- | --- |
| 409 | `{error: 'not-a-git-repo'}` | **Normal.** Panes run in `~`, in `/tmp`, in scratch directories. Say "no repository here", not "something went wrong". Only returned when git ran and said so — a repository that EXISTS but is broken (malformed config, dubious ownership, unreadable metadata) is a 500, not this |
| 429 | `{error: 'busy'}` | Too many diffs in flight (the daemon collects at most two at once). Retry; do not treat it as an error state |
| 500 | `{error: 'git-failed'}` | git could not be run, or timed out, or the tree could not be described. Deliberately carries no detail — git's stderr names paths, remotes and config keys, and the operator has it in the daemon log. Retry once, then offer the desktop |

Concurrent requests for the same pane are coalesced into one git run and all
receive the same answer, so a client that retries on reconnect costs nothing
extra.

### What did this agent say? — the turn view

```
GET /api/sessions/<id>/turns[?cursor=<opaque>][&dir=forward|back]
  → 200 {available: true, events: [...], cursor, hasMore, truncatedHead?}   (snapshot)
  → 200 {available: true, events: [...], cursor, reset, budgetDropped?}     (forward delta)
  → 200 {available: false, reason}
  → 403 {error: 'transcript-disabled: …', detail: 'restart with: …'}
  → 404 {error: 'session not found'}
  → 503 {error: 'transcript projector unavailable'}
```

The pane's Claude Code conversation — the same session the desktop Chat View
reads, reflowed to phone width. It is the alternative to squinting at an
80-column mirror.

**The grant is its own flag.** `--allow-transcript`, not `--allow-input` and not
`--allow-upload`. The transcript is the whole session: thinking blocks, full tool
inputs, the contents of files the agent read. That is far wider reading than a
mirror of the visible screen, and a device credential never expires, so a leak
here is a category change rather than an increment. Gate the tab on
`allowTranscript` from `/api/config`, and match the 403 by **prefix** — the prose
after the colon may be reworded, the `transcript-disabled:` tag may not. A daemon
predating this route has no `allowTranscript` key at all; read a missing key as
`false` and fall back to the mirror without probing the route.

**Paging.** No `cursor` means "give me the latest": a snapshot of the tail.
`dir=back` with a cursor pages further into the past from that cursor's head —
that is your infinite scroll upward. `dir=forward` (the default) with a cursor
asks only for what was appended after it, which is what you call on a nudge.
`hasMore` on a snapshot says there is older content behind it. `truncatedHead`
says the response itself starts mid-history.

**The cursor is opaque. Do not parse it, do not synthesize one.** It encodes byte
offsets into a file you cannot see, and the server uses them to decide whether
your next read is a clean append. Store the string, send it back verbatim.

**`reset: true` means replace, not append.** The transcript was truncated or
rewritten under your cursor, so the server answered with a fresh snapshot instead
of bytes stitched onto a conversation that no longer exists. Throw away what you
had and render the response as the new whole. Detection is best-effort by design
— an in-place rewrite that happens to leave your exact offset intact is not
caught — so treat a conversation that suddenly reads wrong as a reason to re-fetch
without a cursor, not as a bug to work around.

**`budgetDropped: true` means a row is missing on purpose.** One entry was larger
than the server's serialization budget, so the cursor advanced past it with no
row emitted. Render a visible "content omitted" seam. The stream is intact; that
one entry is not, and silently closing the gap makes the conversation read as
though it never happened.

**`available: false` is a normal answer, not an error** — that is why it is a
200. The `reason` set is open (treat anything you do not recognise as simply
unavailable), and today it is:

| `reason` | Meaning |
| --- | --- |
| `no-hook` | No agent detected on this pane, so the wmux hooks never fired here. The fix is the operator running `wmux setup-hooks` — say that |
| `stale-session` | An agent IS running but no binding was captured yet: the pane started before the hooks were armed, or its first turn has not ended. Retry later; do not send the operator to `setup-hooks` |
| `no-transcript-path` | The session is bound but the first turn has not ended, so the file does not exist yet. Transient — this becomes available on its own |
| `not-claude` | The agent publishes no transcript. A permanent no for this pane; hide the tab rather than showing an empty one |
| `unsafe-transcript-path` | The recorded path fell outside the directories the daemon will read. Not retryable, and not something a client can fix |
| `unreadable` | The file is bound and in bounds but could not be read right now |

`503` is different from all of these: the daemon has no projector wired at all
(nothing to read from, on any pane). `404` is the same contract as the other
`/api/sessions/<id>/*` routes — the pane is gone, which is not the same as its
conversation being unavailable.

**Reading is stateless.** Nothing you do here touches the desktop Chat View
watching the same pane — no subscription, no shared cursor. Two devices and a
desk can read one session at once and none of them can move the others.

#### Opening a code block or a tool body

```
GET /api/sessions/<id>/turns/block?srcOffset=<n>&n=<n>[&eventId=<id>]
  → 200 {body, bytes, truncated?}
  → 400 {error: 'bad-block-ref', detail}
  → 403 {error: 'transcript-disabled: …'}
  → 404 {error: 'session not found'} | {error: 'block not found'}
  → 503 {error: 'transcript projector unavailable'}
```

Turn pages never carry large bodies. A fenced code block arrives as a chip
(`codeBlocks: [{n, lines, lang, path?, srcOffset}]`, with the prose carrying an
inline ` code:<n> ` marker where it belongs), and a tool body over the
inline cap arrives as `{n, bytes, inline?, truncated, srcOffset}`. Both are
handles: pass the ref's `srcOffset` and `n` here when the user expands one.

Send `eventId` — the id of the event the ref came from — whenever you have it.
Transcripts rotate, and without it an offset from an older file can resolve
inside a different conversation. The server re-reads that one transcript line
per request and caches nothing, so expanding the same block twice is two reads
rather than a stale copy.

`bytes` is the body's true size. `truncated: true` means what you got is only
its head (the server caps one body at 256 KB) — say so in the UI rather than
letting someone copy a shortened body out believing it is whole.

**`404 block not found` never means "the block was empty".** It means the ref
did not resolve, and there are two reasons it might not. Usually the ref is
stale — the file rotated, or the offset no longer starts a line — and re-fetching
the turn page fixes it. But the daemon also reads one transcript line up to a
fixed ceiling, so a block inside an unusually large entry (roughly half a
megabyte of JSON) cannot be parsed at all and answers 404 permanently. Re-fetch
once; if the fresh chip 404s again, show the block as unavailable rather than
retrying, and keep the chip's `lines`/`lang` visible so the user still sees what
is there.

#### Loading an image the transcript named

```
GET /api/sessions/<id>/turns/image?path=<absolute path>
  → 200 image/png | image/jpeg | image/gif | image/webp  (Cache-Control: no-store)
  → 400 {error: 'bad-image-ref', detail}
  → 403 {error: 'transcript-disabled: …'}
  → 404 {error: 'session not found'} | {error: 'image not found'}
  → 413 {error: 'image-too-large', detail}
  → 415 {error: 'not-an-image', detail}
```

A turn page names image files but never carries their bytes: a `Read` or `Write`
tool input holds a `file_path`, and a photo you uploaded rides the user's own
text as the path `/api/upload` handed back. This is how you turn one of those
names into a thumbnail.

**Same grant, same tag.** `--allow-transcript` opens this route and nothing
else; `--allow-transcript` already grants "the contents of files the agent read",
so an image out of the same directories is not a wider reader. Match the 403 by
the `transcript-disabled:` prefix exactly as on `/turns`.

**Gate on `turnImages` from `/api/config`**, which is present (and `true`) only
on a daemon that both has this route and has the transcript grant armed. A daemon
predating it omits the key; read a missing key as `false` and render the filename
chip without fetching. That is one decision per connection instead of a 404 per
thumbnail.

**Two directories, and only two.** The pane's **spawn** cwd — where the daemon
actually started it, not wherever the pane's own process has since claimed to be
via OSC 7 — and the uploads directory. Anything else is `404 image not found`,
and so is a symlink inside those directories pointing out of them. Note what the
boundary implies in practice: a screenshot on the Desktop, or a temp file under
`/var/folders`, is not servable, and an agent that `cd`s out of its spawn cwd
does not widen it. Fall back to the filename chip.

**`404 image not found` is deliberately one answer for four situations** —
outside the boundary, missing, a directory, unreadable. A separate code for
"outside" would confirm to a caller that the file exists, which is exactly the
mapping this route must not offer. It IS worth one retry: a `Write` the agent has
not finished yet is the common case, and the file appears on its own.

**The bytes decide the `Content-Type`.** PNG, JPEG, GIF and WebP by leading
bytes; anything else is 415 no matter what the path ends in. 415 and 413 (the cap
is 8 MiB, and an image is not truncatable) are permanent for that file — show the
chip and stop asking.

Responses are `no-store`. Cache the bytes in your own process for as long as the
session is open if you like, but revoking the transcript grant must not leave a
replayable copy in a browser or a proxy.

#### Loading a video (or any media file) the transcript named

```
GET /api/sessions/<id>/turns/file?path=<absolute path>
  → 200 video/mp4 | video/quicktime | image/png | image/jpeg | image/gif | image/webp
        (Cache-Control: no-store, Content-Length, streamed)
  → 400 {error: 'bad-file-ref', detail}
  → 403 {error: 'transcript-disabled: …'}
  → 404 {error: 'session not found'} | {error: 'file not found'}
  → 413 {error: 'file-too-large', detail}
  → 415 {error: 'unsupported-type', detail}
```

The same reading as `/turns/image`, widened to the files an agent PRODUCES
rather than only the ones it can draw: a screen recording, an ffmpeg render.
`/turns/image` answers 415 for those, which is why this route exists instead of
that one growing.

**Everything about the gate is identical** — same `--allow-transcript`, same
`transcript-disabled:` prefix on the 403, same two directories (the pane's
**spawn** cwd and the uploads directory, never `meta.cwd`), same single answer
for outside/missing/directory/unreadable. Only the tag differs: `file not found`
and `bad-file-ref`, so a client's two error maps — and its logs — never collapse
the routes into one.

**Gate on `turnFiles` from `/api/config`**, exactly as you gate the image route
on `turnImages`. A daemon predating this route omits the key; read a missing key
as `false`.

**The bytes decide, and the brand decides which video.** An ISO BMFF `ftyp` box
with a `qt  ` major brand is `video/quicktime`; `isom`, `iso2`, `iso4`, `iso5`,
`iso6`, `dash`, `mp41`, `mp42`, `avc1`, `mp4v` and `M4V ` are `video/mp4` — the
`iso4`–`iso6` and `dash` brands are what a fragmented mp4 carries, which is what
an agent rendering for streaming produces. Audio-only containers are not served. If you name a cache file from this
header, that split is load-bearing: a QuickTime movie saved as `.mp4` will not
open.

**Two caps, by kind**: 8 MiB for an image (the same one `/turns/image` enforces),
128 MiB for a video. The refusal names the cap and never the file's real size.

**The sniff runs before the cap**, because which cap applies is a fact about the
type. So a 200 MB text file is `415 unsupported-type`, not `413`. Both are
permanent for that file, but they are not the same message: 415 will never
succeed, while 413 is a limit worth naming to the user.

**Ranges are not supported and `Accept-Ranges` is not advertised.** Download the
file, then play it locally. A seek against this route is a fresh whole-file GET,
which is not what you want on cellular.

**The response can be cut mid-body, and only in one direction.** The route
streams exactly the number of bytes it measured before the first header. If the
file SHRANK under the transfer, fewer bytes exist than the `Content-Length`
already promised, and the connection is closed rather than finished — treat that
as a transport failure and retry once. A file an agent is still writing is the
common cause, and the retry succeeds on its own once the write lands.

A file that GREW is not an error and is not cut. You receive the prefix that was
there when the request was gated, whole, with a `Content-Length` that matches
it — the extra bytes simply are not in this response. Fetch again if you want
them.

---

## 6. Approvals

The reason the app exists. When a Claude Code pane raises an `AskUserQuestion`
prompt, the daemon records a request any authenticated surface can answer.

```
GET  /api/approvals          → {pending: [...], recentlyResolved: [...]}
POST /api/approvals/<id>     body: {decision: 'approve' | 'deny', choiceKey?: string}
```

Request fields: `id`, `sessionId`, `agent`, `kind`, `state`, `createdAt`, and
optionally `workspaceId`, `question`, `options`, `choices`, `risk`, `screenTail`,
`decision`, `resolvedBy`, `resolvedAt`, `selectedChoiceKey`. A
`kind: "terminal_prompt"` record has its own field set and rules — see
[`terminal_prompt`](#terminal_prompt--the-agents-own-permission-dialog) below.

`kind` is an open set: `awaiting_input` (an `AskUserQuestion`),
`awaiting_permission` (a permission gate), `terminal_prompt` (the agent's own
terminal dialog). Treat an unknown kind as a card you cannot answer.

`question` and `options` are the agent's own text, sanitized and capped. Render
them — a blind Approve button is not an informed answer.

### `choices` — structured option keys for per-option resolution

`choices` is an array of `{key, label}` objects, present when the daemon
extracted usable options from the `AskUserQuestion` payload. Each `key` is the
1-based digit ('1', '2', …) that selects that option in Claude Code's TUI,
preserving the original index even when unlabeled entries are dropped from the
legacy `options` array.

A client that supports per-option buttons sends `choiceKey` in the resolve body
instead of relying on the default first-option mapping. This is strictly opt-in:
omitting `choiceKey` preserves existing behavior byte-for-byte.

### `choiceKey` — selecting a specific option on resolve

```json
POST /api/approvals/<id>
{
  "decision": "approve",
  "choiceKey": "2"
}
```

When present:
- The daemon validates `choiceKey` belongs to the stored request's `choices` set.
- The screen re-verify confirms the corresponding option row is visible.
- Exactly that digit is sent to the PTY — no CR, same as default approve.
- On success, `selectedChoiceKey` is persisted on the resolved history record.

When absent:
- Existing behaviour: approve sends '1' (first option), deny sends ESC.
- Byte-for-byte identical to clients that predate this field.

Malformed keys (empty, non-string, non-digit, or attached to `deny`) return
400 `{error: 'invalid-choice-key'}` before the registry is called. A well-formed
but unknown or stale key returns 422 with the same error. In both cases the
request stays pending — no default option is pressed.

### Agent support — Claude native, others terminal-only

Claude Code's `AskUserQuestion` prompt is natively supported: the daemon
extracts the question, options, and structured choices from the hook payload and
maps resolve decisions to precise TUI keystrokes.

Claude Code's own **permission dialog** ("Do you want to proceed?") is recorded
as a `terminal_prompt` — see the next section for when it can be answered from
the phone and when it cannot.

**Codex CLI, Kiro CLI, and other TUI-only agents** have no hook integration and
no authoritative keystroke mapping. They report `unsupported-agent` (501). Their
prompts are answered with the phone pane's terminal controls when `--allow-input`
is enabled, or at the desktop otherwise. Structured choice
support for these agents will be added only after their respective projects
expose authoritative approval hooks — the daemon does not guess keystrokes.

### `terminal_prompt` — the agent's own permission dialog

When a Claude Code pane (`claude` / `openclaude`) shows its own permission
dialog — for example a `permissions.ask` rule hit in a `bypassPermissions`
session — the daemon records `kind: "terminal_prompt"`. It appears when the
PermissionRequest hook lands, or when the screen detector's awaiting-input
reading survives its 1.5 s confirmation window, whichever comes first, and only
when the pane has nothing else pending. The daemon reads the pane's screen and
parses the dialog at that moment; when the hook landed before the dialog was
drawn, it looks again and replaces the record with an answerable one (a new
`id`, an `approval` event, no second push). The orchestrator brain's pane never gets one.

**Capability.** Send `X-Wmux-Client-Caps: terminal-prompt-answer` (a
comma-separated token list; unknown tokens are ignored) on `/api/approvals`,
`POST /api/approvals/<id>`, `/turns` and `/api/events` if your client can answer
this dialog. Without it you get the informational card only.

What `/api/approvals` carries for this kind:

| field | older client (no capability) | capable client |
| --- | --- | --- |
| `id`, `sessionId`, `agent`, `kind`, `state`, `createdAt`, `workspaceId?` | yes | yes |
| `toolName` (when known), `summary` (the command, ≤200 chars, display only) | yes | yes |
| `risk` (`critical` when the command or rule reads as destructive — `rm -rf`, `sudo`, …) | yes | yes |
| `question`, `reason` | never | only when the record is answerable |
| `choices`, `promptFingerprint` | never | only when the record is answerable, pending and not yet answered |
| `pressedAt`, `decision`, `selectedChoiceKey`, `resolvedBy`, `resolvedAt` | when set | when set |

Never `options` or `screenTail`. A record is **answerable** only when all of
this holds when it is created:

- the whole dialog was read: its top rule (a full-width rule row at column 0)
  is on screen, no row or field was cut, and it offers a plain `Yes`;
- it is bound to the tool call the agent actually made — the pane's own Claude
  transcript has that call as its latest `tool_use` with no result yet (or the
  PermissionRequest hook carried it), with the same tool and exactly the command
  the dialog shows, and that command fits the 200-character summary.

A dialog found only on the screen, with no pending call to bind to or a call
whose command differs, is **informational for everyone**. `summary` and `risk`
come from the call's own input.

`choices` then holds only the plain `Yes` and a plain `No` (`No`, or `No, …`
such as "No, and tell Claude what to do differently"). An option that writes a
lasting rule — "Yes, and don't ask again for … commands", anything with
"always" or "for this session" — is never a choice. A record that is not
answerable carries none of the four fields for anyone; show it as "answer on
the computer".

`promptFingerprint` is a 32-hex hash of the whole dialog (title, question,
reason, every command line, every option) and the tool call it is bound to,
independent of where the cursor is. The same dialog for the next, identical
call is a different record with a different fingerprint.

**Answering** (capable clients only; `choiceKey` is authoritative, `decision`
must agree with it):

```http
POST /api/approvals/<id>
X-Wmux-Client-Caps: terminal-prompt-answer
Content-Type: application/json

{"decision":"approve","choiceKey":"1","promptFingerprint":"<hex>"}
```

`approve` goes with the plain `Yes` choice, `deny` with the `No` choice. It needs
the device's input grant, like typing (403 `read-only: …` otherwise). The daemon
then refuses unless all of these hold, and writes nothing when it refuses:

- the record is at least 1.5 s old;
- this record has not been answered already (one write per record, ever);
- the call it is bound to is still the pane's pending one;
- the pane's screen, re-read now, still shows the same dialog (same
  fingerprint) as the ACTIVE one: exactly one option selected, the
  `Esc to cancel…` footer directly under the options, nothing but blank rows
  below it;
- no key and no mouse click, release or wheel reached the pane since the record
  appeared (pointer motion and focus reports do not count) — someone at the
  terminal may be answering it;
- no new PTY and no output between that read and the write. Output alone is
  read again once, then it gives up.

On success it writes exactly one byte — the digit, never Enter — and answers
200 `{"state":"pending","pressedAt":<ms>,"durable":true}`. The record stays
`pending` (with `pressedAt`) until the dialog is gone from the screen, then
resolves. An SSE `approval` event with `phase: "press"` marks the write.

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{state:"pending", pressedAt, durable}` | The key is in the pane |
| 400 | `{error:"invalid-prompt-fingerprint"}` | `promptFingerprint` missing or not 32 hex |
| 400 | `{error:"invalid-choice"}` | `choiceKey` missing, not one of `choices`, or `decision` disagrees with it |
| 403 | `{error:"read-only: …"}` | No input grant |
| 409 | `{error:"already-answered"}` | This record was answered from a phone already and is waiting for its dialog to close (`pressedAt` is set). Nothing typed |
| 409 | `{error:"already-resolved", resolvedBy}` | The record already settled — its dialog was answered (anywhere) and has gone. Nothing typed |
| 410 | `{error:"expired", state?}` | The record ended without an answer (turn ended, pane gone, replaced) |
| 409 | `{error:"prompt-changed"}` | The screen is not the dialog you answered (changed, moved, not the active dialog, or a key or click reached the pane since your read). Nothing typed. When the dialog is still up, the record was superseded by a fresh one — re-read `/api/approvals` and confirm again |
| 425 | `{error:"answer-too-soon"}` | Within 1.5 s of the record appearing. Ask again |
| 501 | `{error:"answer-in-terminal"}` | Not answerable remotely: no capability header, or the record is not answerable (checked before the body, so a record without a fingerprint is 501, not 400). Answer on the computer |

Without the capability header every answer is 501 `answer-in-terminal`: show
"wmux cannot answer this agent remotely. Open the pane on the computer."

**Typing cannot answer it.** While the pane has a pending `terminal_prompt`
record (answerable or not, answered-and-waiting included), `POST /api/input` to
that pane is refused with 409 `{"error":"terminal-prompt-active","effect":"none"}`
and nothing is written — a digit, Enter, a paste, a notification "Reply", any
key sequence. The dialog is answered only through `POST /api/approvals/<id>`
above, or at the computer. The one exception is the cancel direction: a body
that is exactly one Esc (`\x1b`) or exactly one Ctrl-C (`\x03`) is written as
usual. Esc followed by anything else (an arrow key, Enter) is refused. The check
runs when the request body completes, immediately before the write, so a dialog
that appeared while the body was in flight still refuses it. With a durable
input receipt the refusal journals nothing: a retry with the same
`X-Wmux-Input-Request-ID` is checked again and writes only once the dialog is
gone. Input flows again as soon as the record leaves `pending` (see *It goes
away* below). A native chat send to the pane is refused the same way, under the
chat route's own code: 409 `chat-blocked` with `blockedBy: "terminal"` (see
*Sending* under *Native chat*).

**A key or click in the pane refreshes the record.** Someone at the terminal
moving the selection (↓, ↑, a click) means what your user confirmed may not be
what is selected, so it is never pressed through. Instead, once the input has
been quiet for about 0.6 s (and at most once every 2 s per record), the daemon
re-reads the dialog and, if it is still up, replaces the record: you get

```
event: approval   {"approvalId":"<old>","phase":"supersede","state":"superseded","kind":"terminal_prompt",…}
event: approval   {"approvalId":"<new>","phase":"create","state":"pending","kind":"terminal_prompt",…}
```

and `/api/approvals` lists the new record with a new `id` and a new
`promptFingerprint` (it also encodes the input epoch), answerable 1.5 s after it
appeared. There is no second push. An answer that races the refresh gets 409
`prompt-changed` and triggers the same replacement. A dialog the input
dismissed is not refreshed into an answerable record; one still visible but no
longer bound to the pending call is replaced by an informational record.

**Push.** One push per awaiting episode per pane — a record replaced within the
episode (a late parse, a changed dialog) carries the push over rather than
sending another or losing it. It is always in-app only (`requiresInAppChoice:
true`, no lock-screen buttons, for any client) and carries
`approvalKind: "terminal_prompt"`. The body names the tool and the command;
`risk` is `critical` when the command or the permission rule reads as
destructive (`rm -rf`, `sudo`, …). The outbound webhook (`notifySinks`) never
carries the command.

**The SSE `approval` event** for this kind carries `kind: "terminal_prompt"` and
`risk` when set, and no content (no tool, summary, question or choices): re-read
`/api/approvals`.

**It goes away** when the dialog is answered (a key in the pane, from anyone),
when the daemon sees the dialog gone from the screen, when the turn ends, the
session restarts or the pane closes, and on a daemon restart. After the screen
check releases a pane, the same dialog is not raised again from the screen
detector for 30 s; a different dialog, or the PermissionRequest hook, still is.

**Awaiting state.** A pane at `awaiting_input` is also released when the daemon
sees its dialog gone from the screen on two reads in a row — an answer typed in
Terminal in a shape the key check does not recognise no longer leaves the pane
"needs you" for the rest of the turn.

### `risk` — a hint, not a gate

`risk: 'critical'` is set at creation when the question or an option label
matches the daemon's destructive-action patterns (the same list that raises the
`critical` attention signal: `rm -rf`, `git push --force`, `DROP TABLE`,
`terraform destroy`, …). It is also carried on the `approval` SSE payload, so a
client can pick its alert style without waiting for the round trip.

Use it to **step up**: Face ID, a second tap, a louder colour. Never to step
down or to withhold. The patterns are regexes over agent-authored prose — they
miss an `rm -rf` described in words, and they fire on a question *about*
dropping a table. A misclassification must never cost a human the ability to
answer the prompt in front of them, and `POST /api/approvals/<id>` behaves
identically either way.

Absence means "no pattern matched", **not** "safe". Only `'critical'` is emitted
today; ignore any other value rather than guessing at it. Additive — a client
that has never heard of the field is unaffected.

### This route works on a read-only server

Deliberately, and it widens nothing else. `--allow-input` grants arbitrary bytes
to any pane at any time; this grants one answer to one request the **daemon**
raised. The caller sends a decision, never bytes: the daemon picks the keystroke
from its own per-agent map and re-reads the pane to confirm the prompt is still
there before writing.

### Responses

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{state, durable}` | Answered. `durable: false` means the keystroke landed but the record did not survive — the answer is real, the history will not show it. Do **not** retry |
| 400 | `{error: 'invalid-choice-key'}` | A supplied choice key is malformed or was attached to `deny`. Nothing is sent |
| 409 | `{error: 'already-resolved', resolvedBy}` | Another surface won. `resolvedBy` names it (`operator`, or `device <name> (<id>)`) |
| 410 | `{error: 'expired' \| 'prompt-gone', state?}` | The request outlived its usefulness, or the prompt left the screen. Stop showing it |
| 422 | `{error: 'invalid-choice-key'}` | The `choiceKey` does not belong to this request's choices, or the option is not visible on screen. The request is still pending — retry with a valid key or omit `choiceKey` |
| 501 | `{error: 'unsupported-agent'}` | No keystroke map for this agent. Still answerable at the desktop — do not expire it locally |
| 404 | `{error: 'not-found'}` | No such request |

Only Claude Code is mapped today. Approve sends `1` (the first offered option),
deny sends ESC. Neither is followed by a carriage return: on a select, the digit
both moves and confirms, and a stray CR would press whatever the TUI renders
next.

**Per-option press via `choiceKey`:** when `choices` is present on the request,
a client can send `choiceKey` to select a specific option rather than always
picking the first. The daemon sends exactly that digit — no CR. This removes the
"blind first option" limitation for clients that render the choice list.

### Lifecycle you must reflect

- One pending request per pane. A re-prompt **supersedes** the old one.
- The pane finishing (`agent.stop`), starting a new session, or dying expires it.
- A daemon restart invalidates everything pending — a recovered pane is a new
  process, and a remembered approval must never type into it.

Fetch `/api/approvals` on connect and on any `approval` event; the SSE is a
nudge, not the source of truth.

---

## 7. Push

Notifications are sealed **on the machine that sends them**, before they reach
the relay the project operates. The relay cannot read them; the Notification
Service Extension decrypts on-device and rewrites the alert.

**One exception, and it is not a notification body.** Live Activity updates
(below) cannot be sealed: a Live Activity push never runs the Notification
Service Extension, so there is no place on-device to decrypt an envelope. Those
carry six plaintext integers — pending approvals, blocked panes, oldest blocked
minutes, and the running/working/idle agent counts — and nothing else. No pane
name, no workspace name, no question text, no preview. "The relay cannot read
them" stays true of every notification **body**; what the relay can read on the
Live Activity route is a set of counters.

**One more plaintext field, and it is a name.** A `start` also carries
`attributes.daemonName` — the daemon's **hostname**, cut to 64 characters — so
the activity has something to call the machine it is reporting on. It reaches
the relay and Apple in the clear, exactly as the counters do. Hostnames are
often a person's name or an employer's, so this is the one identifying string on
the route; it is sent only on a `start`, never on an update.

**The app owns the key.** At registration the phone generates an X25519 key
pair, keeps the private half in the Keychain, and registers only the 32-byte
public half. The daemon stores a public key and nothing secret, so the device
roster stays worthless to anyone who reads it — which is the property the whole
credential design rests on. Each notification also carries a fresh ephemeral
sender key, so a daemon compromised later cannot decrypt notifications captured
earlier.

(The original design derived one AES key from the pairing secret. That was not
buildable: `DeviceStore` never persists that secret, by design.)

Byte-exact format, a CryptoKit skeleton, and a known-answer vector:
`src/shared/push/pushEnvelope.ts`. Implement the extension against the vector —
it proves compatibility without a device, and its X25519 keys are RFC 7748 §6.1's
published pair, so a key-handling bug shows up against the spec rather than
against our own output.

The five things that break compatibility silently, all spelled out in that file:
HKDF with a **zero-length salt** and `info = "wmux:push:v1" || epk || spk` in
that order; the timestamp interpolated into the AAD as an **integer, not a
float**; standard base64 **with** padding (not base64url); a 12-byte nonce; and a
byte-for-byte, case-sensitive `deviceId`.

The decrypted plaintext is additive JSON: `title`, `body`, optional
`approvalId`, optional `sessionId`, optional `requiresInAppChoice`, and `risk`.
When `requiresInAppChoice` is true, the Notification Service Extension must use
an affirmative-free category: the person has to open the app and pick a
structured choice. Older payloads omit the field and older extensions ignore it.

`risk` is the **one field whose sealed meaning differs from its REST meaning**.
On `/api/approvals` it is omitted when no pattern matched (§6, "a hint, not a
gate"). Here it is always present on an approval — `'critical'` or `'normal'` —
because the extension has no store to consult and cannot tell a daemon that
predates the field from one that judged the approval ordinary. It therefore
withholds the lock-screen Approve button unless a value positively says
`'normal'`: a missing field costs somebody a trip into the app, a wrong guess
costs a destructive command approved from a locked pocket. Adding a third level
is a two-sided change — the extension grants the affirmative to everything that
is not `'critical'`, so a new level shipped daemon-side alone reads as ordinary.

Reject an envelope older than `PUSH_MAX_AGE_MS` (300 000 ms).

If the extension does not run, the lock screen shows a fixed placeholder
("wmux — New activity"). That is the relay's ceiling, not a bug.

---

### Registering

```
POST /api/push-registration      (device credential, never the operator token)
  body: {apnsToken, publicKey, apnsEnvironment?: 'development' | 'production'}
  → 200 {ok: true}
  → 400 {error: 'bad-token' | 'bad-key' | 'bad-apns-environment'}
  → 403 {error: 'push-is-for-devices'}
  → 409 {error: 'revoked' | 'not-found' | 'persist-failed'}
  → 503 {error: 'push-unavailable'}
```

`apnsToken` is lowercase hex; `publicKey` is base64 of the 32 raw bytes of your
X25519 public key. Register on every launch — APNs rotates tokens, and a
registration replaces the previous one wholesale rather than merging, so a
regenerated key pair never leaves the daemon sealing to a key you no longer
hold.

`apnsEnvironment` is which APNs stage minted your token — read it from
`aps-environment` in your own embedded provisioning profile, never inferred from
a build configuration.

**Omit it, never guess it.** An APNs token does not say which stage it came
from and Apple's two hosts reject each other's, so the daemon stores this per
device and routes on it. Absent means "use whatever the relay was configured
with", which is what happened for every device before this field existed and is
the right answer for a build that cannot name its own stage (the simulator has
no profile). A stage sent on a hunch earns a `BadDeviceToken` that traces back to
nothing. A value that is neither word is a `400`, not a silent drop.

A registration replaces the previous one wholesale, this field included: leaving
it out on a later call **clears** a stage the daemon knew, rather than inheriting
it. That is deliberate — the token now on file belongs to the build that just
called, not to the one before it.

A `410` from Apple makes the daemon forget your registration, so a reinstalled
app must register again before it hears anything.

---

### Live Activity — the daemon drives the lock screen

`GET /api/config` answers `liveActivityPush: true` on a daemon that can push
Live Activity updates. A daemon that predates this omits the field, which reads
as false: keep starting the activity locally there, exactly as before.

```
POST /api/live-activity-registration   (device credential, never the operator token)
  body: {pushToStartToken?: hex | null,
         activityToken?: hex | null,
         apnsEnvironment?: 'development' | 'production'}
  → 200 {ok: true}
  → 400 {error: 'bad-token' | 'bad-apns-environment'}
  → 403 {error: 'push-is-for-devices'}
  → 409 {error: 'revoked' | 'not-found' | 'persist-failed'}
  → 503 {error: 'push-unavailable'}
```

**This route MERGES; `/api/push-registration` replaces.** The difference is not
cosmetic. The two tokens arrive at different moments — the push-to-start token
at launch, the activity token only after the system has actually started an
activity — so a wholesale replace would mean every call erased whichever token
was not in hand. An omitted field is left as it was. `null` **removes** that
token.

`activityToken: null` is how you say "the activity is over" — your app ended it,
or the person swiped it away. Send it; otherwise the daemon keeps pushing
updates to a token Apple will eventually answer `410` for.

**`apnsEnvironment` belongs to this route too**, and is not read from a push
registration. A phone that refused notification permission has no push
registration at all (Live Activities are a separate permission), and a push
registration replaces wholesale, so a stage learned there cannot be relied on
here. Same two words, same validation, same `400 bad-apns-environment`.

**The push-to-start token is one per app, so it names one daemon.** iOS issues a
single push-to-start token for the whole app, not one per server, so registering
it with two daemons would have both of them starting activities and the app
adopting whichever it saw first. Register it with the daemon you are paired with
now. When that pairing changes, send `pushToStartToken: null` to the previous
daemon on a best effort — one failed call is not worth blocking a re-pair.

A `410` on this path **only forgets the token that earned it** — the activity
token on a failed update, the push-to-start token on a failed start. Your push
registration (§ above) is untouched. An activity token dies every time an
activity ends, which is routine; treating that as "this device is gone" would
switch approval notifications off several times a day.

Content-state carries counters only — see the exception noted at the top of this
section. When your app is in the foreground it should overwrite the activity
with its own full local snapshot (agent rows included); the remote numbers are
what the lock screen shows while your app is not running.

## 8. Photo upload

A phone has a camera and a desktop does not, which is the whole reason this
route exists. `POST /api/input` writes to a PTY and an image cannot ride it, so
the bytes land on disk and you put the **path** in the composer.

```
POST /api/upload      body: raw JPEG or PNG bytes (no multipart)
  → 201 {path, expiresAt}
  → 403 {error: 'uploads-disabled: server started without --allow-upload'}
  → 413 {error: 'payload too large'}
  → 415 {error: 'unsupported-format: only JPEG and PNG are accepted'}
  → 429 {error: 'too-many-uploads: try again in a moment'}
  → 500 {error: 'write failed: …'}
  → 503 {error: 'uploads-unavailable'}
  → 507 {error: 'uploads-full: quota exceeded, try again later'}
```

Any authenticated principal may call it — operator token or device credential,
same as every other route.

**The grant is its own flag.** `--allow-upload`, not `--allow-input`: typing
into a pane the operator is watching is a smaller thing than writing a file into
their home directory, so one never implies the other. Gate the button on
`allowUpload` from `/api/config`, and match the 403 by **prefix** — the text
after the colon is prose and may be reworded, the `uploads-disabled:` tag is
not. A daemon predating this route has no `allowUpload` key at all; read a
missing key as `false` and hide the button.

**The bytes decide the format, not your header.** JPEG (`FF D8 FF`) and PNG
(the 8-byte signature) only; anything else is 415, including an empty body.
`Content-Type` is ignored entirely — send `application/octet-stream` and do not
expect it to change the outcome. Transcode HEIC to JPEG on the phone; HEIC never
goes on the wire.

**10 MB cap**, and the server destroys the connection when a body exceeds it, so
your request may surface as a transport error rather than as a readable 413.
Treat both the same.

**Two bounds beyond the per-request cap, and both are retryable.** At most 4
uploads may be buffering at once server-wide (each holds its body in memory), so
send photos one at a time — a 5th concurrent request is 429, not queued. And the
uploads directory holds at most 100 files or 200 MB of this route's own output;
past that it is 507 until the sweep frees room. Treat both as "wait and retry",
never as a reason to hide the button — unlike 403, neither says anything about
what the operator granted.

**The server names the file.** `photo-<ISO timestamp with ":" and "." replaced
by "-">-<8 hex>.jpg|png`, written 0600 into `~/.wmux/uploads/phone/`. There is no
field for a client-supplied name and there will not be one: nothing reads these
by name, and accepting one would be accepting a path.

**`expiresAt` is a deadline, and the path is a consumable.** Files are deleted
24 hours after they are written, and the sweep runs on upload and on daemon
start (it is also what frees the quota above) — do not build a gallery on top of these paths, and do not hold one
overnight. Put it in the draft, let the operator send it, forget it. Nothing
else in the uploads directory is touched: only files matching the name pattern
above are ever deleted — and the pattern is the exact generated shape,
timestamp and hex included, so a file of your own called `photo-vacation.jpg`
staged in that directory is neither swept nor counted against the quota.

There is no offline queue. A failed upload is a notice and a manual retry.

---

## 9. What is not built yet

- **`session:critical` is notify-only** — by design, permanently, not as a gap
  waiting to be filled. It fires on printed output, so it can never be a remote
  approve button; the `approval` kind is. See the `critical` section above.
- **The relay is not deployed.** Until `WMUX_PUSH_RELAY_URL` and
  `WMUX_PUSH_RELAY_SECRET` are set on a daemon, push is inert by design — not an
  error, just nothing sent.

---

## 10. Things the browser client got wrong

Every one of these passed unit tests and a live-daemon harness first, and was
found only on a real phone. They are the cheapest tests to write on day one.

1. **`start_url` is `./`**, so a home-screen launch opens with no token in the
   URL. Persist the credential somewhere that survives eviction — `sessionStorage`
   is per-tab and iOS drops it.
2. **`fetch` resolves on 401 and 403.** A lone `.catch()` sees neither, and
   rejected keystrokes vanished silently.
3. **A refusal explains itself in the body.** The page threw it away and rendered
   "Pairing failed."
4. **Cache headers matter.** A phone kept running a build that had already been
   fixed.

Four of the six dogfood defects were the same shape: the server answered
correctly and the client discarded it.


## Workspace files (phone gap extension)

`workspaceFiles: true` in `/api/config` advertises `GET /api/sessions/:id/files`.
The route requires BOTH `--allow-transcript` and the input grant, and the same
session visibility as pane attach. `workspaceFiles` is advertised only when both
hold, so a read-only device is never shown a browser it would be 403'd out of.
The two grants are deliberate: the root is the daemon-recorded `spawnCwd`, which
for a plain shell pane is the operator's home directory, and transcript consent
alone does not cover browsing it. The root is never OSC cwd or a client
absolute path.
`path` is relative (default root); symlinks and parent traversal are refused.
Dotfiles and dot-directories (`.git`, `.env`, `.ssh`, …) are excluded at any
depth from listing, search, read and preview. They answer exactly as a path that
does not exist does — 404 `file-unavailable` — so the route cannot be used to
prove that a secret is there.
Directory responses contain `{path, entries:[{name,path,directory}], nextOffset}`;
pass `offset=nextOffset` for another page (200 entries per page). Entries are
ordered over the whole directory (directories first, then name) before paging,
so pages never overlap or drop an entry.
`preview=1` returns `{path,mime,text}` for UTF-8 or `{path,mime,base64}` for PNG/JPEG.
Reads are capped at 1 MiB. Responses are no-store. Errors: 400 invalid path/offset,
403 files-disabled/read-only/symlink/outside-workspace, 404 unavailable,
409 file-changed, 413 file-too-large, 415 binary-file/not-a-file. No write route
is implied.


### Live Activity host ownership

`liveActivityHostScope: true` advertises an optional `hostID` in registration.
It is an opaque 64-character lowercase hexadecimal client profile ID, persisted
with device registration and forwarded only in start `attributes.hostID`.
The relay accepts only that format. A client must never register an activity's
update token with a different profile. Legacy unscoped activities can be adopted
only when exactly one paired host exists. The iOS selected host owns the current
local activity; other host notifications remain independently routable.

### Filename search

`query` (1–200 characters, nonblank) on the files route searches relative paths
recursively below `path`. It excludes every dot-entry (`.git` included) and
never follows symlinks. Search
returns the directory response plus `truncated`, with no `nextOffset`. A request
is bounded to 200 matches, 10,000 entries, 32 nested levels, and a three-second
cooperative traversal deadline. `truncated: true` also reports inaccessible or
changed subfolders. The client must show this partial-result state and let users
narrow the query or search a subfolder. Individual filesystem operations may
exceed the cooperative deadline on stalled mounts.

## Git control and PR state

`gitControl: true` in config is caller-specific: these endpoints require the
input grant and an attachable session, rooted in its trusted `spawnCwd`.

- `GET /api/sessions/:id/git`: `{branch, ref, head, tree, files, lastSubject}`.
  `head` is null on an unborn branch; `tree` is the staged tree object. `ref` is
  the full symbolic ref of HEAD (`refs/heads/<name>`); `branch` remains the short
  name for display. Reading this
  endpoint may materialize Git tree objects, but never moves a ref or stages a
  worktree file. The existing `/diff` route remains the read-only review route.
- `POST .../git`: `{requestId, action, expectedHead, expectedTree, expectedRef, paths?, message?}`.
  Actions are `stage`, `unstage`, `commit`. `expectedHead` must be present,
  including null for an unborn branch. `expectedRef` must be present on every
  action and must be the `ref` from the snapshot the user reviewed — a string
  starting with `refs/heads/`. A missing or malformed one is
  `400 invalid-git-request`; there is no legacy path without it. Paths are
  literal repo-relative paths
  from the current status (at most 100); include both paths of a rename.
- Success is `{applied:true, commit?:<oid>}`. Fetch a fresh snapshot separately;
  failure of that read does not change the successful write receipt.
- Staged tree, HEAD or ref mismatch returns `409 git-state-changed`, for all
  three actions. Two branches can share a HEAD and an index tree, so a desktop
  branch switch alone invalidates a reviewed mutation. The client must
  refresh and review before issuing a new mutation. There is no automatic retry.
- Commits use the reviewed immutable tree and a compare-and-swap update of
  `expectedRef` — never of whatever ref HEAD points at when the write lands.
  Later index edits are retained. Phone commits use the
  Mac's Git identity, are unsigned, and bypass hooks; the UI states this. This
  does not push. Merge/rebase/sequencer state, detached HEAD, unmerged indexes,
  and configured content filters require desktop Git. Filters are refused
  rather than silently committing unconverted content.
- Successful request IDs are cached per canonical repository (up to 1,024) for
  the server lifetime. Reuse with another payload is refused. This is not a
  durable transaction journal. After a lost response or daemon restart, inspect
  the latest commit/staged state before sending a fresh request. Preconditions
  prevent ordinary duplicate commits after a successful ref update.
- Four Git/PR HTTP jobs maximum; writes also serialize per repository. Git
  subprocesses use fixed hardening config, sanitized environment, timeout and
  output bounds. Arbitrary ref names, shell fragments or remote URLs are not
  accepted from the phone.
- `GET .../git/pr`: `{state, items}`. `state` is `available`, `unsupported`, or
  `unavailable`. An empty available list means no matching PR; a CLI/auth/network
  failure is unavailable. Only credential-free GitHub origin URLs are accepted.
  The Mac's `gh pr list` reads at most 100 candidates matching the current
  branch name and returns at most 10 whose head repository matches origin
  (case-insensitive repository identity) and whose head branch matches exactly.
  Other forks and deleted head repositories are excluded. Missing head metadata
  is unavailable; a full candidate page without a matching head is also
  unavailable rather than a false claim of no PR. It neither creates nor changes PRs. Items contain number, title, state, url,
  isDraft. Links must belong to that repository on github.com.

## Durable run results

`runHistory: true` advertises `GET /api/history?offset=0`. It requires both an
authenticated caller and `--allow-transcript`. Pages contain up to 100 entries
and a nullable nextOffset. The store retains the newest 1,000 results. Responses
are no-store. Invalid offsets return 400, disabled access 403, and unavailable
or corrupt storage 503, never a fake empty success.

Each entry has `id`, `sessionId`, `workspace`, `agent`, `outcome`, `at` (epoch
milliseconds), and a bounded plain-text summary. Completed means an authoritative
lead `agent.stop` with status complete; failed means `agent.stop_failure` with
status error. Detector idle, subagent completion and a continuing lead are not
results. A provider's last_assistant_message is used when present; otherwise the
hook's status message is retained without inventing a summary.

Tool/user-prompt activity persists an active-run marker. Destruction or death of
that pane records interrupted only if an active marker remains. A shell exit
after completion does not invent a second outcome. Pressing Escape/Ctrl-C alone
is not proof of interruption, and providers that emit no authoritative hooks
have no fabricated completion history. Native in-TUI cancellations without a
terminal outcome hook are not yet classified.

History lives in `phone-run-history.json` with 0600 permissions, bounded storage,
fsync/atomic writes and last-generation backup recovery. Event IDs deduplicate
hook replay. Internal brain panes are excluded at capture, including the explicit
environment marker. Capture continues while the phone/web listener is offline;
it is wired at daemon HookIngest, not at the SSE subscriber. Closed panes retain
their results. The client stores read IDs per host on-device and never presents
read state as synchronized across devices.

### Desktop-backed account, command and workspace operations

Optional config flags `desktopAccounts`, `quickCommands`, and `workspaceCreation`
identify these contracts. They describe support, not current desktop availability.
The Electron main process owns account and quick-command storage; a missing or
reconnecting desktop returns 503. The daemon forwards only named operations over
an owner-bound request bridge, never an arbitrary RPC supplied by the phone.

- `GET /api/sessions/:id/accounts` reads account labels, workspace bindings, and
  cached usage. Transcript access is required. It never probes quota automatically.
  `POST` also requires input permission: `{action:"bind",vendor,accountId}` selects
  an existing account (`null` clears a binding); `{action:"usage",accountId}` explicitly
  refreshes supported usage. The client must disclose that this may send a small
  billable API request. Config paths and local diagnostics are not returned.
  The workspace comes from the session, not the request body. Binding changes
  apply to future panes. Phone workspace pane creation requires the desktop to
  resolve bindings and strips inherited account-directory overrides.
- `GET /api/quick-commands` returns `{revision,commands:[{id,title,text}]}`.
  `POST` replaces this snapshot only when its revision still matches. Both require
  transcript access; replacement also requires input permission. Limits: 100 rows,
  120-character titles, 16,000-character bodies, and 64 KiB serialized storage.
  Conflicting or unconfirmed writes must refresh before another edit; never retry
  a replacement automatically. Saving or inserting a command does not execute it.
- `GET /api/desktop-workspaces` returns `{workspaces:[{id,name,sessionId}]}`; a session ID
  is nullable and must pass the caller's attachable-session check. `POST /api/workspaces` accepts
  `{requestId,name,cwd?}`. Both require input permission. Creation requires a
  nonempty name and, when supplied, an existing absolute Mac directory. UUID
  request identity becomes the persisted workspace ID, so retrying an existing
  creation returns the original workspace without duplication. Issued identities
  are retained in session.json after close/archive. Replaying a retired identity
  returns HTTP 409 `workspace-request-closed`; creating another workspace requires
  an explicit new request ID. The ledger retains up to 10,000 identities without
  eviction; new phone requests then return 409 `workspace-request-history-full`,
  while ordinary desktop creation remains available. Existing pre-ledger live
  phone workspace IDs are backfilled on session load. This follows normal desktop
  session persistence and does not claim a separate fsync receipt before response.
  A successful create returns workspace identity, not proof that the first PTY
  has finished starting. Clients read the workspace list and sessions to open it.

These operations require the desktop app to stay open. They do not expose account
registration, arbitrary environment updates, shell commands, or generic renderer
RPC dispatch.

### Workspace browser preview

`browserPreview` advertises the desktop-backed embedded-browser preview contract.
`GET /api/sessions/:id/browser` lists `{pages:[{id,title,url}]}` for the trusted
session's workspace. `?surfaceId=...` captures that page as bounded JPEG data with
`capturedAt` (epoch milliseconds). Transcript consent is required; every response
is no-store. CDP endpoints and embedded URL credentials are not returned. File,
data, and about pages and external browser windows are not included.

`POST` additionally requires input permission and accepts exactly:

- `{action:"viewport",surfaceId,mode:"mobile"|"desktop"}`: mobile applies a responsive
  viewport up to 390 × 844, bounded by the reset desktop guest dimensions, and touch emulation; desktop invokes the existing
  device-reset path. This changes the Mac browser too and is not Safari emulation.
- `{action:"navigate",surfaceId,url}`: HTTP(S) URLs without embedded credentials,
  validated again by the existing browser navigation handler.

`browserCreation` advertises `POST {action:"open",url}` on the same session route.
No existing surface is required. The workspace still comes from the authenticated
pane; main allows only credential-free HTTP(S) and the embedded backend, then
calls scoped `browser.tabs` with fixed `action:"new"`. Existing tabs are not reused.
A successful response carries `{surfaceId}`; clients refresh the page list because
the new guest may not be mounted yet. An unconfirmed creation is never retried
automatically. This session route requires an attachable pane in the workspace.

With `workspaceBrowsers`, the same GET/POST contract is also available at
`/api/desktop-workspaces/:workspaceId/browser` without a terminal pane. Both input
and transcript consent are required, including for GET, matching the input-gated
desktop workspace registry. Before dispatch, the server resolves the exact ID
through the desktop `workspaces.list` registry and reauthenticates after that
asynchronous lookup. Unknown IDs return 404; no active-workspace fallback exists.
POST additionally reauthenticates after reading its body. The iOS Settings
workspace-browser picker lists desktop workspaces including those without panes.

`browserKeyboard` additionally advertises input-authorized keyboard controls:

- `{action:"type",surfaceId,expectedURL,text}` inserts up to 4096 UTF-16 units into
  the focused field. Disallowed control characters are rejected.
- `{action:"key",surfaceId,expectedURL,key}` accepts only `Tab`, `Shift+Tab`,
  `Enter`, `Backspace`, `Escape`, `PageUp`, and `PageDown`.

Captures may additionally carry `pageURL` and `geometry:{width,height,scrollX,scrollY}`
when a fixed viewport probe is stable across capture. Their presence enables
`{action:"tap",surfaceId,expectedURL,geometry,x,y}`, with normalized coordinates
in `[0,1)`. Main converts to CSS coordinates, refusing a changed viewport size,
scroll offset, page URL or owner before dispatch. A changed/unsupported geometry
(including browser pinch zoom) still permits a readable capture, without tap
metadata. Image downscaling and display density do not change normalized points.
Main also reads the native webview rectangle from wmux's own renderer, accounting
for host/guest zoom. If the emulated viewport exceeds the real widget after a Mac
resize, captures omit input geometry and old coordinate actions are rejected.
The phone turns control mode off and offers viewport-reset guidance. A viewport
reset clears remembered device metrics before fitting against current native
bounds, so the desktop's earlier size is not reinstated after a resize.
DOM movement within an unchanged viewport is not frozen by a screenshot.

`browserScrolling` adds `{action:"scroll",surfaceId,expectedURL,geometry,x,y,deltaX,deltaY}`.
The anchor is normalized like a tap. Finite deltas are limited to [-1,1] of the
captured viewport width/height per gesture. The same ownership, URL, size and
scroll-offset checks run before fixed CDP mouseWheel dispatch at that point;
no arbitrary CDP fields are accepted. iOS sends one scroll on a completed
single-finger swipe in control mode; canceled gestures do not send. Pinch still
zooms the capture, and turning control off restores local image panning.

Keyboard actions bring the Mac browser forward and temporarily emulate focus if
needed, restoring that override afterward. Same-target phone input is serialized
by rejecting overlapping operations. Main rechecks workspace ownership and the
credential-stripped HTTP(S) page URL immediately before dispatch. A URL match is
not a DOM/focus snapshot: page scripts and desktop users may still change focus.
POST reauthenticates after body completion. Clients never automatically retry
keyboard input after an unconfirmed response; refresh and inspect the page first.

Workspace identity never comes from the HTTP body. Main checks the current CDP
owner, then calls only existing scoped screenshot/emulation/navigation/input operations.
No arbitrary JavaScript, headers, cookies, CDP commands or RPC names are accepted.
The capture envelope permits at most 2 MiB base64 image data; only capture requests
receive the larger bridge response allowance. A hidden Mac workspace may not
produce frames; clients show this failure and ask the user to bring it forward.

### New agent pane launch options

With `agentLaunch`, an input-authorized phone may read
`GET /api/agent-launch-options` -> `{agents:[{agent,models,efforts}]}`.
The daemon probes the installed Claude CLI's `--help` with a timeout and bounded
output, caching the result for five minutes. No model request is sent. Model
values are documented aliases, not a claim that the account can access every
model; effort values must appear in that installed CLI's help.

`POST /api/sessions {cwd}` refuses a `cwd` that, after `~` expansion, is not
an absolute path to an existing directory: `400 {error:"cwd-not-found",
effect:"none"}`, and no pane is created. Before this the create answered 201 and
the pane exited at once. A client can offer "open in home" (omit `cwd`). On a
Windows host only drive and UNC paths are checked; a `/…` or `~` path may be
meant for a WSL default shell and is left to the spawn, as before. The check
runs after the request is re-authorized.

To choose that `cwd`, an input-authorized phone may browse folder names under
the host user's home. `/api/config` advertises `folderBrowse: true` to such a
device; a daemon predating the route omits the flag.

`GET /api/folders?path=<absolute path | ~ | ~/…>[&hidden=1]` -> `200
{path, parent, entries:[{name, path, git}], truncated}`, sent `Cache-Control:
no-store`. Omitting `path` means home. `path` is the folder's real path and
`parent` is `null` at home. Entries are directories only, never files, sorted by
name, and at most 500; `truncated` says more existed, or that the read stopped
early (a folder with more than 20,000 entries of any kind, or a read error
partway). Dot folders are left out unless `hidden=1`. `git` says the folder has
a `.git` entry. A symlinked entry is not offered, and a symlink that leads out
of home is not followed. Subfolders are listed without being opened, so an entry
can still answer `permission-denied` when asked for.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid-path` | Relative path or NUL byte |
| 403 | `outside-home` | A path spelled outside home (refused before any lookup), a symlink segment that resolves outside it or dangles (the same answer whatever lies beyond), or a host whose home is a filesystem root |
| 403 | `permission-denied` | The OS refused the read: on macOS usually privacy protection for Desktop, Documents, Downloads or a removable volume, granted under System Settings › Privacy & Security › Files and Folders (or Full Disk Access) |
| 404 | `folder-not-found` | Missing or not a directory |
| 403 | `read-only: …` | The device may not type (same refusal as other input routes) |
| 500 | `folder-list-failed` | Anything else; not a statement about the folder |

On a Windows host `~` means the user profile and only paths under it are
listed; WSL paths are not browsed.

`POST /api/sessions` optionally accepts
`agentLaunch:{agent:"claude"|"codex",model?:id,effort?:level}`. The server validates
against its current catalog and constructs only the known launcher and flags.
The actual spawn uses the daemon's existing `exec.command` path; `cmd` continues
to select the wrapper shell, not a command string. No arbitrary launch command,
prompt, permission override, or environment is accepted through this field.
Omitting agentLaunch retains normal shell creation. A 201 confirms creation of
the pane, not authentication or acceptance of the model by the provider.

Codex is advertised only when its installed CLI exposes `--model` and `--config`.
Its visible model IDs and per-model effort levels come from that account's
`models_cache.json`, read with a 4 MiB bound and 24-hour freshness limit. The
workspace query `?workspaceId=...` resolves CODEX_HOME through the trusted desktop
account store; it never accepts a config path from the phone. Missing/stale cache
returns Codex with default-only selection and `catalogState:"unavailable"`.
`modelEfforts` maps each model ID to its supported levels; without a selected
Codex model, no explicit effort is advertised. Unknown or executable model tokens
are rejected. Launch flags use `--model` and fixed `-c model_reasoning_effort=...`;
no provider, credential, permission or arbitrary config override is accepted.

This contract applies to NEW panes only. It does not change a running agent.
Claude model/effort semantics were checked
against installed CLI help and https://code.claude.com/docs/en/model-config;
account availability and CLI-enforced effort fallback remain provider behavior.

Codex CLI model/config behavior was checked against installed `codex --help` and
https://developers.openai.com/codex/models and
https://developers.openai.com/codex/config-advanced. The cache projection excludes
identity, model instructions and other private metadata. Cached availability is
not a promise that the provider will accept a later request.

The pre-existing `GET /api/workspaces` remains the daemon's live-pane roster
(`{id,name,panes:[{sessionId,...}]}`), usable without Electron. It is distinct
from the input-gated desktop registry. New pane selection uses the live roster's
IDs even on older hosts; opening a newly created desktop workspace uses
`/api/desktop-workspaces` to resolve its active pane. While the desktop is
attached the roster also carries the sidebar fields below; its rows are still
exactly the workspaces with a live pane.

### Desktop sidebar fields (phone Fleet)

`fleetSidebar: true` in `/api/config` says this daemon merges the desktop
sidebar's own view into the two polled list routes. It describes support, not
whether the desktop is attached right now; a daemon with no desktop bridge, and
an older daemon, omit the key. The
fields are read-only and additive, and they ride exactly the gates the two
routes already have (bearer auth; no `--allow-input` or `--allow-transcript` —
a tab title is terminal output the paired device can already read in full on
the pane stream).

**Presence.** Every field below except `workspaceId` exists only in the desktop
app. The daemon keeps a snapshot of them and answers every poll from it at
once, refreshing it in the background about once a second; a poll never waits
on the desktop, except when there is no usable snapshot — the first poll
after the daemon (re)starts, or the first poll after more than 10 seconds with
nobody polling — which may wait up to a quarter of a second so the screen
paints with the fields. When the desktop is slow or its bridge is momentarily
busy, the last snapshot keeps being served for up to 10 seconds; after that,
and at once when the desktop disconnects, the keys are **omitted** (never
`null` or `false`) and the route answers exactly as before. Treat an absent key
as "the desktop did not say" and fall back to what you draw without it; fields
may appear or disappear between polls, and may lag the desktop by a second or
two.

Nothing is added: the fields are merged by id onto rows the daemon already
lists. A desktop-only workspace with no live pane never becomes a row, and the
orchestrator brain's pane and workspace stay excluded exactly as before.

`GET /api/sessions`, per session:

- `surfaceTitle` — the pane's tab title, the label the desktop sidebar leads a
  roster row with (e.g. `"✳ app review"`). For a pane running a detected agent,
  a title that is only the host shell's name (`zsh`, `bash`, `pwsh`, …) is
  withheld unless the user typed it. At most 100 characters, one line.
- `paneName` — the pane's display name: the user's pane label when set, else
  the stable coordinate `w<workspace>-<pane>` (e.g. `"w123-5"`). Always the
  coordinate, even when the desktop hides coordinates in its own sidebar. At
  most 64 characters.
- `workspaceId` — see above; daemon-side, always present when known.

`POST /api/sessions` answers a daemon-only row: it carries `workspaceId` but
not the desktop fields.

`GET /api/workspaces`, per workspace:

- `order` — the workspace's position in the desktop's manual list (0-based,
  unfiltered, the order the user drags into). Sort by it to mirror that list.
- `pinned` — the user pinned the row in the sidebar.
- `color` — the color tag id, one of `red`, `orange`, `yellow`, `green`, `teal`,
  `blue`, `purple`, `pink`, `amber`, `lime`, `mint`, `cyan`, `indigo`,
  `magenta`, `rose`. Absent when untagged. Treat an unknown id as untagged.
- `gitBranch`, `gitIsWorktree` — the branch the sidebar shows, and whether it
  comes from a linked worktree rather than the main checkout.
- `gitSync` — `{ahead, behind, hasUpstream}` from the sidebar's git badge.
  The desktop shows `ahead`/`behind` only when `hasUpstream` is true; do the
  same.
- `ownerWorkspaceId`, `detached`, `createdAt`, `nested` — present only on a
  fan-out task workspace, with the desktop's own judgement:
  `ownerWorkspaceId` is the workspace that fanned it out (`null` when no source
  names one), `detached` means the user detached it and the desktop draws it as
  an ordinary top-level row, and `createdAt` (epoch ms, optional) is when it
  was fanned out. A task workspace's `name` is its stored name, which usually
  starts with `wtask: `; the desktop displays it without that prefix.
- `nested` — **the only nesting signal.** True when the desktop draws this task
  indented under its owner AND that owner is a row of this same reply. Draw a
  task under `ownerWorkspaceId` exactly when `nested` is true; never infer
  nesting from `ownerWorkspaceId` being present. It is false for a detached
  task, for a task whose owner is closed (the desktop groups those under "From
  closed workspace"), for a task whose owner is itself a nested task (nesting
  is one level deep), and for a task whose owner has no live pane and so is not
  listed here.
- `taskSummary` — on an owner row with at least one `nested` task only:
  `{tasks, needYou, toReview, finished}`, the sidebar's rollup line computed
  over exactly the rows of this reply that are `nested` under it. `needYou`
  counts tasks waiting on the user, `toReview` counts open tasks whose every
  agent pane reported complete (Fleet's "Ready to review"), and `finished`
  counts tasks whose every agent pane reported complete.

Top level of `GET /api/workspaces`: `activeWorkspaceId` — the workspace the
desktop is showing, present only when it is one of the listed rows.

### Isolated Electron preview smoke test

Run `node scripts/run-phone-browser-smoke.mjs` from this repository with a
graphical desktop session. The runner bundles the harness into a fresh temporary
directory and starts the installed Electron with a separate user-data directory.
It does not connect to the running wmux daemon or a provider account.

The test renders a loopback fixture in an actual Electron webview and exercises
`handlePhoneBrowser` through the existing browser RPC handlers: page listing,
JPEG capture, mobile viewport (390 × 844), desktop reset, and URL navigation.
It asserts the original viewport dimensions and touch capability are restored.
The printed artifact directory contains desktop/mobile/restored JPEGs and
`result.json`; failure or the 30-second timeout exits nonzero.

The target registry and automation lease are fixtures. This verifies actual
Chromium rendering/CDP/capture behavior, not the HTTP pairing transport, the
production registry's hidden-workspace lifecycle, or rendering on iOS. Those
remain separate integration checks.

### General file attachments

`generalFileUpload` in config advertises `POST /api/upload-file` when uploads
are enabled and storage is wired. It uses the same authentication and explicit
`--allow-upload` grant, 10 MiB body cap, concurrency/aggregate quota and expiry
as photo upload. The raw body is stored unchanged with private 0600 permissions.
It never executes or inserts the file into a pane.

The optional `X-Wmux-File-Extension` header accepts 1–12 ASCII alphanumeric
characters, lowercased by the server, defaulting to `bin`. Original filenames
and client paths are not accepted. The server generates a `file-<timestamp>-<random>`
basename; successful responses retain `{path, expiresAt}`. Managed general
files participate in the same quota and expiry sweep as managed photos.
`/api/upload` remains JPEG/PNG-only for compatibility.

### Durable input receipts

When config advertises `inputReceipts`, POST `/api/input?session=...` accepts
`X-Wmux-Input-Request-ID: <13-digit epoch milliseconds>.<UUID>` and
`X-Wmux-Pane-Incarnation: <current incarnation>`. Omit both for the legacy
204 response. Identified input returns 200 `{status:"written",replayed:boolean}`
when the PTY write returned and its receipt was persisted, or 409
`{status:"uncertain",replayed:boolean}` when a write may have occurred but cannot
be confirmed. Neither state proves the agent processed or executed the input.
409 `{error:"terminal-prompt-active",effect:"none"}` means nothing was written
and nothing was journaled; the same ID may be retried and is checked again.

Receipts bind authenticated device/operator identity, pane incarnation and exact
decoded input. Reusing an ID with different content, using an old incarnation,
invalid/expired IDs or unavailable receipt storage never falls back to a raw
write. IDs expire after 24 hours and cannot become reusable after receipt pruning.
Persisted pending entries are not replayed following a daemon restart. Input
permission and the live session are rechecked after request-body completion for
both legacy and identified requests.

Written receipts additionally carry `inputToken`, combining a server instance
epoch with the bridge's all-input revision after the write. A new continuation
may send `X-Wmux-Input-After` with that token; the server rejects it if any input
has intervened. The iOS composer requires the text receipt's token before
sending Return. Receipt replay is checked before this precondition, so a Return
already written still reconciles successfully after later keyboard activity.
Server reconstruction changes the epoch and therefore requires manual review
before continuing an incomplete old text/Return sequence. This does not lock
the desktop keyboard or establish that the prompt was empty before text input.

### Running agent settings

`agentSettings: true` advertises `GET/POST /api/sessions/:id/agent-settings`.
Both operations require input permission and transcript consent. Capability means
this daemon implements the route, not that every pane has a controllable agent.
Currently Codex panes with a daemon-owned live TUI relay are eligible; a missing
or unconfirmed selection returns `503 {"error":"unavailable"}`. Persisted resume
markers are never sufficient attribution.

GET returns `{agent,model,effort,busy,revision,models}`. `effort` can be null;
`models` contains `{model,efforts,defaultEffort}` entries. These are configured
settings for subsequent turns, not the model executing an already active turn.
Responses are not cacheable. The revision is opaque and scoped to pane, account,
process, relay, selection generation and observed settings.

POST accepts exactly `{model,effort,expectedRevision}` and returns the same
snapshot shape after a fresh runtime read confirms both requested fields.
It does not accept thread IDs, account paths, shell commands or prompt text.
`409` reasons are `stale`, `busy`, `unsupported-choice` and `unconfirmed`.
Malformed choices return 400; unsupported/unavailable sessions return 503;
permission failures use 401/403. Clients must refresh after stale/unconfirmed
results and must not automatically replay changes after uncertain transport
outcomes. Stale-view validation is optimistic, not atomic CAS with other Codex
clients. Operations are serialized per pane and limited to four concurrent panes.
Credentials and pane ownership are rechecked at asynchronous control boundaries.

Phone-created Codex panes on Unix use a private relay when an existing account
server passes initialization. Missing/stale/unready account servers use ordinary
Codex launch. Other panes may remain unavailable. Temporary socket URLs are not
persisted. The three native boot-recovery branches rebuild relay ownership for
phone-generated Codex command forms, preserving existing resume arguments.
Arbitrary shell commands, existing remote commands and unsupported platforms are
not rewritten. A recovered relay changes the scoped revision; clients must refresh.
Daemon state snapshots retain an exact foreground relay thread hint only when its
rollout exists inside that pane's account and its cwd matches. Recovery validates
that hint again. Phone-created Codex panes without a valid hint start fresh; they
do not guess with resume --last. Temporary or pending selections clear older hints.
The isolated full-daemon smoke verifies two panes in the same cwd recover their
own conversations after graceful shutdown, with restored web credentials,
stale-revision rejection, settings changes and closure. Binding persistence still
follows normal snapshot timing. Forced daemon/account-server death and shared-server
hook attribution remain integration work.

Ephemeral system threads used by the TUI for automatic titles do not change the
foreground settings target. A loaded `systemError` thread can change settings for
its next turn; an `active` thread remains busy and `notLoaded` remains unavailable.
Catalog pagination is bounded to four pages of 100 entries; incomplete or ambiguous
catalogs are unavailable rather than silently truncated.

## Device management

`/api/config` carries `deviceManagement: {scope: "all" | "self"}` when this
daemon serves the three routes below. The key is **omitted** (not `false`) when
it does not; an older daemon serves the same shape. `scope` is per caller:

- `all` — the operator token, or a device that may type (its own grant **and**
  the server's `--allow-input`, the same rule as `allowInput`).
- `self` — a read-only device.

All three routes sit behind the normal Bearer gate and accept no stream ticket.

### `GET /api/devices`

```json
{
  "devices": [
    {
      "deviceId": "…", "name": "iPhone", "pairedAt": 1700000000000,
      "lastSeenAt": 1700000500000, "grants": {"input": true},
      "revoked": false, "current": true
    }
  ],
  "serverGrants": {"input": true, "upload": false, "transcript": true},
  "scope": "all"
}
```

Sent with `Cache-Control: no-store`. `grants.input` is the device's **own**
stored grant; `serverGrants` are the server flags (`--allow-input`,
`--allow-upload`, `--allow-transcript`). Whether a device can actually type is
both of them together. `revokedAt` is present only on a revoked row. `current`
marks the requesting device and is always `false` for the operator.

Visibility:

| Caller | Sees |
|---|---|
| operator token | every device, including revoked tombstones |
| device with scope `all` | every **active** device (no tombstones) |
| device with scope `self` | only its own row |

A device that may type already has a shell on the host and could read the
roster file from it, so showing it the roster reveals nothing new. The roster
is for **seeing** which devices exist and when each was last seen, so the owner
can revoke a lost one from the desktop (or with the operator token). A device
can revoke only itself. A read-only device learns nothing about the others: no
names, no `lastSeenAt`.

No secret material, push token or Live Activity token is ever on this wire.

### `POST /api/devices/:id/revoke`

No body. Revocation is permanent; a revoked device re-pairs to come back.

### `PATCH /api/devices/:id/grants`

Body is exactly `{"input": false}`. This route only **lowers** a grant. Raising
one is desktop-only for every caller, the operator token included, the same way
pairing codes are: the operator token travels in URLs and QR codes. Lowering
your own grant needs no input permission. When the grant actually changes (or
an earlier change that failed to persist is being retried), the server also
closes that device's live streams, so it re-handshakes and picks up the smaller
grant. A PATCH to a grant that is already `false` and on disk changes nothing
and closes nothing.

### Who may act on which id

The operator token may act on any id. A **device may act only on its own id**:
any other id gets `403 {"error":"not-permitted"}` before the roster is
consulted, byte-identical whether or not that id exists.

### Responses

| Status | Body | When |
|---|---|---|
| 200 | `{ok:true, closed:N}` | revoke persisted; `N` live streams were closed. Revoking an already revoked device answers `{ok:true, closed:0}` |
| 200 | `{ok:false, reason:"persist-failed", closed:N}` | revoke could not be written to disk. The device is blocked in memory now, but may come back after a daemon restart |
| 200 | `{ok:true, grants:{input:false}}` | grant lowered |
| 200 | `{ok:false, reason:"persist-failed", grants:{input:false}}` | grant lowered in memory but not written to disk. Retrying the same PATCH re-attempts the write and keeps answering this until it lands |
| 400 | `{error:"invalid-grants"}` | PATCH body missing `input`, `input` not a boolean, or any other field present |
| 403 | `{error:"not-permitted"}` | a device naming an id that is not its own |
| 403 | `{error:"grant-escalation-desktop-only"}` | PATCH with `input:true`, from anyone. Nothing is written |
| 404 | `{error:"device-not-found"}` | operator naming an unknown id. The roster keeps only the newest revoked tombstones, so a pruned one is also 404 |
| 409 | `{error:"device-revoked"}` | PATCH on a revoked device, including one revoked from the desktop while the request body was still arriving |
| 500 | `{error:"device-revoke-failed"}` | the revoke raised an unexpected error. Retry; revoking is idempotent |
| 500 | `{error:"device-grant-failed"}` | the PATCH raised an unexpected error. Retry; lowering a grant is idempotent |
| 500 | `{error:"device-list-failed"}` | `GET /api/devices` could not read the roster. Retry |
| 503 | `{error:"device-management-unavailable"}` | this daemon's device store cannot manage devices (config omits `deviceManagement`) |

### Revoking yourself

A device may revoke itself with no input permission. The response is still
delivered after the server closes that device's SSE streams and stream tickets;
every later request answers `401 {reason:"revoked"}`.

**After a self-revoke the phone discards its local credential whatever the
response says**: `200 ok:true`, `200 ok:false persist-failed`, a network error
or no response at all. On `persist-failed` the device is blocked on the running
daemon but could be accepted again after a restart; a phone that has already
thrown its credential away cannot use it either way.

Every revoke and grant change is recorded in the daemon's device audit log with
who made it: `desktop`, `operator-web` or `device-self`. A grant change first logged as
`persist-failed` gets a `grant-persisted` line once a later write puts it on disk. That
pending note lives in memory only: a daemon restart before the next successful write
drops both the note and the unwritten grant, and the roster on disk stays authoritative.

## Native chat

The phone's Chat surface drives the **native conversation already running in the
pane's terminal** (Claude, Codex, OpenCode): same PTY, same native session id.
Opening Chat never spawns an agent, creates a native session or sends a prompt.
Approvals, native permission dialogs and Stop stay in Terminal; there is no file
undo. The only thing Chat can start is an agent in an empty shell (launch, below).

Everything here sits behind the normal Bearer gate. No chat route accepts a
stream ticket, and every response carries `Cache-Control: no-store`. The four
chat routes (send, send receipt, launch, launch receipt) answer
`404 {error:"session not found"}` for the orchestrator brain pane for **every**
credential, the operator token included, exactly as `/turns` does.

### Capabilities in `/api/config`

Additive, computed per caller, and omitted entirely when the daemon has no chat
bridge. A missing key reads as `false`; none of them moves `protocolVersion`.

| Key | Meaning |
| --- | --- |
| `chatBinding` | `/turns` carries the `chat` object and v2 cursors. Needs `--allow-transcript` |
| `chatSend` | `POST …/chat/messages` exists and **this caller** may use it (`chatBinding` and input permission) |
| `chatLaunch` | `POST …/chat/launch` exists and this caller may use it (same condition) |
| `chatLaunchModes` | Present only when `chatLaunch` is true. `{claude:[…], codex:[…]}`: `default` only, plus `bypass` (Claude) / `yolo` (Codex) when the server was started with `wmux web --allow-dangerous-launch` |
| `chatSkills` | `/commands` accepts `?agent=` and answers the native catalogue |
| `chatVersion` | Version of this chat contract (`1`). Bumped only on a breaking change |

Gate the composer on `chatSend`, not on `allowInput`: a read-only device reads
chat but never gets a composer.

### Reading: the `chat` object on `/turns`

`GET /api/sessions/<id>/turns` stays the one reading route. With `chatBinding`
the daemon resolves the pane the way the desktop Chat does — OpenCode TUI
plugin first, then a managed record (only with no live agent and no
transcript), then the Claude/Codex transcript file — and adds `chat` to every
200, including `available:false`:

```jsonc
"chat": {
  "binding": "terminal",          // "terminal" | "managed" | "none"
  "agent": "codex",               // terminal only; open set
  "agentSessionId": "0199f1c2-…", // absent when binding is "none"
  "historyEpoch": "h1:5b0c…",     // opaque; "rows you hold still belong to this history"
  "historyTruncated": false,
  "maxSendBytes": 23000,          // only when the binding has a byte limit (OpenCode)
  "agentStatus": "complete",      // open set
  "agentAlive": true,
  "capabilities": { "history": true, "send": true, "permissions": false, "cancel": false,
                    "fileUndo": false, "streaming": false, "launch": false, "skills": true },
  "blocked": { "by": "approval", "approvalId": "apr_…" },  // only while blocked
  "launch": { "ready": true, "reason": "ok", "agents": ["claude", "codex"], "maxPromptUnits": 2000 },  // binding "none" only
  "managed": { "provider": {…}, "phase": "…" }              // binding "managed" only; read-only on the phone
}
```

- **Decide by capability, never by agent name.** An absent additive key
  (`streaming`, `launch`, `skills`) is unknown and reads as `false`. `send:true`
  is a precondition, not a promise: every send is re-checked in the daemon.
- **Capability rules.** `skills` is true only for a `terminal` binding whose
  `agent` is `claude` or `codex`, or a `none` binding with `launch.ready`.
  `launch` is true only on a `none` binding with `launch.ready`. `streaming` is
  `false` on transcript-file bindings (Claude/Codex rows land per record, not
  per token) and absent for OpenCode. A `managed` binding has `history:true`
  and every other capability `false` or absent. `cancel` is always `false` on
  the phone (Stop is in Terminal). `queue:true` (live Claude) means a send
  during a running turn can be accepted and answered with `queued:true`.
- **`blocked` is authoritative and computed at read time**: a pending approval
  (`by:"approval"`), or `by:"terminal"` for a `terminal_prompt` record (as
  `by:"approval"` with its `approvalId` only when you sent the
  `terminal-prompt-answer` capability AND the record is answerable), a hook
  `awaiting_input`, an OpenCode
  `awaiting_input` phase, or a dialog the send screen gate sees on the rendered
  screen (checked on every read of a Claude/Codex binding with `send`).
- **`launch.reason`** is an open set: `ok`, `shell-busy`, `shell-not-empty`,
  `unsupported-shell`, `approval-pending`, `launch-pending`, `not-integrated`,
  `agent-running`. `agent-running` means an agent owns the pane without a
  readable chat (OpenCode off a session route, OpenCode without the plugin,
  another live agent with no transcript yet): send the user to Terminal. The
  preview is cheap and never enumerates processes, so `shell-has-children` only
  ever arrives from the launch POST, which re-verifies everything.
- **`historyEpoch`** is `h1:` (transcript file), `t1:` (OpenCode, a hash — the
  raw plugin epoch never leaves the daemon) or `m1:` (managed). Compare it for
  equality; never parse it. Evicting old rows sets `historyTruncated` and keeps
  the epoch.

**Cursor v2.** Still opaque base64url; store and return it verbatim. It now binds
the source, the native id and the epoch. On **every** read that carries a cursor,
forward or `dir=back`, a cursor that does not match the current conversation
(a v1 cursor, another source, another native id, another epoch, or the file
shrink/line-boundary checks) answers a tail snapshot with `reset:true`, never an
error. A v1 cursor from before the upgrade therefore resets once.

**`mode` and `reset`.** Every body adds `mode`:

| `mode` | Merge |
| --- | --- |
| `snapshot` | replace your rows |
| `delta` | upsert by `id`, append new ids; never concatenate text |
| `older` | (`dir=back`) prepend ids you do not have |

`reset` is present **only** on the answer to a read that carried a cursor.
OpenCode (`tui`) and managed reads are full bounded pages every time, so a forward
read with a cursor on those always answers `mode:"snapshot", reset:true`; they
have no back paging (`dir=back` answers an empty `older` page with
`hasMore:false`). `reset` is a merge instruction only. To tell a refresh from a
conversation change, compare the `chat` you held with the one you got:
`binding`, `agentSessionId` or `historyEpoch` changed → conversation change
(replace rows, and settle every unfinished send for the old conversation as
"check Terminal"); all equal → refresh.

When a pane that had a conversation has none any more, a read with a cursor
answers `{available:false, reason, reset:true, events:[], chat:{binding:"none", …}}`
with **no** `cursor`. Drop the rows and read again without one.

### Sending: `POST /api/sessions/<id>/chat/messages`

```json
{ "agentSessionId": "0199f1c2-…", "historyEpoch": "h1:5b0c9a1e7f3d2c4b",
  "clientMessageId": "1758712345123-6f1d2c3b-4a59-4e87-9b10-2c3d4e5f6a7b",
  "text": "fix only the failing tests" }
```

- `clientMessageId` is `<13-digit Unix ms>-<lowercase UUID>` (`-`, not `.`; the
  OpenCode plugin accepts only `[a-zA-Z0-9-]`). Mint it once, **when Send is
  tapped**, and persist it with the text before the POST. A malformed id is
  `400 invalid-chat-request`. An id whose time prefix is 24 h old, or more than
  60 s ahead of the host clock, is refused (`message-id-expired`) before any
  receipt lookup — so a pruned receipt can never lead to a second dispatch.
  Never POST an entry older than 24 h minus 10 minutes; settle it as
  "check Terminal".
- `historyEpoch` must equal the current one; a mismatch is `session-changed`.
- `text`: non-blank, at most 16,000 UTF-16 code units (`String.utf16.count`,
  not graphemes). When `chat.maxSendBytes` is present, also at most that many
  UTF-8 bytes; the daemon's own measurement of the exact OpenCode request stays
  authoritative. Newlines are allowed.
- All four fields are required strings; any other key is
  `400 invalid-chat-request`. The body cap is 96 KiB.

**Grants.** `--allow-transcript` and input permission, both checked before the
body is read and again after it with a fresh authentication of the same caller;
the pane must still be the same incarnation (`409 pane-incarnation-changed`
otherwise). The daemon then re-authorizes (the same checks, plus
`--allow-transcript`) immediately before the first write: before the paste on
Claude/Codex, and as the last await before the request leaves for the OpenCode
plugin. On the Claude/Codex paste path it re-authorizes again as the last await
before Enter. The first-write check also refuses when the HTTP connection has
already closed; the Enter check does not, so a phone that hangs up between paste
and Enter does **not** abort Enter — read the outcome from the send receipt. A
grant withdrawn before Enter presses nothing and answers
`401 authorization-expired` with `effect:"uncertain"` (the paste is in the
agent's composer).

**Idempotency.** Receipts live in the daemon's shared send path — the desktop
uses the same store — keyed by `(owner, clientMessageId)`; owners are
`device:<id>`, `operator` and `desktop`, and none can read another's receipts.
The daemon looks the id up and inserts `pending` in one synchronous step, and
persists it before any write. The same id with the same fingerprint replays the
stored outcome (`replayed:true`), or answers `202 {state:"pending"}` while the
first dispatch is still running. It never dispatches twice. A `pending` receipt
found after a daemon restart is final-uncertain: a re-POST replays
`{result:"unconfirmed", error:"delivery-unconfirmed", effect:"uncertain"}`.

Two refinements of the draft contract, on purpose:

- **Replay runs before binding resolution.** A retry after the agent exited
  replays the stored outcome instead of answering `no-conversation`.
- **The fingerprint is `(pane, agentSessionId, historyEpoch, text)`, without the
  pane incarnation.** A retry after a pane restart replays rather than
  answering `message-id-conflict`.

Every daemon answer carries `effect`, and `result` (the desktop's verbatim enum)
whenever the send reached a verdict. **Act on `effect`**: the same `unconfirmed`
means "refused, nothing typed" on Claude/Codex and "may have been delivered" on
OpenCode.

| `effect` | Meaning | Client |
| --- | --- | --- |
| `none` | nothing reached the PTY or the native client | text back to the draft; the user may send again |
| `uncertain` | something may have reached it | lock the entry; check the receipt, then Terminal; **never resend** |
| `submitted` | the submit step completed (Enter written, `promptAsync` accepted) | final; not proof the agent processed it |

| Outcome | HTTP | Body | `effect` |
| --- | --- | --- | --- |
| sent | 202 | `{result:"sent", replayed:false, clientMessageId, queued?:true}` | `submitted` |
| replay of a final outcome | 200 | the stored body, `replayed:true` | stored |
| replay of a receipt left `pending` by a daemon restart | 200 | `{error:"delivery-unconfirmed", result:"unconfirmed", replayed:true}` | `uncertain` |
| same id, first dispatch still running | 202 | `{state:"pending", replayed:true, clientMessageId}` | absent — poll the receipt |
| per-pane fence, agent not ready | 409 | `{error:"chat-busy", result:"busy"}` | `none` |
| approval or dialog open | 409 | `{error:"chat-blocked", result:"blocked", blockedBy:"approval"\|"terminal"}` | `none` |
| native id or epoch changed | 409 | `{error:"session-changed", result:"session_changed", agentSessionId?, historyEpoch?}` | `none` |
| agent not alive or plugin unreachable before the write | 409 | `{error:"chat-unavailable", result:"unavailable"}` | `none` |
| Claude/Codex input line not provably empty | 409 | `{error:"input-not-provably-empty", result:"unconfirmed"}` | `none` |
| safety proof changed after the paste, before Enter | 409 | `{error:"send-interrupted", result:"error"}` | `uncertain` |
| OpenCode dispatch outcome unknown, or the dispatch failed internally | 409 | `{error:"delivery-unconfirmed", result:"unconfirmed"}` | `uncertain` |
| grant withdrawn between paste and Enter | 401 | `{error:"authorization-expired", result:"error"}` | `uncertain` |
| grant withdrawn, or connection closed, before the first write | 401 | `{error:"authorization-expired", result:"error"}` | `none` |
| schema or validation refusal, malformed `clientMessageId` | 400 | `{error:"invalid-chat-request", result?:"error", detail?}` | `none` |
| over 16,000 units or the OpenCode byte budget | 400 | `{error:"text-too-long", result:"error", limit:"units"\|"bytes", maxSendBytes?}` | `none` |
| id 24 h old or clock ahead | 400 | `{error:"message-id-expired"}` | `none` — settle as "check Terminal", not draft |
| same id, different fingerprint | 409 | `{error:"message-id-conflict"}` | `none` — id is spent; a new Send mints a new id |
| no conversation (use launch) | 409 | `{error:"no-conversation"}` | `none` |
| managed record | 409 | `{error:"managed-read-only"}` | `none` |
| receipt store full (10,000 receipts inside 24 h) | 409 | `{error:"message-history-full"}` | `none` |
| receipt store unavailable, or `pending` could not be persisted | 500 | `{error:"chat-persist-failed"}` | `none` |
| OpenCode plugin holds 512 unexpired receipts | 409 | `{error:"opencode-receipts-full", result:"unavailable"}` | `none` — "restart OpenCode in Terminal" |
| send path threw inside the route | 500 | `{error:"chat-send-failed", clientMessageId}` | absent — **unknown**, poll the receipt |

Every body also carries `clientMessageId` (on a schema refusal, only when the
body had a string one).

**Mid-turn sends (Claude).** A Claude pane whose turn is still running accepts a
send when its empty composer is on screen, the same rule the desktop Chat view
uses: Claude's composer queues the prompt and runs it after the current turn.
The daemon decides this from the pane's fresh screen and state, never from the
request. Such a send answers `202` with `queued:true` (kept on replay and in the
receipt); show it as queued until its `user_text` row appears in `/turns`. Absent
`queued` means the prompt was submitted into an idle agent. A running Claude
turn with a draft in the composer still answers `chat-busy`, and a running
Codex turn is refused as before (`chat-busy` or `input-not-provably-empty`).

`opencode-receipts-full` reaches the daemon from the plugin as
`{result:"unavailable", reason:"receipts-full"}`, so a daemon that predates the
reason still reads it as a plain refusal. The plugin drops receipts past the id
retention before it refuses, and never evicts a younger one.

Errors the route gates produce before the daemon sees the send carry no
`effect`: 403 (`--allow-transcript` off, no input permission, or input
permission gone after the body), `404 session not found`,
`503 chat-unavailable` (no chat bridge), 413, 400 `invalid JSON body`,
`401 authorization-expired` (the caller failed re-authentication after the
body) and `409 pane-incarnation-changed`. A 4xx without `effect` is `none`. A
5xx without `effect`, or no response at all, is **unknown** — poll the receipt,
never assume `none`.

### Send receipt: `GET /api/sessions/<id>/chat/messages/<clientMessageId>`

```
→ 200 {clientMessageId, state, result?, error?, queued?, agentSessionId?, historyEpoch?, at?}
→ 404 {error: 'session not found'}
```

Read-only and bound to the owner **and the pane**; it needs `--allow-transcript`
but **not** input permission, so a device whose input grant was withdrawn still
learns whether its send landed. `at` is the id's own time prefix. `queued:true`
rides on a `submitted` receipt the agent queued behind its running turn.

| `state` | Client |
| --- | --- |
| `pending` | dispatch still running; check again in 5 s |
| `submitted` | final |
| `refused` | final, `effect:"none"`; text back to the draft |
| `uncertain` | final-uncertain; check Terminal. A `pending` found after a daemon restart reads `uncertain` |
| `unknown` | no receipt for this owner, pane and id: the POST never reached the store. Safe to POST again **with the same id**, only while the id is younger than 24 h and `/turns` still shows the same `agentSessionId` and `historyEpoch` |

Poll every `unknown` or `pending` entry every 5 s, even with a healthy SSE —
nothing on `/api/events` names a send. `404` means the pane is gone: settle the
entry as "check Terminal" and stop polling. Retention is 24 hours from the id's
time prefix.

### Launch: `POST /api/sessions/<id>/chat/launch`

```json
{ "agent": "codex", "mode": "default",
  "clientLaunchId": "1758712345123-0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
  "prompt": "explain the test layout\ndo not edit files" }
```

Starts `claude` or `codex` in the pane's own empty shell with the first message,
through the same daemon function the desktop uses. Same grants and
post-body re-authentication as send, 16 KiB body cap. `agent ∈ {claude, codex}`;
`prompt` non-blank, at most 2,000 UTF-16 units, newlines allowed, no other
control characters; `clientLaunchId` has the send id format (malformed →
`400 invalid-chat-request`) and a **10-minute** age limit, 60 s clock skew
allowed (`launch-id-expired`). Model, effort, arguments, command, cwd and
environment are refused; model and effort for new panes stay on
`POST /api/sessions {agentLaunch}`.

The daemon re-authorizes once more as the last await before the launcher is
typed; a withdrawn grant or a closed connection types nothing
(`401 authorization-expired`, `effect:"none"`).

**Dangerous modes.** `mode:"bypass"` (Claude, `--dangerously-skip-permissions`) and
`mode:"yolo"` (Codex, `--dangerously-bypass-approvals-and-sandbox`) need both:

1. the host's ceiling, **off by default**: `wmux web --allow-dangerous-launch`.
   Without it the route answers `403 {error:'dangerous-launch-disabled: …'}` and
   `chatLaunchModes` lists only `default`. There is no per-device grant: once the
   operator opens the ceiling, every input-capable caller may use it;
2. `confirm` equal to `"<agent>:<mode>"` exactly (e.g. `"codex:yolo"`), set only
   by a confirmation step for that combination. Missing or different →
   `428 {error:'dangerous-mode-unconfirmed'}`.

The ceiling is re-read after the body and again before typing. `claude+yolo` or
`codex+bypass` is `400 invalid-chat-request`. A dangerous launch that is typed,
or ends `launch-unconfirmed`, raises a notification on the host; those outcomes
and the two refusals above are written to the daemon's audit log (no prompt
text). Reset the mode to `default` after every attempt and whenever the agent
changes; never persist it.

| Outcome | HTTP | Body | `effect` |
| --- | --- | --- | --- |
| launcher typed | 202 | `{ok:true, replayed:false, clientLaunchId}` | `submitted` |
| replay | 200 | stored body, `replayed:true` | stored |
| same id, first attempt still running | 202 | `{state:"pending", replayed:true, clientLaunchId}` | absent |
| launch receipt store full | 429 | `{error:"launch-busy"}` | `none` — retry later |
| another launch running on this pane | 409 | `{error:"launch-pending"}` | `none` |
| pane already has a conversation | 409 | `{error:"conversation-exists"}` | `none` |
| shell not ready | 409 | `{error:"launch-not-ready", reason:"shell-not-empty"\|"shell-busy"\|"approval-pending"\|"not-integrated"}` | `none` |
| shell cannot launch | 409 | `{error:"launch-unsupported", reason:"unsupported-shell"\|"shell-has-children"}` | `none` |
| same id, different request | 409 | `{error:"launch-id-conflict"}` | `none` |
| malformed id or request | 400 | `{error:"invalid-chat-request", detail?}` | `none` |
| id expired | 400 | `{error:"launch-id-expired"}` | `none` — "check Terminal" |
| dangerous mode refused | 403 / 428 | see above | `none` |
| grant withdrawn or connection closed before typing | 401 | `{error:"authorization-expired"}` | `none` |
| launcher not installed | 409 | `{error:"agent-not-installed"}` | `none` |
| Codex native runtime could not start | 502 | `{error:"agent-runtime-unavailable"}` | `none` |
| failure provably before typing | 502 | `{error:"launch-unconfirmed"}` | `none` |
| failure once typing started | 502 | `{error:"launch-unconfirmed"}` | `uncertain` |

Every body also carries `clientLaunchId` when the request had one.
`unsupported-shell` means a WSL pane, a Windows host, or a shell other than
zsh, bash or sh. A shell process that is gone at the idle check reads as
`launch-not-ready` with `shell-busy` (the pane is being torn down). The launch
fingerprint is `(pane, incarnation, agent, mode, prompt)`: unlike send, a retry
after a pane restart is `launch-id-conflict`.

`202` means the launcher line was typed, not that the agent started: login and
trust prompts are answered in Terminal. Watch `/turns` until `chat.binding` is
`terminal` with an `agentSessionId`, and give up after 60 s with "check Terminal".
`shell-not-empty` clears only after a **completed command** in that shell (tell
the user to run one, e.g. `clear`); `shell-has-children` (a resident helper such
as a prompt theme's status daemon) does not clear by itself.

`GET /api/sessions/<id>/chat/launch/<clientLaunchId>` → `{clientLaunchId, state}`
with `state ∈ pending | submitted | refused | uncertain | unknown`, bound to the
owner and the pane. Like the send receipt it needs `--allow-transcript` but not
input permission. It is memory-only and answers `unknown` after a daemon
restart. A receipt is kept until 10 minutes plus 60 s past the id's own time
prefix; a `pending` one is never dropped, and a full store (256 receipts) never
evicts a live receipt — it refuses new ids with `429 launch-busy` instead.
Retry a launch with the same id only inside 10 minutes, with receipt `unknown`
and `/turns` still `binding:"none"` with `launch.ready`; if the binding became
`terminal`, the launch happened.

### Native skills: `GET /api/sessions/<id>/commands?agent=claude|codex`

Without `agent` the legacy answer is unchanged. With it (`chatSkills`):

```
→ 200 {state: "ready"|"partial"|"unavailable", reason?: "bridge-outdated",
       commands: [{name, description, source, kind: "skill", invocation}]}
→ 400 {error: "invalid-chat-request", detail}   // agent is not claude or codex
```

Insert `invocation` verbatim followed by a space, keep the arguments after the
leading token, and never send on selection; a bare `/` or `$` cannot be sent.
Refusals (wrong live agent, WSL, a pane that is not live, no directory, a
failed scan) answer `200 {state:"unavailable", commands:[]}`. Codex is
`unavailable` until its account server exists, so offer a retry after launch.
`reason:"bridge-outdated"` reads as unavailable with "update wmux on the
computer". The directory is the pane's spawn directory for Claude (never the
OSC 7 cwd, which pane output can aim), and for Codex the live native thread's
own cwd when the daemon's relay knows it, else the spawn directory. Names and
descriptions only; no bodies, no paths.

### `chat.blocked` / `chat.unblocked` on `/api/events`

```
event: chat.blocked
data: {"sessionId":"pty-7f3c","by":"terminal","agent":"opencode","at":1758712345123}

event: chat.unblocked
data: {"sessionId":"pty-7f3c","at":1758712399000}
```

**Live-only**, like `transcript.nudge`: no `id:`, not in the backlog, never
replayed, only for panes whose `/turns` you have read, never for the brain pane.
`by` is `approval` (carries `approvalId`; dedupe with the `approval` event) or
`terminal`; treat an unknown value as `terminal`. A `terminal_prompt` reads as
`approval` only on a stream opened with the `terminal-prompt-answer`
capability header, and only while the record is answerable. Only transitions emit: the
first `chat.blocked` value the server observes for a pane is recorded without
an event (whoever read it just saw it in `/turns`). The server recomputes the
value at most once a second per pane, when an approval opens or closes, the
agent's status changes or a transcript nudge fires, and only while some caller
that read the pane's `/turns` holds `/api/events` open. The events only tell you
to re-read sooner — the authoritative state is `chat.blocked` on `/turns`, so
re-read after every reconnect instead of reconstructing from events. A dialog
seen only on the rendered screen shows on the next `/turns` read (and as
`blockedBy:"terminal"` on a refused send); a send refused that way emits
nothing itself.
