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
| `meta` | `{cols, rows, truncated, omittedBytes, commandRunning?, resumeAgent?}` |
| `snapshot` | base64 of the initial paint |
| `data` | base64 of live PTY bytes |
| `exit` | `1` |
| `agent.liveness` | `{sessionId, state, agent, at}` — what this pane's agent is doing right now |

The first paint is **capped**, and never cut mid-character or mid-escape. When
`truncated` is true, `omittedBytes` says how much history is above — surface it
rather than pretending the buffer starts there.

`commandRunning` (optional, present only when the pane's shell emits OSC 133
prompt markers) is `false` when the shell sits at its prompt. The snapshot
re-arms whatever input modes the pane's output last left on, including mouse
tracking a TUI armed and never disabled; a client that sees `false` should
disarm mouse and focus reporting terminal-side after painting the snapshot
(never bracketed paste — the live shell owns that), or its pointer moves type
mouse reports into the prompt.

`resumeAgent` (optional) is set only for a pane the daemon recovered after its
own restart whose agent has not been re-detected: the process that armed the
modes is known dead, so it is grounds to disarm mouse and focus reporting even
when `commandRunning` is absent (`commandRunning: true` still wins: a fresh
command now owns the modes). It is **not** grounds to clear bracketed paste:
the recovered pane's new shell is alive and owns `?2004`, and `resumeAgent`
persists until the agent is re-detected, so clearing it on every attach breaks
multi-line paste (the first line runs at once). These are the same two inputs
the desktop app gates its own replay reset on.

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
                      gatedTools, gateEnabled?, fleetSidebar?, terminalPromptDetail?,
                      terminalPromptDecline?, protocolVersion, minProtocolVersion,
                      serverVersion, hostPlatform}
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

`terminalPromptDetail: true` says `GET /api/approvals/<id>/detail` is open
(the server runs with `--allow-transcript`);
`terminalPromptDecline` says `POST /api/approvals/<id>/decline` exists and is
`true` only when THIS caller holds the input grant (see
[`terminal_prompt`](#terminal_prompt--the-agents-own-permission-dialog)). Both
are omitted by a daemon that predates them; read a missing key as `false`.

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

Operators turn the grant on with `wmux web --allow-transcript` or, on the
desktop, the **Conversation access** toggle in the Remote popover. Both apply
to a running server in place (same port, token and paired devices), and a
later restart from either keeps it on unless it is turned off explicitly
(`--no-allow-transcript`, the toggle, or `wmux web --stop`). When telling a
user how to enable the Chat view, point at that toggle.

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
GET  /api/approvals/<id>/detail    terminal_prompt only: the full command (see below)
POST /api/approvals/<id>/decline   terminal_prompt only: one Esc (see below)
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

Claude Code's `AskUserQuestion` prompt is natively supported (for `claude` and
its fork `openclaude`, which draws the same select): the daemon extracts the
question, options, and structured choices from the hook payload and maps resolve
decisions to precise TUI keystrokes.

One keystroke answers exactly one shape: a **single single-select question**.
When the question is multi-select, or the tool call carries more than one
question, an approve — with or without `choiceKey` — is refused with 501
`{error:"answer-in-terminal", reason:"needs-v2"}` and nothing is typed (measured
on Claude Code 2.1.283: a digit only toggles one checkbox of a multi-select, and
on the first of several questions it answers that one and moves to the next
tab, so the tool is still waiting). The record stays pending; deny (Esc) still
cancels the whole question.

Claude Code's own **permission dialog** ("Do you want to proceed?") is recorded
as a `terminal_prompt` — see the next section for when it can be answered from
the phone and when it cannot.

**OpenCode** permissions and questions are answered through OpenCode's own
server when its wmux TUI plugin lists decisions (see "OpenCode permissions and
questions" under Decision forms).

**Codex CLI, Kiro CLI, and other TUI-only agents** have no hook integration and
no authoritative keystroke mapping. They report `unsupported-agent` (501). Their
prompts are answered with the phone pane's terminal controls when `--allow-input`
is enabled, or at the desktop otherwise. Structured choice
support for these agents will be added only after their respective projects
expose authoritative approval hooks — the daemon does not guess keystrokes.
A Codex pane that wmux launched is the exception: its command approvals are
answered through Codex's own server (see "Codex approvals"
under Decision forms).

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
| `toolName` (when known), `summary` (the command, ≤200 chars + `…`, display only — the full command is at `/detail`) | yes | yes |
| `risk` (`critical` when the command or rule reads as destructive — `rm -rf`, `sudo`, …) | yes | yes |
| `question`, `reason` | never | only when the record is answerable |
| `choices`, `promptFingerprint` | never | only when the record is answerable, pending and not yet answered |
| `hasDetail: true` (`GET /api/approvals/<id>/detail` has the full command) | never | with `choices`, on a server started with `--allow-transcript` |
| `pressedAt`, `decision`, `selectedChoiceKey`, `resolvedBy`, `resolvedAt` | when set | when set |

Never `options` or `screenTail`. A record is **answerable** only when all of
this holds when it is created:

- the dialog is the ACTIVE one, it offers a plain `Yes`, and no row of it was
  cut by the TUI (a row ending in `…`);
- it is bound to the tool call the agent actually made, with the same tool and
  exactly the command the dialog shows, however long — either
  - by the pane's own Claude transcript: that call is its latest `tool_use`
    with no result yet, BY ITS ID (and a PermissionRequest pending for the
    pane, if any, names the same call), or
  - by the PermissionRequest hook, since Claude Code 2.1.283 often writes the
    `tool_use` only after the dialog is answered and its hook carries no
    `tool_use_id`: the hook's `session_id` is the pane's own Claude session,
    it is the ONLY PermissionRequest pending on the pane (two at once → not
    answerable), it arrived after the pane's previous dialog settled, no key
    reached the pane and the PTY is the same since it arrived, the dialog's
    title names the hook's tool, and the rows spell the hook's whole command.
    `prompt_id` is compared when present, never proof on its own. A transcript
    call that appears later must be that same call; The rows are matched against the
  call's WHOLE command, including where the TUI broke a row inside a word (a
  long path) and the `│` gutter newer Claude Code builds draw left of it; a
  wrapped option label is one option;
- **either** the whole dialog is on screen (its top rule, a full-width rule row
  at column 0, and its title), **or** its top scrolled off a short pane and
  then: the PermissionRequest hook fired for exactly that call (an unanswered
  `tool_use` is also what a RUNNING tool looks like, and its output can print a
  look-alike dialog), it is provably the ONLY unanswered call (no parallel
  calls, and the transcript window read shows where the batch starts), at
  least one command row is still on screen and is the tail of that
  call's command, and the question row and every option row down to the footer
  are on screen. If the option row to press is off screen the dialog is not
  active and the record is informational.

There is no length limit any more: a command longer than the 200-character
`summary` is answerable. The `summary` is still capped (it travels on SSE, the
push and `approvals.json`); fetch the whole command from `/detail`.

A dialog found only on the screen, with no pending call to bind to or a call
whose command differs, is **informational for everyone**. `summary` and `risk`
come from the call's own input.

`choices` then holds only the plain `Yes` and a plain `No` (`No`, or `No, …`
such as "No, and tell Claude what to do differently"). An option that writes a
lasting rule — "Yes, and don't ask again for … commands", anything with
"always" or "for this session" — is never a choice. A record that is not
answerable carries none of the four fields for anyone; show it as "answer on
the computer".

`promptFingerprint` is a 32-hex hash of the whole dialog as drawn (title when
visible, question, reason, every visible command line, every option), the tool
call it is bound to (its `tool_use` id AND a hash of its whole input, so a
command longer than anything the screen or the record shows is covered in
full) and the pane's input epoch, independent of where the cursor is. The same
dialog for the next, identical call is a different record with a different
fingerprint; a call whose input changed after you read the record fails with
409 `prompt-changed`. Whitespace runs in the dialog collapse to one space and
are never dropped. A resize that moves where the TUI broke a long word
changes the hash; the record is then refreshed once.

**Every remote key is proved first.** Before writing `1` (answer) or Esc
(decline) the daemon re-reads the screen and requires: the same transcript
call id and whole-input hash still pending, the same PTY and no key or click
in the pane since the record was CREATED, the same dialog text, and its rows
still spelling that call's command. If any of it cannot be shown it writes
nothing and refuses (409 `prompt-changed` / `prompt-unverified`, 410 when the
record ended), with `effect: "none"`.

**The full command** (servers started with `--allow-transcript`; capable clients):

```http
GET /api/approvals/<id>/detail
```

