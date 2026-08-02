# The contract a wmux phone client implements

Everything a native client needs from the daemon, extracted from the code that
serves it rather than written alongside it. The browser page in
`src/daemon/web/frontend/` is a working reference implementation of all of it.

Server: `src/daemon/web/WebTerminalServer.ts`. Push envelope:
`src/shared/push/pushEnvelope.ts`. Relay: `relay/`.

---

## 1. Transport, and the one rule that shapes everything else

The daemon speaks plain HTTP. It is expected to sit behind a TLS front — the
supported setup is `wmux web --tailscale`, which binds `127.0.0.1` and lets
`tailscale serve` terminate HTTPS on the tailnet.

**A device credential never expires.** That single fact drives most of the rules
below: the daemon refuses to mint one over a plaintext non-loopback bind, refuses
to accept one from a query string, and issues short-lived tickets for the one
transport that cannot send headers.

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

The first paint is **capped**, and never cut mid-character or mid-escape. When
`truncated` is true, `omittedBytes` says how much history is above — surface it
rather than pretending the buffer starts there.

### `GET /api/events?ticket=<t>` — fleet-wide attention

Send `Accept: text/event-stream`. The same path without that header is a plain
JSON backlog fetch (Bearer only).

| Event | Data |
| --- | --- |
| `reset` | `{epoch, headId}` — **resync now**, discard your cursor |
| `critical` | `{...payload, tier, id, epoch}` |
| `notify` | `{...payload, tier, id, epoch}` |
| `approval` | `{sessionId, approvalId, phase, state, agent, createdAt, tier, risk?, ...}` |

`phase` is `create` / `resolve` / `expire` / `supersede`.

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
GET /api/config    → {allowInput, allowUpload, protocolVersion, minProtocolVersion, serverVersion}
GET /api/sessions  → {sessions: [{id, cwd, cols, rows, state, agent, lastActivity, workspace?, shell?}]}
POST /api/input?session=<id>   body: raw bytes
```

`agent` is null when the pane is not running one; `shell` then says what to call
it.

`POST /api/input` is **403 unless the server was started with `--allow-input`**.
Check `/api/config` and hide the keyboard rather than letting a user type into a
403. `fetch` resolves on 401 and 403 — a lone `.catch()` sees neither, which is a
mistake the browser client made and shipped.

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
`decision`, `resolvedBy`, `resolvedAt`, `selectedChoiceKey`.

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

Claude Code's **permission prompts** (tool-approval gate, "Do you want to
proceed?") have no hook — they are detector-only. Until Claude Code exposes an
authoritative hook for permission prompts, the phone cannot answer them.

**Codex CLI, Kiro CLI, and other TUI-only agents** have no hook integration and
no authoritative keystroke mapping. They report `unsupported-agent` (501). Their
prompts are answered with the phone pane's terminal controls when `--allow-input`
is enabled, or at the desktop otherwise. Structured choice
support for these agents will be added only after their respective projects
expose authoritative approval hooks — the daemon does not guess keystrokes.

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