200 `{"id","toolName"?,"command","commandHash","commandBytes","truncated"}` —
`command` is the call's full command (Bash) or path/url, up to 64 KiB
(`truncated: true` past that, cut on a character boundary); `commandHash` is
the lowercase hex sha256 of the FULL command's UTF-8 bytes and `commandBytes`
its UTF-8 length, both over the whole text even when `command` was cut.
`Cache-Control: no-store`. It is transcript content, so it needs what the
transcript needs: 403 `transcript-disabled` on a server without
`--allow-transcript`, and 501 `answer-in-terminal` without
`terminal-prompt-answer` in `X-Wmux-Client-Caps` (the capability that shows
the dialog's question). No input grant — it types nothing. 404 for an unknown id, a settled record, another
kind, a record that is not bound to its call (informational), and — for a
paired device — the orchestrator brain's pane. It is never on the record, so
never on SSE, a push or `approvals.json`. Offer it when the record has
`hasDetail: true`.

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
| 501 | `{error:"answer-in-terminal", reason}` | Not answerable remotely: no capability header (`reason:"no-capability"`), or the record is not answerable (`reason:"unsupported-shape"`; checked before the body, so a record without a fingerprint is 501, not 400). Answer on the computer |

Without the capability header every answer is 501 `answer-in-terminal`: show
"wmux cannot answer this agent remotely. Open the pane on the computer."

**Declining** (capability `terminal-prompt-decline`, advertised in
`/api/config` as `terminalPromptDecline`):

```http
POST /api/approvals/<id>/decline
X-Wmux-Client-Caps: terminal-prompt-answer, terminal-prompt-decline
Content-Type: application/json

{"promptFingerprint":"<hex>"}
```

The body may be `{}`; `promptFingerprint` is optional (when sent it must be
the record's), and `decision` / `via`, if sent, must be `"deny"` /
`"escape"`. The daemon writes exactly ONE Esc — the dialog's own cancel — and
only when it can PROVE the dialog on screen is the one this record was made
for (see "Every remote key is proved first" above): never "some dialog is
active". It also waits out the same 1.5 s after the record appeared as an
answer (425). The record must have been matched to its transcript call when
it was created — its rows spelled that call's command — else 409
`prompt-unverified`. That includes a matched record the phone cannot answer
Yes/No (a row the TUI cut, no plain `Yes`): decline is then the one way to
cancel it remotely. A card created before any dialog was drawn, or for a
dialog that shows a different command, cannot be declined. It needs the input grant (403
otherwise, checked before and after the body and again right before the
write) and is audit-logged like an answer. On success: 200
`{"state":"pending","pressedAt":<ms>,"via":"escape","durable":true}`; the record
then resolves (with `decision: "deny"`, no `selectedChoiceKey`) once the
dialog is seen gone. Claude Code treats Esc as "No, interrupt": the turn stops
with "Interrupted · What should Claude do instead?".

Every refusal writes nothing and carries `effect: "none"`:

| Status | Body | Meaning |
| --- | --- | --- |
| 409 | `{error:"already-resolved", resolvedBy?, effect}` | The record already settled (answered anywhere, dialog gone) |
| 409 | `{error:"already-answered", effect}` | A phone already answered or declined it; waiting for the dialog to close |
| 409 | `{error:"prompt-changed", effect}` | No active dialog on the pane now, a different one, another call pending, a key/click or a new PTY since the record was created, or a stale `promptFingerprint` |
| 409 | `{error:"prompt-unverified", effect}` | The record was never matched to one transcript call on screen |
| 425 | `{error:"answer-too-soon", effect}` | Within 1.5 s of the record appearing. Ask again |
| 410 | `{error:"expired", state?, effect}` | The record ended without an answer (turn ended, pane gone, replaced) |
| 400 | `{error:"invalid-prompt-fingerprint"}` / `{error:"decision must be 'deny'"}` / `{error:"via must be 'escape'"}` / `{error:"not-a-terminal-prompt"}` | Bad body, or the id is another kind |
| 403 | `{error:"read-only: …"}` | No input grant |
| 404 | `{error:"not-found"}` | Unknown id, or (device) the brain's pane |
| 501 | `{error:"answer-in-terminal"}` | No `terminal-prompt-decline` in `X-Wmux-Client-Caps` |

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
sending another or losing it. The push is not sent the moment the dialog
appears: the record must still be pending after a 12 s grace
(`TERMINAL_PROMPT_PUSH_GRACE_MS`), so a dialog answered at the desk or gone on
its own never reaches the phone. A record that ends after its push went out is
followed by a retraction under the same collapse id (§7, "Retraction"). It is
always in-app only (`requiresInAppChoice:
true`, no lock-screen buttons, for any client) and carries
`approvalKind: "terminal_prompt"`. The body names the tool and the command;
`risk` is `critical` when the command or the permission rule reads as
destructive (`rm -rf`, `sudo`, …). The outbound webhook (`notifySinks`) never
carries the command.

**The SSE `approval` event** for this kind carries `kind: "terminal_prompt"` and
`risk` when set, and no content (no tool, summary, question or choices): re-read
`/api/approvals`.

**History.** `recentlyResolved` lists a `terminal_prompt` only when a phone
answered or declined it (`pressedAt` set), decided from the record alone —
the same rows for every client. A record the daemon replaced before anyone
pressed (every key in the pane and every late parse mints one) and a card
that expired when its dialog closed are not answers anyone gave from a phone,
and are not listed. A row may carry no `question` (an older client is never
shown it; a record declined without Yes/No choices has none): render
`toolName — summary` then, never "no question".

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
| 409 | `{error: 'prompt-changed'}` | The question is on screen but its options do not all read back, or the pane took a key, a click or a new PTY between the daemon's screen read and its write (or kept drawing through two reads). Nothing typed; still pending — ask again |
| 410 | `{error: 'expired' \| 'prompt-gone', state?}` | The request outlived its usefulness, or its question left the screen (including a different dialog in its place). Stop showing it |
| 422 | `{error: 'invalid-choice-key'}` | The `choiceKey` does not belong to this request's choices, or the option is not visible on screen. The request is still pending — retry with a valid key or omit `choiceKey` |
| 501 | `{error: 'unsupported-agent', reason: 'unsupported-agent'}` | No keystroke map for this agent. Still answerable at the desktop — do not expire it locally |
| 501 | `{error: 'answer-in-terminal', reason: 'needs-v2'}` | A multi-select or multi-question `AskUserQuestion`: one key cannot answer it, so nothing was typed. Still pending — answer it at the desktop, or deny |
| 501 | `{error: 'answer-in-terminal', reason: 'unsupported-shape' \| 'screen-unreadable'}` | The request carries no question text or no choices, so its dialog cannot be identified on screen (`unsupported-shape`), or the daemon cannot read the pane together with its state (`screen-unreadable`). Nothing typed; still pending — answer it at the desktop |
| 404 | `{error: 'not-found'}` | No such request |

#### The 501 `reason`

Every 501 from `POST /api/approvals/:id` carries a one-line `reason` next to
its `error`. Status codes and `error` values are unchanged, so a client that
ignores `reason` behaves exactly as before; one that reads it can say why.

| `reason` | Emitted when |
| --- | --- |
| `no-capability` | The caller cannot answer this kind remotely: no `terminal-prompt-answer` capability header, or an automated resolver |
| `unsupported-shape` | The dialog was not bound and parsed whole (no fingerprint or choices), or an `AskUserQuestion` request carries no question text or choices to identify it by |
| `needs-v2` | The prompt needs more than one keystroke (multi-select, several questions) |
| `unsupported-agent` | No keystroke map for this agent |
| `screen-unreadable` | The daemon cannot read the pane together with its state, so it cannot prove where a key would land |
| `secret-input` | Reserved — no route emits it yet |

Treat an unknown `reason` like a missing one: the set may grow.

Only the Claude Code family (`claude`, `openclaude`) is mapped today.

**Every key is proven first — approve, `choiceKey` and deny alike.** Before
writing, the daemon reads the pane and requires the request's OWN dialog: the
question row, each option row in key order, and Claude's `Type something` row
below them. It reads the pane's state (output, key input, PTY) at that moment
and checks it again, synchronously, right before the write. A request whose
question has gone (Esc sends no hook, so a card can outlive its question) is
never pressed into whatever dialog came next: it answers 410 and expires.
Anything short of the proof answers 409 or 501 and types nothing. Approve sends `1` (the first offered option),
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

### Decision forms (v2)

An additive wire for decisions one key cannot answer (a plan's feedback, a
multi-select, an agent's own permission request). `protocolVersion` does not
change: it is negotiated with a capability, and a client that declares none of
the new tokens reads exactly the bytes it read before.

**Capabilities.** `X-Wmux-Client-Caps` gains `decision-v2` (understands `form`
records and answers them through `/answer`), `chat-cancel` (shows
`capabilities.cancel` and `chat.turn` for `POST /api/sessions/<id>/chat/cancel`;
see Chat cancel) and `chat-queue` (a send carrying it may be held by the
daemon queue; see Chat queue). Keep sending
`terminal-prompt-answer` and `terminal-prompt-decline`; they still govern the
v1 paths.

**`/api/config`.** Next to `terminalPromptDetail` / `terminalPromptDecline`
(so only when approvals are wired):

| Key | Meaning |
| --- | --- |
| `decisionForms` | The form kinds this daemon produces now: any of `permission`, `plan`, `questions`. `plan` while the daemon's `phoneDecisions.stepwise` switch is on (see Plan dialog); `permission` and `questions` (agent-native, OpenCode; see below) while `phoneDecisions.native` is on. Offer a v2 answer only for a kind listed here |
| `chatCancel` | Whether this caller may use `POST /api/sessions/<id>/chat/cancel`: the server runs with `--allow-transcript`, the caller has the input grant, and the chat bridge is wired |
| `chatCancelOutcome` | `true` when `chatCancel` is true and the cancel receipt store loaded; omitted otherwise (never `false`). Advertises `cancel` on the cancel answer, the cancel receipt route and SSE `chat.cancel` (see Chat cancel outcome) |
| `chatQueue` | Whether this caller's `chat-queue` sends are held by the daemon queue, and `DELETE …/chat/queue/<clientMessageId>` is open to it: the same condition as `chatSend`, plus a queue that loaded |

**Advertised = accepted.** The chat write keys (`chatSend`, `chatLaunch`,
`chatQueue`, `chatCancel`, `chatCancelOutcome`) are computed from the same
caller gates their routes (`POST …/chat/messages`, `…/chat/launch`,
`…/chat/cancel`, `DELETE …/chat/queue/<id>`) check before they look at the
pane: `--allow-transcript`, then the input grant, plus a wired chat bridge.
A caller that sees a key is never refused that write with 403 for its grants
or 503 for a missing bridge; the per-pane and per-turn answers (404, and the
refusals such as 409 `turn-already-interrupted`) still apply per request.
Reading a cancel receipt needs none of these keys (see Chat cancel outcome).

**The record.** For a `decision-v2` caller, a record that can still be
answered may carry:

```json
{
  "form": {
    "v": 1,
    "kind": "permission" | "plan" | "questions",
    "questions": [{ "id": "q0", "header": "…", "text": "…", "multiSelect": false,
                    "allowOther": true, "options": [{ "key": "1", "label": "…" }] }],
    "actions": [{ "id": "approve", "label": "…" }, { "id": "feedback", "label": "…", "needsText": true }]
  },
  "formFingerprint": "<32 hex>",
  "step": { "index": 2, "total": 5, "status": "running" | "partial" | "done" }
}
```

Every string inside `form` is agent-authored: render it as text. Options that
would widen what the agent may do without asking again (a lasting rule,
auto/bypass modes, "always") are never offered as `actions`. The SSE
`approval` event does **not** carry the form — it stays a content-free nudge
in the shared replay window; read the form from `/api/approvals`.

**Agent-native decisions.** Some agents hold a permission request on their own
server (OpenCode, Codex). The daemon answers those through that server, never
by typing into the pane. To a client without `decision-v2`, such a permission
is a `terminal_prompt` whose `choices` are exactly
`[{"key":"1","label":"Yes"},{"key":"2","label":"No"}]` and whose
`promptFingerprint` is the form's, so the v1 answer path works unchanged. Its
200 is `{state: 'resolved', durable}` with **no** `pressedAt` (nothing was
typed). It has no `hasDetail`, and `/detail` is 404 for it. `/decline`
rejects it through the agent's server — no Esc — and answers
`via: 'native'`; a native question (`awaiting_input`) can be declined too, and
a `decision-v2` caller may decline one without `terminal-prompt-decline`. Raw
`POST /api/input` to its pane is not refused with `terminal-prompt-active`.
Every native decision needs the input grant, on every route (403 otherwise).
Only a phone or browser can answer one: the desktop answers it in the agent's
own terminal.

A native **question** with one single-select question keeps its `choices`
(when every option key is a 1–2 digit number) and is answered like an
`AskUserQuestion`: `{decision: 'approve', choiceKey}` from any client, no
capability header needed; `deny` rejects it. Several questions or a
multi-select carry no choices; approve answers 501 `needs-v2`.

Extra outcomes on the v1 route and `/decline` for a native decision:

| Status | Body | Meaning |
| --- | --- | --- |
| 503 | `{error: 'agent-unavailable', effect: 'none'}` | The agent's server could not be reached. Nothing was delivered; retry |
| 409 | `{error: 'answer-uncertain', effect: 'uncertain'}` | The agent's server did not confirm within 10 s. The answer may have landed; the card stays up until the agent settles it. Do not retry blindly — re-read the list |

A card for a native request that was answered or went away is not raised
again for that request. With the daemon's `phoneDecisions.native` switch off,
a native decision is an informational card (no `choices`, no `form`): it
cannot be answered or declined from a phone even after the switch is turned
back on, and it still never blocks typing into its pane.

#### Codex approvals

A Codex pane that wmux launched with a relay (`POST /api/sessions
{agentLaunch}` or chat launch) talks to Codex's account server through that
per-pane relay. The relay turns Codex's command approvals
(`item/commandExecution/requestApproval`) into native permission decisions
(`agent: 'codex'`, `kind: 'terminal_prompt'`): `question` is Codex's `reason`
(else `Run this command?`), `summary` the command, `toolName` `command`.

- **Yes** is Codex's `accept`. **No** (`choiceKey` `2`, or `/decline`) is
  Codex's `cancel`: the same answer as Esc in the Codex TUI, and like Esc it
  **interrupts the whole turn**. The v1 `choices` stay exactly `Yes` / `No`;
  the `decision-v2` form's deny action is labelled `No, stop the turn`. Say so
  on the No button either way.
- Only a request that lists its own `availableDecisions`, including both
  `accept` and `cancel`, becomes a decision. Choices that grant lasting permission
  (`acceptForSession`, `acceptWithExecpolicyAmendment`) are never offered.
  File changes (`item/fileChange/requestApproval`) stay in the terminal: the
  request carries neither the files nor the diff. MCP elicitation,
  `requestUserInput` and other Codex requests stay there too: no card.
- One card per prompt: the question-less card Codex's `PermissionRequest` hook
  raises on that pane is replaced by the decision, and not raised again while
  the decision is pending.
- The request must belong to a thread this pane started, resumed or forked.
  Another pane subscribed to the same thread gets no card for it.
- The Codex overlay in the pane closes by itself once the phone answers. The
  answer is final (200) only once Codex's server reports the request resolved
  after it. If that does not happen within 5 s (the request was answered
  elsewhere at the same moment, the connection dropped), the answer is 409
  `answer-uncertain` and the card expires: re-read the pane.
- A daemon restart expires every pending Codex decision.
- The card expires when the request is answered anywhere else (the Codex TUI,
  another client), when its turn ends, or when the pane's relay goes away
  (for example the account server restarted). A phone answer after that is
  410 `prompt-gone` / `expired`.
- A Codex started by typing `codex` in a shell (no relay) produces no native
  decision; its prompts are answered in the terminal as before.

#### `POST /api/approvals/<id>/answer`

Requires `decision-v2` (else 501 `no-capability`) and the input grant (403),
re-checked after the body and immediately before the answer takes effect. The
orchestrator brain's pane is a 404 for a device. Body — unknown fields are 400:

```json
{ "formFingerprint": "<32 hex>", "clientAnswerId": "<16-128 of [A-Za-z0-9-]>",
  "action": "<actions[].id>",
  "answers": [{ "questionId": "q0", "keys": ["1", "3"], "other": "text" }],
  "text": "feedback text" }
```

At least one of `action` / `answers`. `text` and `other` refuse every C0
control character (newline included — it would submit a dialog field early),
DEL, every C1 control (U+0080–U+009F), U+2028 / U+2029, whitespace-only text,
and more than 2,000 UTF-16 units. The daemon never stores the text itself.

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{state, effect: 'complete', durable}` | Done |
| 202 | `{state: 'pending', replayed: true}` | The same `clientAnswerId` is still running — poll the receipt |
| 400 | `{error: 'invalid-body' \| 'invalid-text' \| 'invalid-choice' \| 'invalid-prompt-fingerprint'}` | Nothing happened |
| 401 | `{error: 'authorization-expired'}` | |
| 403 | read-only | No input grant |
| 404 | `{error: 'not-found'}` | No such request (or a brain pane) |
| 409 | `{error: 'already-resolved' \| 'already-answered' \| 'prompt-changed', effect: 'none' \| 'partial', step?}` | Someone else answered, or the screen moved (`partial`: some keys of a stepwise answer were typed; the record stays pending and answers `already-answered` from then on) |
| 409 | `{error: 'answer-id-reused', effect: 'none'}` | This `clientAnswerId` was used for another body |
| 409 | `{error: 'answer-uncertain', effect: 'uncertain'}` | It was running when the daemon stopped, or the agent's server did not confirm it in time; it may or may not have landed and is never re-run |
| 410 | `{error: 'expired' \| 'prompt-gone', effect: 'none'}` | The request is gone (an agent that no longer holds it included) |
| 425 | `{error: 'answer-too-soon', effect: 'none'}` | Within 1.5 s of the request appearing |
| 429 | `{error: 'answer-receipts-full', effect: 'none'}` | 512 live receipts for this caller |
| 501 | `{error: 'answer-in-terminal', reason}` | `reason` as for the v1 route. `unsupported-shape` for every record whose form kind is not in `decisionForms` |
| 500 | `{error: 'internal-error' \| 'approvals unavailable'}` | Retry |
| 503 | `{error: 'authorization-unconfirmed' \| 'agent-unavailable' \| 'approvals unavailable' \| 'answer-receipts-unavailable'}` | Retry |

A final response is kept for 24 hours under `(caller, clientAnswerId)`: the
same id and body again returns it with `replayed: true` — even after the
request has left `/api/approvals` (the receipt is looked up before the
request). Not kept, so a retry with the same id is checked afresh: 401, 403,
425, 500, 503, and 409 `already-answered` (another answer was in flight).
Everything else is final, including 409 `answer-uncertain`. A 400 is never
journaled (the body is refused before the receipt), and neither is a 404 for a
request that no longer exists when there is no receipt for it.

#### Plan dialog (`form.kind: 'plan'`)

Claude Code's ExitPlanMode dialog ("Would you like to proceed?") is a
`terminal_prompt` record with `toolName: 'ExitPlanMode'` and a `summary` taken
from the plan's first line. It never carries `choices`: a client without
`decision-v2` shows it as an informational card, and `/decline` (one Esc)
rejects the plan exactly as Esc at the terminal does — Claude ends the turn and
stays in plan mode.

For a `decision-v2` caller the pending record also carries `question` (the
dialog's own sentence), `hasDetail: true` when the transcript grant is on
(`GET /api/approvals/<id>/detail` returns the whole plan as `command`; for a
plan, `decision-v2` alone opens it), and:

```json
{ "form": { "v": 1, "kind": "plan", "actions": [
    { "id": "approve-manual", "label": "Yes, manually approve edits" },
    { "id": "feedback", "label": "Tell Claude what to change", "needsText": true } ] },
  "formFingerprint": "<32 hex>" }
```

Labels are the dialog's own, read off the screen. The rows that switch the
session's permission mode ("Yes, and use auto mode") are never actions, and a
dialog that offers bypass permissions (Claude started with
`--allow-dangerously-skip-permissions`) gets no form at all.

- `{action: 'approve-manual'}` — one key, the row's own number. 200
  `{state: 'pending', effect: 'complete'}`; the record resolves when the dialog
  closes, like a v1 answer. No `text`.
- `{action: 'feedback', text?}` — rejects the plan with the text, and Claude
  plans again (a new record). The daemon types the row's number, the text as
  one bracketed paste, checks the text is echoed in the field, then Enter.
  Without `text` it rejects the plan with no feedback. 200
  `{state: 'resolved', effect: 'complete'}`. The text must fit the field the
  pane can show whole: at most `(cols - 12) × (rows - 14)` columns (a wide
  character counts two), capped at 2,000. A longer one is 400
  `invalid-text` with nothing typed.

Once a feedback answer has typed its first key, the record carries `step` and
no longer carries `form`. A key typed at the terminal meanwhile (or a screen
that does not show what the last key should have drawn in time) stops it:
409 `{error: 'prompt-changed', effect: 'partial', step: {index, total,
status: 'partial'}}`. Whatever stops an answer after its first key — a lost
grant (401/403), the turn ending (410) — the response carries `effect:
'partial'` and `step` too, and its receipt is kept as `partial`. Nothing is
typed to undo it; the record stays pending, answers `already-answered` (to
`/decline` too) and settles when the dialog is answered at the terminal. A key typed at the terminal before the answer (or a
changed dialog) is 409 `prompt-changed` with `effect: 'none'`, and the record
is replaced by a fresh one — re-read the list.

#### OpenCode permissions and questions

With the wmux OpenCode TUI plugin that lists decisions (it advertises
`decisions` in its actions; `wmux.js` 0.3.0 signals them), each pending
OpenCode permission and question is its own agent-native record under the
pane. A pane can hold several at once; answering one never touches another.

- **Which requests.** The ones the desktop TUI draws on the session it shows:
  that session's own requests and its direct sub-agents'. A request the TUI
  would not draw (a sub-agent's sub-agent, or any request while the TUI shows
  a sub-agent's own session) gets no record. A record stays up when the TUI
  switches to another session: the answer goes to the request's own session,
  whatever the TUI shows, and the pane reads `awaiting_input` while a
  sub-agent's request is pending.
- **Permission.** `form.kind: 'permission'`, actions `approve` (OpenCode's
  "Allow once") and `deny` ("Reject"). OpenCode's "Allow always" is never
  offered and the plugin refuses it. A shipped phone sees the plain Yes/No
  `terminal_prompt` described above; `question` is `Allow <permission>?`,
  `toolName` the permission, `summary` its patterns (the command).
- **Question.** `form.kind: 'questions'`, one entry per OpenCode question with
  numbered option keys, `multiSelect` from `multiple` and `allowOther` from
  `custom` (on unless the agent turned it off). Answer with `answers` covering
  every question (no `action`, or `submit`): the chosen `keys`, plus `other`
  for a typed answer where `allowOther` is true; a single-select question takes
  exactly one of them. `action: 'deny'` dismisses the whole question. `text`
  is refused (400 `invalid-choice`), as is anything that does not fit the form.
  A request too large to show whole (more than 8 questions or 16 options, an
  option label over 200 characters, a long command) gets no form: it stays the
  informational card below.
- **Stale.** A request that now asks something else than the card showed is a
  new card (new fingerprint); an answer to the old one is refused (409
  `prompt-changed`, or `already-resolved` once it was replaced).
- **Gone.** An answer in the terminal first, or a request OpenCode no longer
  holds, expires the record (410 for a late answer). The daemon re-reads the
  plugin when OpenCode reports an answer and on `GET /api/approvals`, so a
  record can appear or leave shortly after the list that triggered it (SSE
  carries the change).
- **Older plugin.** A plugin without `decisions` keeps today's informational
  card (501 `unsupported-agent`).

#### `GET /api/approvals/<id>/answer/<clientAnswerId>`

The caller's own receipt (another device's is a 404):
`{clientAnswerId, approvalId, state: 'inFlight' | 'done' | 'partial' | 'refused' | 'uncertain', effect?, status?, result?}`,
where `status` / `result` are the stored final response.

### Chat cancel

`POST /api/sessions/<id>/chat/cancel` writes one Esc into a running Claude or
Codex turn, or asks the OpenCode plugin to abort one (see OpenCode below). The chat object's `capabilities.cancel` is passed through only to
a caller that sends the `chat-cancel` capability; every other client keeps
`cancel: false`. The route itself does not require the capability.

Body `{agentSessionId, clientCancelId, turnId?, historyEpoch?}`; it is gated
like a send. 202 `{result:"sent", turnId, clientCancelId,
effect:"interrupt-requested"}` means one Esc was written; whether the agent
stopped shows later on `chat.turn`. `turnId` and `historyEpoch` are either
omitted or non-empty; an empty string is 400 `invalid-chat-request`. A repeat
with the same `clientCancelId` and body replays the first answer with
`replayed:true`: 200 for a sent Esc, and the original status for a failure
(500 `cancel-failed` with `effect:"uncertain"` when the write may or may not
have landed). Refusals are 409 `turn-not-running` `{turn}`, `prompt-active`
`{by, approvalId?}`, `session-changed`, `chat-busy`, `cancel-cooldown`
`{retryAfterMs}`, `turn-already-interrupted` `{turnId}` or
`cancel-id-conflict`; 422 `cancel-unsupported`; 404 `pane-not-found`; 507
`message-history-full` when the receipt store is full. The
daemon writes the Esc only on positive evidence that the agent is working
right now. That means either its working row on screen (Claude's spinner row
with its counter, Codex's `esc to interrupt` row) or its running spinner in
the window title, refreshed within the last 3 seconds (Claude `◐`/`◑`, Codex
a braille frame). The title is what remains while answer text streams. A
turn that has just ended is refused as `turn-not-running`, even while its
row is still drawn. That covers a recorded end or interrupt in the
transcript, an idle title the agent set during the turn (Claude `✳`, Codex
without a spinner), and Claude's Stop-hook row. A refused cancel stores no
receipt, so the same `clientCancelId` may be retried.

**Cancel and Claude's own queue.** A send made without `chat-queue` during a
running Claude turn goes into Claude's composer queue (`queued:true`). A cancel
of that turn does not bring the message back into the composer: measured with
Claude Code 2.1.283, the Esc interrupts the turn and Claude immediately runs
the queued message as the next turn, so its receipt (`submitted`,
`queued:true`) stays accurate and the cancel answer carries no warning. This
is the agent's behavior, not a wmux guarantee; read the outcome from `/turns`.
A second such send in the same turn was refused with `chat-busy`, so a phone
has at most one message in Claude's queue per turn.

**OpenCode.** An OpenCode chat has no Esc: the cancel asks the wmux plugin
inside the running TUI to abort the selected session. `capabilities.cancel`
is true only when the plugin advertises `abort` and answers reads; an older
plugin keeps `cancel:false` and the route answers 422 `cancel-unsupported`.
The plugin repeats the session and history checks a send makes, so a
switched session is 409 `session-changed`. `chat.turn` comes from the plugin:
its `id` is fixed when the session goes from idle to running (a prompt
accepted, or the TUI seen busy) and is kept until the session is complete;
messages arriving mid-turn do not change it. `startedAt` is when the plugin
saw the turn start, and is absent before the first turn. The plugin aborts
only while the TUI is busy. The agent's own permission or question request
is 409 `prompt-active` (`by:"terminal"`, or `by:"approval"` with its
`approvalId` when the daemon holds a record for it). Any other dialog the
user opened in the TUI (a picker or palette) does not hold the abort and
changes neither `agentStatus`, `blocked` nor `chat.turn`; only a send made
while it is open is refused as `chat-blocked`. Between an accepted send and
the TUI going busy there is nothing to abort yet: that answers 409
`cancel-cooldown` with a short `retryAfterMs`, and a retry after it reaches
the same turn. The Esc once-per-turn latch and cooldown do not apply: an
abort of a turn that has already ended is simply `turn-not-running`. When
the abort request left but its answer was lost, the result is 500
`cancel-failed` with `effect:"uncertain"`, as for a Claude/Codex write.

### Chat cancel outcome

On a daemon that advertises `chatCancelOutcome`, a cancel also reports what
happened after the write, keyed by the same owner-bound `clientCancelId`.
Shared types: `src/shared/phoneChatCancelOutcome.ts`.

**Who may cancel.** The daemon has no per-pane owner: control belongs to the
credential, not to whoever started the turn. A cancel is accepted only when
**all** of these hold. Each is checked when the headers arrive, again after
the body, and again immediately before the interrupt is written:

1. the server runs with `--allow-transcript` and `--allow-input`;
2. the caller may input: the operator token, or a paired, unrevoked device
   whose own `grants.input` is true;
3. the pane resolves for the caller (never the orchestrator brain pane, for
   any credential) and is the same incarnation throughout;
4. the re-authenticated caller is the same caller (same credential class; for
   a device, the same device id);
5. `agentSessionId` (and `historyEpoch` and `turnId` when sent) match the
   pane's current conversation and running turn.

"Only the turn I started" is **not** a rule the daemon can enforce: send
receipts do not record which `chat.turn.id` they started. Any caller that may
control the pane may stop its running turn, as at the keyboard.

**The answer.** `POST …/chat/cancel` is unchanged, and its body stays strict.
A 202 also carries the cancel's progress:

```json
"cancel": { "state": "requested", "turnId": "t1:…", "requestedAt": 1758712345123, "at": 1758712345123 }
```

A replay carries the progress **as it is now** (it may already read `ended`),
whatever the replay's status; that includes the replay of a 500
`cancel-failed` (`unknown`, `write-uncertain`). The first 500 itself carries no
`cancel`: read the receipt.

**The receipt.**

```
GET /api/sessions/<id>/chat/cancel/<clientCancelId>
→ 200 {
    "clientCancelId": "…",
    "state": "requested" | "ended" | "not-ended" | "unknown" | "none",
    "turnId": "t1:…",                                   // aimed turn, when known
    "endedAs": "interrupted" | "completed" | "failed" | "unspecified",   // ended only
    "evidence": "native" | "transcript" | "screen",     // ended only
    "reason": "write-uncertain" | "daemon-restart" | "pane-closed" | "session-changed",  // unknown only, when known; open set
    "requestedAt": 1758712345123,                       // absent after a daemon restart
    "at": 1758712349000
  }
→ 404 {error: "pane-not-found"}
→ 403 transcript refusal (as `/turns`)
→ 503 {error: "chat-persist-failed"}   // no receipt store (the key is also omitted)
```

Owner-bound (a device reads only its own cancels) and pane-bound; needs
`--allow-transcript`, not input, so a device whose input grant was withdrawn
still learns what its cancel did. `none` means there is no receipt for this
owner, pane and id: it was never written, or it was refused (a refusal stores
nothing).

**When a receipt can be read.** Reading needs `--allow-transcript` (the
`allowTranscript` key in `/api/config`) and the same owner: the credential
that sent the cancel, i.e. the operator token or that device id. It does not
need the input grant and it is not signalled by `chatCancelOutcome`, which
stays tied to `chatCancel` and so disappears when input is withdrawn. There
is no separate discovery key for receipt reads: remember that you sent a
cancel to a daemon that advertised `chatCancelOutcome` at the time, and read
its receipt by `clientCancelId` afterwards. A daemon without a receipt store
answers 503 `chat-persist-failed`.

| `state` | Meaning | Client |
| --- | --- | --- |
| `requested` | written; the aimed turn has not been seen to end | keep "Stopping…", poll every 2 s or wait for `chat.cancel` |
| `ended` | the aimed turn ended after the write | final. `endedAs: "completed"` means it finished on its own first |
| `not-ended` | still running 15 s after the write | final: it never changes, even if the turn ends later. Do **not** offer Stop again for this turn: a turn gets one interrupt (an Esc or a native stop), so a second cancel aimed at it is refused with 409 `turn-already-interrupted`. Re-read `/turns`. If the same turn is still running, force-interrupt it with `chat/interrupt` (key `chatInterrupt`; **planned, not served yet**: no daemon has this route today). A different running turn (a new `chat.turn.id`, started after the write) can be stopped with a new `clientCancelId`. Terminal is only a secondary fallback |
| `unknown` | cannot be known | final; check Terminal |
| `none` | no receipt for this owner, pane and id: never written, refused, expired, or the POST has not reached the daemon yet | not a progress state. If the POST answered, its answer stands (a refusal wrote nothing); otherwise nothing is known to be written. Re-read `/turns` |

What counts as `ended` today (Claude and Codex): the daemon looks at the
pane about once a second for 15 s after the write. Nothing is `ended` while
the aimed `chat.turn` still reads `running`.

**Codex panes with a daemon-owned relay** (phone-created Codex panes on Unix)
stop the turn natively first. The Codex turn the pane's relay stream reports
running is pinned when the cancel arrives. Once every check above has passed
and the receipt is on disk, the daemon sends the app-server's own
`turn/interrupt` for exactly that turn, on a side connection, bounded at 5 s.
Nothing is sent when that turn has already ended or another turn replaced it:
the server holds an interrupt for a finished turn without answering. Only the
pane's own stream reporting `turn/completed` with `status: "interrupted"` for
the pinned turn counts as proof; the request's `{}` answer never does (the
server can answer `{}` for a request it held and then released when some other
turn was interrupted). A turn that ends any other way ends the wait at once.
When no proof arrives, every check (credential, pane, conversation, running
turn, screen) runs again, and the Esc goes out only if the pinned turn is
still the running one. `requestedAt` is the time of the first write, and the
15 s window counts from it; the `chat.cancel` `requested` frame goes out as
soon as the server acknowledges the request. A receipt is never dropped once
the native request may have reached the server: when the Esc is then refused,
the 202 still reads `interrupt-requested` and adds `escRefused` with the
refusal the Esc got (`authorization-expired`, `prompt-active`,
`turn-not-running`, …; fresh answers only, not replays). A native stop counts
as the turn's one interrupt, like an Esc: a later Stop of the same turn, from
the phone or the desktop, is refused as already interrupted. The Codex turn
id never leaves the daemon; the receipt's `turnId` is the `chat.turn.id` as
for the Esc path.

- `evidence: "native"`: the aimed turn is no longer running, the pane's own
  Codex stream reported it `interrupted`, the server acknowledged the native
  request (or the stream proved the stop while waiting for it), and **no Esc
  was written** for this cancel. Only the native path can produce it, so it
  always means a native stop. `endedAs: "interrupted"`.
- Once a fallback Esc was written, the stream is not used as evidence: the
  Codex TUI turns an Esc into the same protocol interrupt, so the stream
  cannot say which write stopped the turn. The Esc path's rules below decide
  (`transcript`, `screen`, or `unknown` when neither proves the end).

- `evidence: "transcript"`: the first record written **after the interrupt**
  is an interrupt or end record. The daemon notes where the transcript stood
  right before the write; an end recorded before that point (an earlier turn
  that a queued prompt merged into the same episode) never counts. An
  interrupt reads `endedAs: "interrupted"`, an end_turn reply or Codex
  `task_complete` reads `completed`.
- `evidence: "screen"`: the aimed turn is no longer running, and an idle title
  the agent set after the write (Claude `✳`, Codex without a spinner) or
  Claude's Stop-hook row is on screen. `endedAs: "unspecified"`. The pane, its
  conversation and the turn are checked again after the screen read.
- The hook stream is not evidence: an interrupt fires no Stop hook.
- `endedAs: "failed"` is not sent yet; `evidence: "native"` only for the
  Codex relay path above.

`unknown` reasons: `write-uncertain` (the write itself may or may not have
landed; from the start), `daemon-restart` (the daemon restarted before an end
was seen), `pane-closed` (the pane closed, is another incarnation or dead, or
was not attached when the window closed), `session-changed` (the pane shows
another conversation). `unknown` **without** a `reason` when the aimed turn's
end cannot be proved: a new prompt or turn start was recorded after the write
before any end, the transcript tail no longer reaches back to the write, or
the turn stopped running with no proof by the 15 s deadline.

**Not served yet.** A Codex pane without a relay (a `codex` typed by hand)
uses the Esc path only. OpenCode: nothing observes the plugin abort yet, so an
OpenCode cancel reads `unknown` (no `reason`) from the start, or `unknown`
(`write-uncertain`) when the abort's answer was lost; `native` evidence from
the plugin's phase is a follow-up.

**Storage.** `chat-cancel-receipts.json` keeps `version: 1`, and
`outcome.effect` keeps its two values. Progress is an optional field next to
`outcome` on each entry: `progress: {state, endedAs?, evidence?, reason?,
at}`. An entry without it reads as `requested` when its outcome is
`interrupt-requested`, and as `unknown` (`write-uncertain`) when it is
`uncertain`. At load, the restart rule that turns a `pending` entry into a
final `uncertain` one also sets `progress` to `unknown` (`daemon-restart`), and
a `requested` progress becomes `unknown` (`daemon-restart`) the same way; the
result is written once, so its `at` does not move on later restarts. An older
daemon reading the file ignores the field. While the write is still in flight
(`pending`, no outcome yet) an entry reads `requested`. A stored `progress` is
normalized on read (`normalizeCancelProgress`) and never makes an entry
invalid: a state outside the union reads `unknown`, fields that do not belong
to the state or fail their check are dropped (`reason` is an open set), and a
malformed `at` falls back to the entry's own time.

**SSE.**

```
event: chat.cancel
data: {"sessionId":"pty-7f3c","clientCancelId":"…","state":"ended","turnId":"t1:…","endedAs":"interrupted","at":1758712349000}
```

On every change, the first `requested` (or the `write-uncertain` `unknown`)
included, and only once the change is on disk (a failed write is retried, not
announced). Live-only (no `id:`, never in the backlog) and sent only to the
cancel's owner among the callers that read the pane's `/turns`. The receipt is
authoritative after a reconnect. The frame carries no `evidence` or `reason`
(`ChatCancelEventFrame`): when it reports a final `state` and you need those,
read the receipt.

### Chat queue

A send that carries the `chat-queue` capability (in `X-Wmux-Client-Caps` on
the send request itself) is held by the daemon while the pane's turn runs, or
while anything is already waiting in the pane's queue (any owner), and typed
after the turn ends. This applies to Claude, Codex and OpenCode alike. Without
the capability a send behaves as before: Claude takes it into its own composer
queue (`queued:true`), the others answer 409 `chat-busy`.

**Semantics.** The daemon queue delivers **after the turn ends**, one item per
ended turn: after a delivery, the next item waits until the turn that
delivery started has been seen running and has ended (for OpenCode, the
plugin's phase leaving and returning to `complete`). A delivery that starts no
visible turn releases the next item after 30 seconds. Claude's own
composer queue instead folds a message into the running turn at a tool
boundary; the daemon queue never does. It is FIFO per pane, and not ordered
against desktop or raw terminal input. A cancel does not clear it. An item
may wait at the head of the queue for 10 minutes while the agent is not
working (idle, or blocked on a dialog); time spent while a turn runs does not
count, so a long turn never expires it. Nothing is retried after a write: an
item that may have been typed ends `uncertain`, never in a state that invites
a resend. A delivered message is typed only into an empty composer: a draft
left there fails the item (`draft-present`) and stays as it was. A screen
without the composer (a dialog, a usage view) holds the item like any other
dialog, and fails it as `blocked` only when its time runs out.

**Send answer.** 202 `{state:"queued", replayed:false, clientMessageId,
effect:"queued"}`. A repeat with the same id and body answers 200 with the
item's current `state` (and `reason`), `replayed:true`, also after delivery
started; `effect` is `queued` while it waits, `submitted` once delivered,
`uncertain` for `uncertain`, and `none` otherwise. The same id with another
body, or for another pane, is 409 `message-id-conflict`; two concurrent
requests with one id make one item.
429 `queue-full` when the caller already has 8 waiting items on the pane.

**States and reasons** (closed set):

| `state` | `reason` |
| --- | --- |
| `queued` | — |
| `delivering` | — |
| `delivered` | — |
| `failed` | `draft-present` (text left in the composer), `blocked` (a dialog held it for its whole lifetime), `prompt-active` (an approval held it), `expired`, `delivery-unconfirmed` (nothing was typed, but the daemon could not deliver it) |
| `canceled` | `user`, `daemon-restart`, `authorization-revoked`, `pane-closed`, `session-changed` |
| `uncertain` | `restart-uncertain` (the daemon restarted mid-delivery), `delivery-unconfirmed` (it may have been typed: a paste whose Enter was refused, an OpenCode answer lost after the plugin took the request) |

An `uncertain` item's receipt reads `uncertain` too, and its replay carries
`effect:"uncertain"`: check the transcript before sending it again.

**Authorization at delivery.** The daemon re-checks the owner right before
the first write and again before Enter: the device must still be paired and
hold input, the server must still run with `--allow-input` and
`--allow-transcript`, and the pane must be the same incarnation. A failure
before the first write cancels the item (`authorization-revoked`); one after
the paste leaves it `uncertain` (`delivery-unconfirmed`). Unpairing a device, withdrawing
its input grant or stopping the server cancels that owner's waiting items at
once (`authorization-revoked`); a daemon shutdown cancels them as
`daemon-restart`. A closed pane cancels its items (`pane-closed`); a new conversation in
the pane cancels them at their turn (`session-changed`).

**Restart.** The prompt text is never written to disk. After a daemon restart
every `queued` item reads `canceled` (`daemon-restart`) and every `delivering`
item `uncertain` (`restart-uncertain`); nothing is delivered.

**`/turns`.** For a `chat-queue` caller on a daemon whose queue loaded, the
chat object carries `queue: [{clientMessageId, state, reason?, queuedAt, at,
preview?}]`: the caller's own items on the pane, most recent kept, in enqueue
order. `preview` is the first 80 characters, held in memory only (absent after
a restart). `capabilities.queue` is `true` for a live Claude, Codex or
OpenCode agent, and `capabilities.send` stays `true` while a turn runs. User
rows the daemon typed for this caller carry `clientMessageId` (best effort;
omitted when no row matches). Without the capability the object is unchanged.

**Receipt.** `GET /api/sessions/<id>/chat/messages/<clientMessageId>` adds
`queue: {state, reason?}` for a message that went through the queue, and reads
`state:"queued"` while the item waits.

**`DELETE /api/sessions/<id>/chat/queue/<clientMessageId>`** takes an item
back. Needs the input grant (403 otherwise); only the owner's items are found.

| Status | Body |
| --- | --- |
| 200 | `{state:"canceled", clientMessageId}` — also on a repeat |
| 409 | `already-delivered` `{state}` |
| 409 | `delivery-in-progress` `{state}` |
| 409 | `queue-item-final` `{state, reason}` — `failed` or `uncertain` |
| 404 | `queue-item-not-found` |
| 404 | `pane-not-found` |

A 404 without one of these two `error` values means the route is missing (an
older daemon).

**SSE `chat.queue`.** `{sessionId, clientMessageId, state, reason?, at}` on
every state change. `delivering` is sent only once the first write
is about to happen; an item the daemon holds back before that never shows
`delivering` then `queued`. Live-only like `chat.blocked` (no `id:`, never replayed),
and only to the item's owner among the pane's `/turns` watchers. `/turns` is
the authoritative state after a reconnect.

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

### Retraction — an approval that ended after its push

Every approval push goes out with APNs collapse id `ap-<sessionId>` (at most 64
characters). When a `terminal_prompt` record whose push was delivered then ends
without the phone answering it — answered in the pane, the dialog cleared, the
turn ended, expired — the daemon sends ONE more push on the same `POST /push`
relay route, with the **same collapse id**, so APNs replaces the banner instead
of leaving "Approval needed" on the lock screen for something nobody is waiting
on. Its sealed plaintext:

```json
{
  "title": "Approval resolved",
  "body": "No longer waiting — nothing to do.",
  "sessionId": "<pane session id>",
  "kind": "approval_retraction",
  "retractsApprovalId": "<the approvalId of the push being replaced>",
  "resolution": "expired"
}
```

`retractsApprovalId` is the `approvalId` the delivered push carried. It can
differ from the record that just ended: a record re-parsed within the same
episode inherits its predecessor's delivered push, and a banner left by a
record superseded by a different question is retracted by the next record in
that pane (or, with none taking it over, by itself after 30 s).

`resolution` is `"expired"` (the dialog was answered in the pane, cleared,
superseded, or the turn ended — an answer typed at the computer lands here) or
`"resolved"` (the body then reads "Answered — nothing to do."). There is
**never an `approvalId`** on a retraction:
an extension that sees one attaches the approval category, its buttons and the
deep link, which would put Approve back on the lock screen for a record that no
longer exists. No retraction is sent when the push never left (the record ended
inside the grace, or while presence still held it, or the held push was
dropped), when the record was answered through `press` (a phone answer, a
desktop answer through the pipe, or the one-Esc decline — a press inside the
grace also cancels the push), or when a later push — a gate or another
approval — has since replaced the banner under the same collapse id. Gate
records (`awaiting_input`, `awaiting_permission`) are not retracted.

**Known limit: daemon restart.** Which pushes were delivered is held in memory
only. A restart expires every pending record without events, so a banner
delivered before the restart is not retracted; the phone's next
`/api/approvals` read shows nothing pending.

**Backward compatible by construction.** An extension that does not know
`kind` renders a retraction as a plain notify-only banner ("Approval resolved")
that replaces the original under its collapse id. The relay still sends every
push as an `alert` with `sound: default`, so on such a build the replacement
also makes a sound.

**What a current extension should do** when the opened payload has
`kind == "approval_retraction"`:

- clear `sound` and set `interruptionLevel = .passive`, so the replacement is
  silent;
- set no category and no deep link (there is no `approvalId` to build one from);
- optionally remove the replaced notification outright with
  `UNUserNotificationCenter.removeDeliveredNotifications(withIdentifiers:)` —
  for a push sent with a collapse id the delivered request's identifier is the
  collapse id (confirm on a device);
- in the app, drop any local card for `retractsApprovalId` and re-read
  `/api/approvals`.

Suppressing the replacement entirely needs Apple's notification-filtering
entitlement; nothing here depends on it.

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
missing key as `false` and hide the button. On the desktop the grant is the
**Photo & file upload** toggle in the Remote popover; it persists the same way
as Conversation access.

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
- `paneId` — the desktop pane that holds this session's tab. Sessions with the
  same `paneId` are tabs of one pane; group them to draw the desktop's pane
  rows. It is an opaque grouping key recomputed on every poll: it changes when
  a tab moves to another pane or panes are split or merged, so cache by
  `sessionId`, never by `paneId`. A session without it is a group of its own.

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
- `nestedUnder`, `requesterPaneId` — present only on a `nested` task, with the
  desktop's own per-pane split (the sidebar draws workspace › requesting pane ›
  tasks):
  - `nestedUnder: "pane"` with `requesterPaneId` — the desktop draws the task
    under the owner's pane that asked for it. `requesterPaneId` is a desktop
    pane id that one of this reply's sessions under `ownerWorkspaceId`
    carries: the `ownerWorkspaceId` row's `panes[]` entries and
    `GET /api/sessions` rows carry the same `paneId`. Draw the task row
    indented under the owner's pane group with that `paneId`.
  - `nestedUnder: "closedPane"` (no `requesterPaneId`) — the requesting pane is
    gone, or no pane asked (the task came from the orchestrator or the
    desktop's own UI). Draw it in a trailing "From closed pane" group under
    the owner, after the owner's pane groups.
  - Both absent on a `nested` task — draw it under the owner at workspace
    level, as `nested` alone says. This happens when the requesting pane is
    alive but has no session the phone lists (a pane of browser tabs only),
    when the desktop is too old to say, and when the desktop's reply was over
    its size budget: after the layout trees (see *Workspace layout tree*),
    the pane placement (every `paneId`, `nestedUnder` and `requesterPaneId`)
    is the first thing cut, before tab titles.

  If no session you hold carries `requesterPaneId` (the two routes are
  polled separately and can disagree for a poll), fall back the same way.
  A task that needs you (the per-session status you already track for its
  sessions, e.g. its `panes[].agentStatus`) should light the pane group it
  sits under, the way it counts in the owner's `taskSummary.needYou`, so a
  folded pane group still shows it.
- `taskSummary` — on an owner row with at least one `nested` task only:
  `{tasks, needYou, toReview, finished}`, the sidebar's rollup line computed
  over exactly the rows of this reply that are `nested` under it. `needYou`
  counts tasks waiting on the user, `toReview` counts open tasks whose every
  agent pane reported complete (Fleet's "Ready to review"), and `finished`
  counts tasks whose every agent pane reported complete.

Each `panes[]` entry of `GET /api/workspaces` also carries `paneId` (same
value and rules as on `GET /api/sessions`) when the desktop places that
session in a pane of that workspace.

Top level of `GET /api/workspaces`: `activeWorkspaceId` — the workspace the
desktop is showing, present only when it is one of the listed rows.

#### Workspace layout tree

`layout` — per workspace row, the desktop's split layout for that workspace:
how its panes are split, how big each is, which tabs each pane holds and which
one it shows. Read-only, additive, and under the same presence rules as every
field above; an absent `layout` means "draw this workspace flat from
`panes[]`", exactly as before. No `/api/config` flag announces it — the key's
presence on a row is the signal, and a daemon that serves the web client ships
that client in the same build. `PHONE_PROTOCOL_VERSION` is unchanged.

```ts
type Layout = {
  root: Node;
  activePaneId?: string;   // the desktop's focused pane, only when it is a leaf of root
  unplaced: string[];      // sessionIds of this row's panes[] that no leaf holds
};
type Node =
  | { kind: 'split'; direction: 'horizontal' | 'vertical'; sizes: number[]; children: Node[] }
  | { kind: 'leaf'; paneId: string; surfaces: Surface[]; activeIndex?: number };
type Surface = {
  surfaceId: string;       // desktop tab id: stable across polls, unique in the tree
  kind: 'terminal' | 'browser' | 'editor' | 'diff' | 'git' | 'review' | 'remote-terminal' | 'other';
  ptyId?: string;          // terminal only: a sessionId of this same row's panes[]
  title?: string;          // non-terminal only: at most 100 characters, one line
};
```

- `direction` uses the desktop's word: `horizontal` lays the children side by
  side (columns), `vertical` stacks them (rows).
- `sizes` has one entry per child, in percent, in whole hundredths (0.01)
  that sum to exactly 100, none below 0.01. A desktop split with no or
  mismatched sizes arrives as an equal split (e.g. 33.34 / 33.33 / 33.33),
  which is what the desktop draws for it.
- A leaf's `paneId` is the same value `panes[].paneId` carries. `surfaces` are
  the pane's tabs in the desktop's order; `activeIndex` is the tab the pane
  focuses, present whenever `surfaces` is non-empty. It may be a browser or
  editor tab.
- `surfaceId` is the desktop's own tab id. It stays the same across polls for
  as long as the tab exists, so key tabs (and any per-tab view state) by it;
  a tab that moves to another pane keeps it.
- A pane holding both terminal and browser tabs is drawn by the desktop as a
  side-by-side split inside the pane: the terminal side shows the focused
  terminal tab (else the first terminal tab), the browser side shows the
  focused browser tab (else the first browser tab), and a focused
  diff/editor/remote tab covers both. That split starts at 50/50 and its
  ratio is not stored anywhere, so `kind`, order and `activeIndex` are all a
  reader needs to reproduce it.
- A terminal tab carries `ptyId` only — its title is that session's
  `surfaceTitle` on `GET /api/sessions`. A terminal tab **without** `ptyId`
  is a slot whose session this row does not list: still spawning, the
  orchestrator brain, gone, or running in another workspace by the daemon's
  record. Keep the slot so tab order and `activeIndex` stay true, and draw a
  placeholder for it. Every `ptyId` in a tree is a live session of that same
  row, and appears at most once.
- A non-terminal tab carries its title only (no URL, no file path). There is
  nothing to stream for it; draw a static tab. Treat an unknown `kind` as
  `other`.
- `unplaced` lists the row's sessions that no leaf holds — a stashed pane's
  tab (stashed panes are not part of the layout), or a session the desktop
  has not placed yet. Draw them apart from the tree (e.g. a trailing
  "Not in layout" group) so every listed session stays reachable.
- The pane cols/rows stay desktop-owned (see *Resizing a pane*): the tree
  tells you the arrangement, not a geometry you can impose.

Bounds, enforced by the desktop and again by the daemon: depth ≤ 16 (the root
is 1), ≤ 512 splits and leaves together, ≤ 64 leaves, ≤ 64 children per split,
≤ 64 tabs per leaf and ≤ 512 tabs per tree. A tree over any bound, with bad
sizes, a missing or duplicate `surfaceId`, a duplicate pane or session id, an
out-of-range `activeIndex` or an unsafe title is not sent at all; the row and
its flat `panes[]` stay. A single terminal tab whose session id the desktop
cannot send safely loses only its `ptyId`.

Size budget: the layout trees are the first thing cut when the desktop's reply
is over its budget, largest tree first, before pane placement, titles and pane
rows. A tree is never sent with pane placement, titles or pane rows cut, so a
`layout` you receive is always backed by a full `panes[]`.

#### Browser app (`/`)

**The native iOS app does not use any of the HTML pages below.** It talks to
the JSON/SSE routes in this document directly; the pages are the daemon's
browser clients, and nothing in them is part of the native contract.

`GET /` (also `/index.html` and `/app`) is the browser app: the desktop
renderer's own components (sidebar, workspace rows, surface tabs, split layout,
terminals, theme and fonts), built by `vite.web.config.ts` and inlined by
`scripts/build-daemon-web.mjs` as two scripts and one style block. It mirrors
the tree above — it reads `GET /api/workspaces` and `GET /api/sessions` every
2.5 s, one after the other — and changes no structure (no split, close, rename
or reorder). `GET /classic` is the flat client that used to live at `/`, and
`GET /pair` is that same classic page opened on its pairing screen. A daemon
whose app page was not built serves the classic page at `/`.

- The first script (es2017) stores `?token=` under the same key the classic
  page uses and installs a deny-by-default `window.electronAPI`: static values
  (`platform`, `systemLocale`, `windowsBuildNumber`, `browser.getBackendSync`),
  no-op subscriptions (`events.publish`, `daemon.onConnected`) and the terminal
  members listed below; every other member (`pty.create` / `dispose` /
  `promote` / `resize`, `shell.*`, `accounts.*`, `dialog.*`, …) returns a
  rejected promise and is never wired to the daemon. It also installs a
  `window.clipboardAPI` on the browser clipboard (secure contexts only) and
  registers `/sw.js` in a secure context, as the classic page does.
- No stored credential, a 401, or a browser that cannot run the es2022 bundle
  (iOS before 16.4) → the page goes to `/classic`. After pairing, the classic
  page lands on `/` again (and an old browser falls straight back).
- Terminals are the desktop's own `Terminal` component over the web routes:
  - A pane's stream (`GET /api/stream`, with a stream ticket for a device
    credential — `<deviceId>.<secret>` — and `?token=` for the operator token,
    which never asks for a ticket) is open only while the pane is shown and its
    terminal reports itself visible; it closes on hide. A device credential
    never goes into the URL: no ticket, no stream.
  - Inline images (sixel / iTerm2) are off in the browser: the image decoder
    needs WebAssembly, which the page's CSP does not allow.
  - At most **4** panes stream at once (the daemon allows 8 streams per
    principal, the browser 6 HTTP/1.1 connections per origin). A shown pane
    beyond that shows a placeholder with "Show live", which takes the slot of
    the least recently activated pane; a freed slot goes to the longest waiter.
    At phone width only the selected pane is shown, so only it streams.
  - The grid is the desktop's: cols/rows from `/api/sessions` and the stream's
    `meta` (including mid-stream resize metas). The page fits the **font size**
    to its box — never a CSS transform, which would misplace mouse reports — and
    never asks to resize a pane.
  - Each `snapshot` is replayed as one write starting with RIS (a re-opened
    stream repaints instead of stacking). Queries the snapshot replays are
    not answered (the viewer answers none — see below). The stale-mode reset
    uses the shared gate (`commandRunning`,
    `resumeAgent` from `meta`) capped at the alive-shell set: mouse and focus
    reporting are cleared, bracketed paste (`?2004`) never is.
  - `hostPlatform` in `/api/config` is the daemon's `process.platform`
    (`darwin`, `win32`, `linux`): the browser app folds keyboard-protocol
    negotiation by the pane's host, not by the browser's OS.
  - The page re-reads `/api/config` every 10 s (backing off on failure), so a
    failed first read or a changed grant does not stick; until the first
    answer the page shows "Checking input…", and a read-only caller sees a
    "Read-only" chip.
  - Keystrokes go to `POST /api/input` in order per pane, only while this
    caller may type; a read-only caller's terminal sends nothing, and never
    arms mouse reporting (the drag selects text instead). Keys typed while a
    snapshot is being parsed wait for it. A delivery that fails or cannot be
    confirmed (409, other 4xx, 5xx, no answer) stops that pane's input and the
    page says so, with how many keystrokes were not sent and a Resume button.
    An unconfirmed keystroke is never re-sent (it may have arrived); input
    receipts are not used per keystroke (two durable writes each, 10 000 a day
    shared by every client).
  - The browser terminal is a viewer and **answers no terminal query** (DA,
    DSR/CPR, DECRQM, XTVERSION, DECRQSS, OSC 4/10/11/12 `?`), replayed or live,
    and sends no focus reports: the pane's owner (the desktop's terminal)
    answers. With no desktop attached a query goes unanswered and the app
    falls back on its own timeout — a viewer that answers can type into a
    shell; one that stays quiet cannot.
  - Paste (⌘V, Ctrl+V, Ctrl+Shift+V) is the browser's own paste event, so it
    works outside a secure context; copy falls back to the legacy copy
    command there.
  - A stream the daemon keeps refusing (stream quota, expired ticket) backs
    off (1 s doubling to 30 s) and after 5 failures gives its slot up; the
    pane shows it as unavailable with "Show live" to try again.
- The page is served under its own CSP, derived from its own bytes like the
  classic page's. Both policies carry `font-src 'self'`: the app's fonts are
  served same-origin from `/app/assets/<name>.woff2` (exact file names from the
  build, immutable caching). The page makes no request to any other origin.
- The service worker keeps two offline shells under their own keys — `/` (the
  app; `/index.html` and `/app` share it) and `/classic` (`/pair` shares it) —
  precaches both, and caches the fonts on first use.

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

## Host search

`GET /api/search?q=<text>&scope=<list>&limit=<n>&cursor=<c>` searches this
host's panes. It is a read: no input grant is involved.

### Advertising

`/api/config` carries `search: true` and `searchScopes` when at least one scope
can answer this caller, and omits both otherwise (as a daemon predating the
route does). `turns` and `sessions` are listed when the server runs with
`--allow-transcript`. `scrollback` is listed when the daemon can read pane
text, which needs only an authenticated caller, the same as `/api/stream`.

### Request

- `q`: trimmed, then 2–200 UTF-16 code units, with no NUL. Otherwise
  `400 invalid-query`. Matching is a case-insensitive literal substring, never a
  pattern. Case folding is locale-independent and per character, and it never
  changes a string's length.
- `scope`: a comma list of `turns`, `sessions`, `scrollback`. Duplicates are
  ignored. Default `turns,sessions`. Anything else, including an empty value,
  is `400 invalid-scope`.
- `limit`: 1–100, default 50. Otherwise `400 invalid-limit`.
- `cursor`: the previous response's `nextCursor`. A cursor from another query
  or scope set, an edited one, or one minted before a daemon restart is
  `400 invalid-cursor`. Start the search again without it. Re-casing the query
  keeps the cursor valid. A cursor minted by a daemon before this cursor format
  (version 2) is `400 invalid-cursor` too.

Every response, error or not, is `Cache-Control: no-store`.

### Response

```json
{ "results": [ { "kind": "turn", "sessionId": "…", "workspaceId": "…",
                 "title": "wmux · Claude · repo", "surfaceTitle": "…", "alive": true,
                 "snippet": "…", "matchRanges": [[12, 6]], "at": 1790000000000,
                 "turnEventId": "…", "turnCursor": "…" } ],
  "coverage": { "searchedSessions": 3,
                "skippedSessions": [ { "sessionId": "…", "scope": "turns", "reason": "budget" } ] },
  "truncated": false,
  "nextCursor": null }
```

- `kind`: `turn` (a message in a conversation), `session` (pane metadata or a
  run-history result), `scrollback` (a line of terminal text).
- `title`: the daemon has no pane title, so it composes `workspace · agent ·
  cwd leaf` and drops any missing part. When nothing is known, it is the
  session id. For a run with no pane left, it is the run's workspace and agent.
- `surfaceTitle`: the desktop tab title. Present only while the desktop is
  attached and its sidebar snapshot is already cached. A search never asks the
  desktop for it, so it can be missing on a search that follows a long idle.
  Prefer it over `title` when present.
- `alive`: `false` for a pane that is neither attached nor detached: a
  dead-session tombstone (the daemon keeps one for up to 24 h after the shell
  exits) or a suspended pane. Show that pane read-only. The field is
  omitted on a run-history hit whose pane is gone.
- `snippet` and `matchRanges`: about 160 code units around the first match,
  widened only for a longer query. Control characters are spaces, so a snippet
  is one line. A snippet edge never splits a surrogate pair. `matchRanges` are
  `[start, length]` pairs in UTF-16 code units relative to `snippet`, which
  `NSString`/`NSRange` use directly. There are at most 16 pairs, and every
  occurrence is wholly inside the snippet.
- `at`: epoch ms. For a turn it is the message timestamp, and for a run-history
  hit it is the run's time. Pane-metadata and scrollback hits have no `at`.
- `turnEventId`: the TurnEvent `id` `/turns` serves for that message.
- `turnCursor` (transcript-file turns only): open the hit with
  `GET /api/sessions/<id>/turns?dir=back&cursor=<turnCursor>`. That page ends
  with the hit's transcript line. It is in the format `/turns` accepts right
  now (a chat cursor when native chat is wired), so page on from its reply as
  usual. It is absent for OpenCode and managed conversations, which `/turns`
  serves as one page. If the conversation changed since the search, `/turns`
  answers its usual reset snapshot.

### Ordering and paging

Hits with `at` come first, newest first. Hits without `at` follow, grouped by
pane, newest pane (by when it was created) first. Ties break on session id,
kind, and position (newest first). So a pane-metadata hit sorts after every
timestamped hit. Every part of this order is fixed for the life of a hit:
output in a pane does not move its hits.

`nextCursor` is non-null when more hits may exist past this page. It is
stateless: the next call runs the search again and continues after the last
hit returned. A turn appended meanwhile sorts before that hit and is not
repeated. Scrollback printed meanwhile in the cursor's own pane, or in a pane
already paged past, is newer than the cursor and is not shown. A pane the
paging has not reached yet shows what it holds when the page reaches it. Old
scrollback lines leaving the ring, or a resize, do not shift the paging: the
cursor remembers its line and as many lines above it as it takes to tell that
place apart from any repeat, and finds it again. If it cannot find exactly one
such place (the line left the ring, the screen was redrawn, or the output
repeats too much), the rest of that pane is not searched on this page: the
pane is listed in `skippedSessions` with reason `cursor-lost` and `truncated`
is true. Paging goes on with the next pane. The daemon never guesses a place.

A page can come back with `truncated: true` and a cursor. What that means
depends on what the bounds left out:

- A conversation cut at its per-session 4 MiB window, or a pane the 24 MiB
  request-wide bound left unread, is cut at the same place on every page:
  conversations are read in the order their hits sort, by pane creation. That
  does not stop paging.
- A scrollback pane left unread (its extraction did not fit in this request)
  ends the page before that pane's hits, so the page can hold fewer than
  `limit` hits and still carry a cursor. The next page reads that pane, from
  the cache once the background extraction has finished.
- A conversation the wall clock left unread, or read only partly, has hits
  that could belong anywhere in the order. The page's hits are correct, but
  `nextCursor` is null. To see more, search again later or narrow the query.
- A cursor that lost its place in a pane (`cursor-lost`, above).

A page can have no hits and still carry a cursor, when the first pane past the
cursor could not be read yet. That cursor is the one you sent (or, on a first
page, one that means "from the start"). Retry with it after a short wait
(about a second); the pane's extraction finishes in the background meanwhile.
So stop paging only when `nextCursor` is null, never because a page held fewer
than `limit` hits.

### Scopes, gates, and which panes

| scope | grant | panes | reads |
|---|---|---|---|
| `turns` | `--allow-transcript` | as `/turns`: every pane the daemon holds, dead tombstones included, orchestrator brain panes excluded for every caller | the reader `/turns` would pick: the Claude/Codex transcript through the resume binding and its path check, or the OpenCode/managed page the chat bridge already holds. Matched: user messages and the assistant's replies. Thinking blocks and tool calls and results are not searched. |
| `sessions` | `--allow-transcript` | same as `turns` | the composed title, desktop tab title, agent, workspace name and cwd (one hit per pane, the first field that matches), and each run-history result's summary, workspace and agent (the entries `/api/history` serves) |
| `scrollback` | an authenticated caller (as `/api/stream`) | as `/api/stream`: a paired device never gets a brain pane; the operator token does | the pane's terminal text through the daemon's headless parse of the ring (the last 5,000 rows), soft-wrapped rows joined into one line |

Without `--allow-transcript`, a request whose every scope needs it is
`403 {"error":"transcript-disabled"}`. When another scope is also asked for,
the answer is 200, and every pane is listed in `skippedSessions` for each gated
scope with reason `transcript-disabled`.

### Bounds

- At most 2 searches run at once, daemon-wide, and at most 1 per caller (the
  operator token is one caller, each paired device another). Past either, the
  answer is `429 {"error":"search-busy"}` with `Retry-After: 1`.
- Each caller may start 4 searches back to back, then one more every 2 s.
  Past that, the answer is `429 {"error":"search-busy"}` with `Retry-After` set
  to the whole seconds until the next search is allowed. A refused request does
  not count.
- One request runs for about 3 s of wall clock. Once that has passed, no new
  pane is started.
- `turns` reads each transcript newest first, up to its most recent 4 MiB
  (16 of the projector's 256 KiB pages). One request reads at most 24 MiB
  across all panes. The daemon yields between pages, so a search does not stall
  other panes' streams.
- `scrollback` extracts at most 6 panes' text per request, in the order their
  hits sort (so the pane right after the cursor first). Extraction shares the one-at-a-time snapshot queue that attach and
  resync use. Text is cached per pane until the pane writes more bytes, or its
  size or incarnation changes, for up to 8 panes. A cached pane does not count
  against the 6. An extraction still queued at the deadline finishes in the
  background and fills the cache for the next search. A pane is never queued
  for extraction twice: a search that reaches a pane already being extracted
  waits for that extraction. At most 2 extractions are queued or running
  daemon-wide, counting the ones left from searches that already answered. A
  pane that would need a third is skipped as `budget` without being queued, so
  searches cannot build up a backlog in front of attach and resync.

Hitting any of these bounds sets `truncated: true`. Every pane a bound left
unsearched, or only partly searched, is listed with reason `budget`. Hits from
the part that was read are still returned. `searchedSessions` counts the panes
searched fully or in part in at least one scope.

### Skip reasons

| reason | meaning |
|---|---|
| `transcript-disabled` | the scope needs `--allow-transcript` |
| `budget` | a time, byte or pane bound stopped the search here (see above) |
| `cursor-lost` | scrollback only: the cursor's line could not be found again in this pane, so the rest of it was not searched on this page (see Ordering and paging) |
| `unavailable` | this daemon cannot read that source (scrollback: the ring could not be parsed; turns: no transcript reader, or an OpenCode pane with no readable conversation) |
| `unreadable` | the transcript file could not be read, or stopped being readable partway |
| `no-hook`, `stale-session`, `no-transcript-path`, `unsupported-agent`, `unsafe-transcript-path` | the `/turns` resolver's own reason, passed through unchanged |

Treat an unknown reason as "not searched".

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
  and every other capability `false` or absent. `cancel` is `false` unless you
  sent the `chat-cancel` capability (see Chat cancel); for OpenCode it also
  needs a plugin that advertises abort. `queue:true` (live Claude) means a send
  during a running turn can be accepted and answered with `queued:true`. A
  `chat-queue` caller sees `queue` for all three agents instead (see Chat queue).
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

---

## Proposed: contract v-next (partly served)

> **Status: partly served on `main`, the rest proposed.**
>
> - **Served** (described from serving code): item 2, Codex account status
>   (`codexAccountStatus`; #1668); item 3, the chat cancel outcome on the Esc
>   path and the native Codex path (`chatCancelOutcome`; #1665, #1669);
>   item 4, account per pane and handoff lineage (`paneAccount`,
>   `paneHandoff`; #1664); and item 5's read routes,
>   `GET /api/git/projects`, `GET …/git/branches` and `GET …/git/checks`
>   (`gitProjects`, `gitChecks`; #1663).
> - **Proposed — on hold pending client review:** item 1, typed turn failure
>   (`turnFailure`), and item 5's worktree creation, `POST …/git/worktree` and
>   its receipt (`gitWorktrees`). No daemon serves these. Do not ship a client
>   path that depends on them until the matching `/api/config` key (below)
>   appears on a real daemon.
>
> Shared types: `src/shared/phoneTurnFailure.ts`,
> `src/shared/phoneCodexAccountStatus.ts`, `src/shared/phoneChatCancelOutcome.ts`,
> `src/shared/phonePaneAccount.ts`, `src/shared/phoneGitV1.ts`.

All items are additive. None moves `protocolVersion` or `chatVersion`.

### Discovery

Flat, per-caller `/api/config` keys, **omitted (not `false`)** when the caller
cannot use them, exactly like the keys above. An absent key means "not on this
daemon"; never probe with a write.

| Key | Present when | Advertises |
| --- | --- | --- |
| `turnFailure` | always, once served | `failure` on the surfaces in item 1 |
| `codexAccountStatus` (**served**) | `--allow-transcript`, and a pane this caller may read has a live Codex relay | `GET /api/sessions/<id>/codex/account-status` |
| `chatCancelOutcome` | `chatCancel` is true and the cancel receipt store loaded | **Served** (see Chat cancel outcome): `cancel` on the cancel answer, the cancel receipt route, `chat.cancel` SSE |
| `paneAccount` (**served**) | caller may input, `--allow-transcript`, and the attached desktop announced `accounts.envForAccount` | `accountId` on `POST /api/sessions` and on `GET /api/agent-launch-options` |
| `paneHandoff` (**served**) | caller may input | `handoffFrom` on `POST /api/sessions`, echoed on rows and history |
| `gitProjects` | caller may input (**served**) | `GET /api/git/projects`, `GET …/git/branches` |
| `gitWorktrees` | caller may input and the worktree receipt store loaded | `POST …/git/worktree` and its receipt |
| `gitChecks` | caller may input (**served**) | `GET …/git/checks` |

Per session, `/turns` `chat.capabilities` gains `accountStatus: true` for a
`terminal` binding whose agent is `codex` and whose pane has a live relay to
its account server (**served**; omitted otherwise). The route stays
authoritative.

**`paneAccount` is mandatory before sending `accountId`.** `POST /api/sessions`
ignores unknown body keys on every daemon that predates this, so an
`accountId` sent to an older daemon is silently dropped and the pane spawns
on the workspace's bound account. Also check that the 201 row echoes the
`accountId` you sent.

**Desktop capability handshake.** `paneAccount` depends on a desktop bridge
command that older desktops do not have. The key appears only after the
attached desktop has announced support for `accounts.envForAccount` on this
connection (the desktop sends `daemon.phone.register {commands:[…]}`; an older
desktop sends no list and so never enables it); it disappears when the desktop
detaches. Any failure of that
command (unsupported, timeout, malformed answer, desktop gone) refuses the
create. The daemon never falls back to the workspace's account environment
when an `accountId` was sent.

### Defaults this contract assumes (owner decisions pending)

- Codex `sessionBudgetExceeded` is **not** `quota`: it reads `reason:"unknown"`
  with `providerCode:"sessionBudgetExceeded"`.
- A Claude subscription usage cap reads `rate-limited`; Claude reports it as
  `rate_limit`, and `providerCode` is the only finer signal.
- A `codex` typed by hand and OpenCode get no typed failure (v1 limit).
- Worktree removal is not in v1; the desktop's cleanup UI reclaims phone
  worktrees (item 5).

### 1. Typed turn failure

> **Proposed — on hold pending client review.** Not served.

When a turn ends in failure the daemon reports only what the provider said,
in structured form:

```jsonc
"failure": {
  "reason": "rate-limited",        // "rate-limited" | "auth" | "quota" | "network" | "unknown" (closed)
  "provider": "claude",            // "claude" | "codex" (open)
  "providerCode": "rate_limit",    // provider's own code, verbatim, ^[A-Za-z][A-Za-z0-9_]{0,63}$; optional
  "httpStatus": 429,               // codex only, when the error names one; optional
  "message": "You've hit your limit · resets 3pm", // ≤ 280 UTF-16 units, sanitized (see below), plain text; optional
  "retryAfterMs": 30000,           // reserved, never sent today
  "resetAt": 1760000000000,        // reserved, never sent today
  "at": 1758712345123,             // epoch ms the daemon saw it
  "turnId": "t1:…"                 // chat.turn.id of the failed turn, when known; optional
}
```

Render `reason` for the headline and `message` (when present) as the body.
Every provider- or server-authored string in this section (`message`, rate-limit
`limitName`, check `name` and `workflow`) is sanitized the same way: C0/C1
controls, bidi embeddings, overrides and isolates (U+202A–202E, U+2066–2069),
zero-width characters (U+200B–200F) and U+FEFF are removed, lone surrogates
are dropped, whitespace is collapsed, and a clipped string ends in `…` without
splitting a surrogate pair.
Never parse `message`: a reset time in it is prose, not a field. Neither
source carries a structured retry-after or reset time, so `retryAfterMs` and
`resetAt` stay absent.

**One failure, several surfaces.** The same failure can reach you on up to
five surfaces and again after a reconnect. Deduplicate by `(sessionId,
turnId)`, or by `(sessionId, at)` when `turnId` is absent; the daemon sends
identical `turnId` and `at` values on every surface for one failure.

**Sources and mapping (normative).**

Claude Code `StopFailure` hook. It fires instead of `Stop`, and the bridge
forwards its payload verbatim. Input fields: `error` (required),
`error_details`, `last_assistant_message` (verified on Claude Code 2.1.285).
`message` comes from `last_assistant_message`, never from `error_details`
(raw API text that Claude Code marks internal).

| `error` | `reason` |
| --- | --- |
| `rate_limit` | `rate-limited` (includes subscription usage caps) |
| `billing_error` | `quota` |
| `authentication_failed`, `oauth_org_not_allowed`, `cloud_credential_error`, `account_on_hold`, `verification_required` | `auth` |
| `overloaded`, `server_error`, `invalid_request`, `model_not_found`, `max_output_tokens`, `unknown`, anything else | `unknown` |

Claude has no connection-failure code, so Claude never yields `network`.

Codex: `turn/completed` with `turn.status: "failed"` on the pane's own relay
stream (codex-cli 0.157.1 schema). `message` is `turn.error.message`;
`additionalDetails` is never sent. An `error` notification with
`willRetry: true` is not a failure, and an interrupted turn is a cancel.

| `codexErrorInfo` | `reason` |
| --- | --- |
| `rateLimitExceeded` | `rate-limited` |
| `usageLimitExceeded` | `quota` |
| `unauthorized` | `auth` |
| `httpConnectionFailed`, `responseStreamConnectionFailed`, `responseStreamDisconnected` | `network`; `rate-limited` if `httpStatusCode` is 429, `auth` if 401/403 |
| `responseTooManyFailedAttempts` | `unknown`; 429 → `rate-limited`, 401/403 → `auth` |
| `sessionBudgetExceeded`, anything else, or `null` | `unknown` |

**Scope.** Claude: any pane with the wmux hook bridge installed. Codex: only
panes with a daemon-owned relay (phone-created Codex panes on Unix). A `codex`
typed by hand has no relay; its `notify` carries no failure detail and, from a
shared app-server, no provable pane (see #1657). OpenCode: none.

**Where it appears.**

| Surface | Field | Lifetime | `message` |
| --- | --- | --- | --- |
| `/turns` `chat` | `chat.lastFailure` | until the next turn starts in that conversation | yes |
| `/api/sessions` row | `lastFailure` | until the next turn starts | only with `--allow-transcript` |
| `/api/events` `agent.liveness` | `failure` on the frame that ends the turn | live-only | yes (the fleet copy already needs a `/turns` read) |
| `/api/stream` `agent.liveness` | `failure` | live-only | **no** (same narrowing as `tool`) |
| `/api/history` entry | `failure` on `outcome: "failed"` | kept with the entry | yes (history already needs `--allow-transcript`) |

The frame that ends a failed turn carries `state: "idle"` plus `failure`. The
turn is over, so `idle` is the truthful state, and a client that ignores
`failure` renders what a finished turn renders. Today's daemon projects a
`StopFailure` onto `state: "busy"` (`deriveAgentLiveness` has no branch for
`status: "error"`); the implementation of this item maps it to `idle`.

### 2. Codex account status (read-only, served)

The route reads the pane's shared Codex app-server over a second,
short-lived connection that starts no thread work. A spike on codex-cli
0.159.2 and a live run on 0.157.1 confirmed that such a connection is
answered. Only panes with a daemon-owned relay qualify
(phone-created Codex panes on Unix): the relay proves which account server
the pane talks to.

```
GET /api/sessions/<id>/codex/account-status
→ 200 {
    "auth": { "state": "signed-in", "method": "chatgpt" },   // state: signed-in | signed-out | unknown; method: chatgpt | apikey | other
    "rateLimits": {                                          // null when unavailable (e.g. an API-key account)
      "ordinaryUsageAllowed": false,                         // the server's verdict; null = unavailable
      "planType": "pro",                                     // verbatim, open set; null when absent
      "buckets": [{
        "limitId": "codex", "limitName": "Codex",
        "primary":   { "usedPercent": 100, "windowMinutes": 300,   "resetsAt": 1760000000000 },
        "secondary": { "usedPercent": 41,  "windowMinutes": 10080, "resetsAt": 1760400000000 },
        "reachedType": "rate_limit_reached"                  // verbatim, open set; null when not reached
      }]
    },
    "fetchedAt": 1758712345123,
    "cached": true
  }
→ 404 {error: "pane-not-found"}
→ 403 transcript refusal (as `/turns`)
→ 503 {error: "unavailable", reason: "no-account-server" | "upstream-failed" | "unsupported-platform"}
```

The example shows every field. Real ChatGPT accounts observed in the spike
answer a single bucket (`limitId: "codex"`, `limitName: null`) with one
weekly window, `primary.windowMinutes: 10080`, and `secondary: null`: do not
assume a 5-hour primary or that a secondary window exists.

| 503 `reason` | When |
| --- | --- |
| `no-account-server` | the pane has no live relay (not a Codex pane, a Codex typed by hand, the relay closed) |
| `upstream-failed` | the auth read failed or timed out (5 s). A failed rate-limit read alone is `rateLimits: null` in a 200 |
| `unsupported-platform` | Windows or a WSL pane |

The account is the one **this pane runs on** (its spawn `CODEX_HOME`, else
the default), not the workspace's next-launch binding. The daemon sends
`getAuthStatus {includeToken:false, refreshToken:false}` and
`account/rateLimits/read {excludeResetCreditDetails:true}` to that account's
already-running app-server. It never starts an account server and never sends
a model request. The rate-limit read does reach the provider's backend, so
reads are cached per account for 60 s (`cached: true`), and there is no
refresh parameter. `cached: true` also marks an answer shared with a read
already in flight. The cache key is the account's Codex home plus its
credential file, so a new sign-in there is read at once. A failed auth read
(503 `upstream-failed`) is remembered for 10 s, and so is an answer whose
rate-limit read failed (`rateLimits: null`), so a failing server is not asked
again on every request. A signed-out or API-key account is not asked for rate
limits (`rateLimits: null`). Every answer, 503 included, is
`Cache-Control: no-store`. The cache is in memory: a daemon restart reads
again.

Never on this wire: the auth token, e-mail, account id, credit balance, the
backend's upsell banner, config paths. `resetsAt` is epoch ms (the server's
seconds × 1000); a value outside 2020-01-01 … 2100-01-01 reads `null`. `planType`
comes from the single-bucket view, else the first bucket that names one. Do not infer "usage is available again" from `usedPercent` or
`resetsAt`; `ordinaryUsageAllowed` is the only verdict.

Needs `--allow-transcript` (like `GET …/accounts`), not input.

### 3. Chat cancel outcome

**Served** for the Esc path (Claude and Codex) and for the Codex
`turn/interrupt` path with `native` evidence on panes with a daemon-owned
relay: see "Chat cancel outcome", right after "Chat cancel". The spike behind
item 2 (codex-cli 0.159.2) confirmed that a side connection may interrupt a
turn it did not start, and that the owning connection then receives
`turn/completed {status:"interrupted"}` for it.

### 4. Account per pane, and handoff lineage (served)

`POST /api/sessions` gains two optional fields:

```json
{
  "workspaceId": "ws-…",
  "cwd": "/Users/me/repo",
  "accountId": "3f1c2e4a-0b6d-4c1e-9a7f-2d8e5b6c7a90",
  "handoffFrom": { "sessionId": "web-5b0c…", "agentSessionId": "0199f1c2-…" }
}
```

**`accountId`** is an id from `GET /api/sessions/<id>/accounts`
(`accounts[].id`), never a path. It needs the input grant **and**
`--allow-transcript` (the account list itself needs transcript access), and
`workspaceId`. The desktop resolves it to that account's config directory,
and the new pane's `CLAUDE_CONFIG_DIR` **or** `CODEX_HOME` (whichever matches
the account's vendor) is set to it. The other vendor's key keeps the
workspace binding. The workspace's binding itself does not change, and no
later pane inherits the choice. The pane keeps the account across daemon
recovery, because its environment is persisted with it.

The chosen vendor's workspace binding is not consulted at all, so a broken
binding for that vendor does not block the pane. A broken binding for the
other vendor still refuses (`workspace-account-missing`).

With `agentLaunch`, the agent runs through a login shell (`$SHELL -lc`),
whose profile could export another `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. For
bash, zsh, sh, dash and ksh the daemon exports the pane's resolved keys again
after the profile, right before the agent, on the first launch and on every
recovery replay. `chat/launch` types into the pane's interactive shell, whose
`.zshrc` / `.bashrc` can export another account too: on a pane created with
`accountId`, a launch of that account's vendor is typed with the account's key
as a one-command prefix (`CLAUDE_CONFIG_DIR='<dir>' claude -- '…'`), so the
agent runs on the chosen account. A pane without `accountId` and the other
vendor's agent are typed as before. Not covered: fish and PowerShell wrappers
for `agentLaunch` (a launch is only typed into zsh, bash or sh), and an agent
the user types by hand, where the shell's own export still wins.

If the account's directory is gone when a pane is recovered, the key is
dropped with a warning in the daemon log and the CLI uses its default
credential, the same way the desktop treats a binding whose directory went
missing. It is never passed to the CLI, which would create an empty, signed-out
config there.

The credential is checked again once the body has arrived, and again after
each desktop round trip, before any account answer is sent: a device revoked
in between gets `401 {error:"authorization-expired"}`, not a hint about
whether the id exists.

| Status | Body | When |
| --- | --- | --- |
| 400 | `{error:"invalid-account-id", effect:"none"}` | not `^[A-Za-z0-9_-]{1,128}$` |
| 400 | `{error:"workspace-required", effect:"none"}` | `accountId` without `workspaceId` |
| 400 | `{error:"unknown-account", effect:"none"}` | no such account on this desktop. An unknown id and another host's id get the same answer |
| 400 | `{error:"account-vendor-mismatch", effect:"none"}` | `agentLaunch.agent` is anything other than the account's vendor. The vendor is not echoed |
| 401 | `{error:"authorization-expired"}` | the credential stopped holding the input grant while the request was in flight |
| 403 | the input or transcript refusal | the caller lacks either grant |
| 409 | `{error:"account-directory-missing", effect:"none"}` | the account's directory is gone (checked at resolution and again right before the spawn) |
| 409 | `{error:"workspace-account-missing", effect:"none"}` | the workspace's binding for the **other** vendor points at a directory that is gone. Also answered for a create without `accountId` when the attached desktop announced `accounts.envForAccount` |
| 503 | `{error:"desktop-unavailable", effect:"none"}` | no attached desktop supports the command, or any desktop request for the create failed (including a desktop that detaches or times out mid-create, and the catalog lookup for `agentLaunch`) |

The 201 row adds `accountId` (only for a pane created with one) so the phone
can confirm it was honoured. With both `accountId` and `agentLaunch`, the model
and effort are validated against the catalog of the **chosen** account, not
the workspace's. `GET /api/agent-launch-options` accepts `accountId` next to
`workspaceId` (same grants, same refusals) so the picker shows that account's
models. `accountId` is **not** accepted by `POST …/chat/launch`: launch types
into a shell whose environment was fixed at spawn, and its body refuses
unknown keys (`invalid-chat-request`).

**`handoffFrom`** records where the work came from. The daemon stores it on
the new pane with `verified` and `at`:

```json
"handoffFrom": { "sessionId": "web-5b0c…", "agentSessionId": "0199f1c2-…", "verified": true, "at": 1758712345123 }
```

`verified` is true only when the source pane was live and readable by this
caller at creation, and `agentSessionId` (when sent) matched its current
conversation. False means "not proven" (the source may have closed), never an
error. A source the caller may not read is stored exactly like a missing one,
so the answer does not confirm hidden panes. A malformed object (unknown key,
bad id) is `400 {error:"invalid-handoff", effect:"none"}`. No id field
(`accountId`, `handoffFrom.sessionId`, `handoffFrom.agentSessionId`) may be an
`Object.prototype` member name (`constructor`, `toString`, `__proto__`, …);
such an id is refused like any malformed one. The stored value appears on the
`/api/sessions` row and on every `/api/history` entry of the new pane.

Narrowings, because `/api/sessions` rows reach every reader:

- `agentSessionId` is compared with the source's conversation only on a
  `--allow-transcript` server. Without it, a handoff that names one is stored
  with `verified: false`, so `verified` cannot be used to test guesses.
- The row's `handoffFrom` carries `sessionId` only when the reader may attach
  the source pane (it still exists and is not hidden from that credential);
  otherwise the row has just `{verified, at}`. `agentSessionId` rides along
  with `sessionId` only on a `--allow-transcript` server. `/api/history`
  (which needs that grant) always carries the stored value.

The source counts as live only while it is not `dead` or `suspended`. The
lineage is on the new pane from the moment it is created, so the pane's
first history entry already carries it.

**Long handoff text travels as a file.** `chat/launch` takes at most 2,000
UTF-16 units of prompt. Upload the handoff body with `POST /api/upload-file`
(`generalFileUpload`, `X-Wmux-File-Extension: md`), then launch with a short
prompt that names the returned `path`. The daemon never reads that path from
a request; it is only text in the prompt. Two limits to design for: the file
expires 24 h after upload, and it lives outside the pane's working directory,
so Claude in default mode asks for permission to read it (answer it in Chat or
Terminal).

The flow has two steps: create the pane with `accountId` and `handoffFrom`
and no `agentLaunch`, wait for `/turns` `launch.ready`, then
`POST …/chat/launch` with the prompt. `agentLaunch` would start the agent
without a prompt and make the pane ineligible for `chat/launch`, and launch
cannot pick a model or effort.

### 5. Git v1 (priority-3 track): projects, branches, worktree creation, CI checks

> **Served:** `GET /api/git/projects`, `GET …/git/branches` and
> `GET …/git/checks` (keys `gitProjects`, `gitChecks`;
> `src/daemon/web/phoneGitRead.ts`). Worktree creation (`gitWorktrees`) is
> proposed — on hold pending client review; no daemon serves it.

Every request names a session (`/api/sessions/<id>/…`), except the project
list, whose rows hand you one. The daemon derives the repository from that
session's trusted `spawnCwd`, exactly as `/git` and `/git/pr` do. **The phone
never sends a path, a ref or a refspec to these routes.** Push and PR creation
are not in v1.

**Where it runs.** In the daemon, with no desktop round trip. The inputs are
daemon state (live sessions and their `spawnCwd`), the daemon already runs
the hardened phone Git runner (fixed `-c` config, sanitized environment,
output bounds) and `gh` for `/git/pr`, and these routes must work on a
headless daemon. Nothing here needs the desktop's workspace registry.

**Gates, budget, audit.** All routes need the input grant and an attachable
session, the same as `/git` (`gitControl`); the reads change nothing and
write no audit line. They share the existing four-slot Git/PR budget
(`429 {error:"git-busy"}`) and the 5 s per-`git` timeout; `gh` keeps its 8 s
timeout. Every `git` the daemon runs for the phone is local only: no
transport is allowed and a partial clone never fetches a missing object.
Worktree creation runs in the background (below) and serializes per
repository, keyed by the realpath of the git common dir. Each creation that
passes validation writes one line to the device audit log
(`device-audit.jsonl`): event `git-worktree`, the device id (empty for the
operator token), and the outcome tag as `reason`. No path and no branch name
is logged.

#### `GET /api/git/projects`

```jsonc
→ 200 {
  "projects": [{
    "projectId": "a1b2c3d4e5f6",       // sha256(realpath of the main worktree root)[0,12); opaque
    "name": "wmux",                    // last segment of the main worktree; display only
    "sessionId": "web-5b0c…",          // address this project's routes with this session
    "sessions": [
      { "sessionId": "web-5b0c…", "branch": "main", "linkedWorktree": false },
      { "sessionId": "pty-7f3c", "branch": "phone/fix-login", "linkedWorktree": true }
    ]
  }],
  "truncated": false,
  "degraded": true                     // optional: some sessions' repositories could not be read
}
→ 409 {error:"git-operation-failed"}   // no repository could be read at all (git missing, timeouts)
```

A separate route on purpose: `/api/sessions` is polled every few seconds and
must not start Git subprocesses. Repository facts are cached per `spawnCwd`
(its realpath) for 10 s; each answer is then filtered to the sessions this
caller may attach (never the brain pane), so a project appears only because
such a session has its `spawnCwd` inside it. Worktrees of one repository
group into one project. The listing looks at the 200 most recently active
sessions within a 15 s budget; anything it did not reach sets `truncated`,
as does a 51st project (at most 50 are returned). A workspace whose panes
are all closed has no project here (the same evidence rule as
`workspaceId`). A submodule checkout is a project of its own.

#### `GET /api/sessions/<id>/git/branches`

```jsonc
→ 200 {
  "projectId": "a1b2c3d4e5f6",
  "current": { "branch": "main", "head": "<oid>", "detached": false },   // branch/head null when detached/unborn
  "branches": [{
    "name": "phone/fix-login",
    "head": "<oid>",
    "committedAt": 1758712345000,
    "upstream": { "name": "origin/phone/fix-login", "ahead": 2, "behind": 0, "gone": false },  // optional
    "worktree": { "leaf": "phone-fix-login", "main": false, "sessionIds": ["pty-7f3c"] }          // optional
  }],
  "truncated": false
}
→ 404 {error:"session not found"}   409 {error:"not-a-git-repo"}   429 {error:"git-busy"}
→ 409 {error:"git-operation-failed"}   // git could not answer (timeout, failed listing); retry later
```

Local branches (`refs/heads/*`) only, newest tip first, at most 200. Names
are display text; no route accepts one back. `worktree.sessionIds` lists a
pane only when it runs in this same repository (same git common dir); among
nested worktrees the deepest one owns it. A git too old to list worktrees
answers without `worktree`.

#### `POST /api/sessions/<id>/git/worktree`

```json
{ "slug": "fix-login", "requestId": "3f1c2e4a-0b6d-4c1e-9a7f-2d8e5b6c7a90" }
```

Exactly these two keys. `slug` is 1–40 characters of `a-z`, `0-9` and single
hyphens, no leading or trailing hyphen
(`^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$`). `requestId` is a UUID,
minted once when the user taps Create; any letter case is accepted (iOS
`UUID().uuidString` is uppercase) and the server lowercases it, so the
receipt echoes the lowercase form and a retry in either case is the same
request. The server derives everything
else:

- the base: the session's `HEAD` commit, resolved **once** to an oid before
  anything is written (no fetch);
- branch `phone/<slug>`;
- directory `${wmuxHome}/worktrees/<projectId>/phone-<slug>`;
- the command: `git worktree add -b phone/<slug> -- <dir> <base-oid>`, with
  hooks disabled (`core.hooksPath=/dev/null`), so no repository hook runs.

Refused before anything is written: a bare repository, an unborn `HEAD`, a
merge/rebase/sequencer in progress, a repository with submodules
(`.gitmodules` at the base commit; submodules are not checked out by a phone
worktree, so they are refused rather than left empty), and content filters.
The filter check reads the `.gitattributes` files in the base tree (and
`info/attributes`): only a `filter=` attribute that some path in the tree
actually uses refuses the create (`git-filters-require-desktop`). A global
`git lfs install` alone, with no `filter=lfs` in the tree, is not a refusal.

**The answer is asynchronous.** Checking out a tree can take longer than any
reasonable request, so the create never runs inside the HTTP request:

```jsonc
→ 202 { "requestId": "3f1c2e4a-…", "replayed": false, "state": "pending" }
```

Then poll the receipt every 2 s:

```jsonc
GET /api/sessions/<id>/git/worktree/<requestId>
→ 200 {
  "requestId": "3f1c2e4a-…",
  "state": "pending" | "created" | "refused" | "unknown" | "none",
  "projectId": "a1b2c3d4e5f6",                      // created
  "branch": "phone/fix-login",                      // created
  "base": "<oid>",                                  // created: the commit the branch starts at
  "cwd": "/Users/me/.wmux/worktrees/a1b2c3d4e5f6/phone-fix-login",   // created
  "leaf": "phone-fix-login",                        // created
  "error": "branch-exists"                          // refused, or unknown ("git-outcome-unknown")
}
```

A repeat POST with the same body answers **200 with this same receipt body**
plus `replayed: true`, whatever its state; there is one shape for the
created answer. The receipt route needs the input grant, like the POST.

| POST status | `error` | When |
| --- | --- | --- |
| 400 | `invalid-git-request` | body shape, extra key, malformed `requestId` |
| 400 | `invalid-slug` | slug fails the rule |
| 409 | `request-id-conflict` | this `requestId` was used with another slug or session |
| 429 | `git-busy` | four Git/PR jobs already running |
| 503 | `git-receipts-unavailable` | the receipt store could not be read (the key is also hidden) |

Refusals found by the background job land in the receipt as `state:
"refused"` with `error` one of: `branch-exists` (never auto-suffixed),
`branch-namespace-blocked` (a branch named `phone` exists),
`worktree-path-exists`, `path-too-long` (over 260 characters),
`not-a-git-repo` (including bare), `unborn-head`, `submodules-unsupported`,
`git-filters-require-desktop`, `git-operation-in-progress`,
`git-operation-failed`.

**Receipt store.** A new file, `phone-worktree-receipts.json`, `version: 1`,
mode 0600, written durably. Entries are keyed by a hash of (owner,
`requestId`), where the owner is `device:<id>` or `operator`, and expire 24 h
after creation. The `pending` entry is on disk before `git worktree add`
starts. A `pending` entry found after a daemon restart becomes `unknown` with
`error: "git-outcome-unknown"`: list branches to see whether `phone/<slug>`
exists. If the file cannot be read or validated at start, the daemon turns
the worktree routes off and omits `gitWorktrees` (fail closed); it never
starts with an empty store over an unreadable one.

**Opening a pane in it.** Pass the receipt's `cwd` verbatim to the existing
`POST /api/sessions {workspaceId, cwd}`; do not build or edit it. That route
checks only that the directory is usable (`cwd-not-found` otherwise), not
that it is this worktree, so sending anything else is your bug, not a
refusal. The new pane's `spawnCwd` is the worktree, so every Git route
addressed through it acts on the new branch.

**Desktop cleanup.** The desktop's worktree scan lists phone worktrees in a
category of their own, `phone-worktree`, instead of calling them orphans,
and reclaims them through the existing cleanup flow (which already refuses a
dirty worktree). Worktree removal from the phone is not in v1.

Not in v1: push, PR creation, worktree removal, switching an existing
checkout's branch, remote branches.

#### `GET /api/sessions/<id>/git/checks`

```jsonc
→ 200 {
  "state": "available",                 // available | no-pr | unsupported | unavailable
  "pr": { "number": 1658, "url": "https://github.com/o/r/pull/1658", "headOid": "<oid>", "headMatchesLocal": true },
  "overall": "failure",                 // success | failure | pending | none
  "counts": { "total": 8, "passed": 6, "failed": 1, "pending": 1, "skipped": 0 },
  "checks": [
    { "kind": "check-run", "name": "validate", "state": "success", "workflow": "CI",
      "url": "https://github.com/o/r/actions/runs/1/job/2", "startedAt": 1758712345000, "completedAt": 1758713291000 },
    { "kind": "status", "name": "CodeRabbit", "state": "failure" }
  ],
  "truncated": false
}
→ 404 {error:"session not found"}   409 {error:"not-a-git-repo"}   429 {error:"git-busy"}
```

The same pane rule as `/git/branches`: a pane outside any repository is 409
`not-a-git-repo`, never a `state`. A definite answer (`available`, `no-pr`,
`unsupported`) is reused for 20 s per pane; `unavailable` is never reused.

The PR is chosen with the same identity rules as `/git/pr`: a credential-free
github.com `origin`, the session's current branch, the head repository equal
to origin, and the head branch equal to the local branch. The open PR wins,
else the most recent. Then `gh pr view <number> --repo github.com/<owner/repo>
--json number,url,headRefOid,statusCheckRollup`. `headMatchesLocal` says
whether the PR head is the local `HEAD` (the checks may describe a commit you
have not pushed past, or one you do not have). `no-pr` is a definite "no
matching PR"; `unavailable` is a CLI, auth or network failure, never a claim
of no checks. `counts` and `overall` cover the whole rollup; only `checks` is
cut to 100 (`truncated: true`). Every state carries `overall`, `counts`,
`checks` and `truncated`; outside `available` they read `none`, zeros, `[]`
and `false`, and `pr` is absent. `unsupported` is a repository without an
`origin`, or one whose `origin` is not a credential-free github.com repository.

`state` per check: a CheckRun's `COMPLETED` conclusion maps to `success`,
`failure` (also `STARTUP_FAILURE`), `neutral`, `skipped`, `cancelled`,
`timed_out`, `action_required` or `stale`; a CheckRun that is not completed
is `queued` or `in_progress`, and an unrecognized in-flight status is
`pending`. A StatusContext's state maps to `success`, `failure`, `error` or
`pending` (`EXPECTED` too). A completed CheckRun without a recognized
conclusion, or a StatusContext with an unrecognized state, is `unknown`: a
result nobody could read, which counts as **failed**, so `overall` is never
`success` over it. `url` is present only when it parses as a URL whose origin
is exactly `https://github.com`, with no credentials, whitespace or control
characters; anything else is dropped.

### Coordination with open work

- #1658 (Claude AskUserQuestion form) edits `HookIngest.ts` and this document.
  Item 1 wires into the same `StopFailure` emission path, so #1658 lands first.
- #1657 (Codex notify attribution) is why a hand-typed Codex gets no typed
  failure in item 1.
- #1660 (`/app` desktop UI) edits `src/shared/types.ts` and this document;
  this section adds no fields there.
- #1653 (remote pane from the + menu) creates panes on a paired remote host
  through the Surface model, not `POST /api/sessions`; `accountId` does not
  apply to remote panes.
