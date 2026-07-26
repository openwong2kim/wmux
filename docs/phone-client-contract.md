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

---

## 2. Pairing

```
operator (desktop)                   phone
─────────────────────                ─────
daemon.web.pairStart {name}
  → {code, expiresAt}
        ── operator reads the 6-char code aloud ──▶
                                     GET /api/pair?code=ABC123
                                       → 200 {deviceId, deviceSecret, token}
```

`GET /api/pair?code=` is the **only** unauthenticated API route.

- Code: 6 characters, 10 minutes, single use, 5 attempts. The alphabet is
  `A-Z2-9` minus `0 O 1 I`, so it survives being read aloud.
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
| `critical` | `{...payload, id, epoch}` |
| `notify` | `{...payload, id, epoch}` |
| `approval` | `{sessionId, approvalId, phase, state, agent, createdAt, ...}` |

`phase` is `create` / `resolve` / `expire` / `supersede`.

Identity fields (`id`, `epoch`) are stamped **last**, so a pane-supplied payload
can never shadow them.

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
  → 200 {epoch, headId, reset, events: [{...payload, id, kind, at}]}
```

---

## 5. Panes

```
GET /api/config    → {allowInput}
GET /api/sessions  → {sessions: [{id, cwd, cols, rows, state, agent, lastActivity, workspace?, shell?}]}
POST /api/input?session=<id>   body: raw bytes
```

`agent` is null when the pane is not running one; `shell` then says what to call
it.

`POST /api/input` is **403 unless the server was started with `--allow-input`**.
Check `/api/config` and hide the keyboard rather than letting a user type into a
403. `fetch` resolves on 401 and 403 — a lone `.catch()` sees neither, which is a
mistake the browser client made and shipped.

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
home directory. `workspaceId` stamps the new pane's workspace identity; the
human-readable label is filled in from a live pane in that workspace, so a
workspace with no live panes yields a row with no `workspace` field.

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
                                    truncated, omittedBytes}
                               409 {error: 'not-a-git-repo'}
```

Read-only, and **available on a read-only server** — it runs `git diff`,
`git diff --cached` and `git status` in the pane's own working directory and
returns text. Nothing in the request names a directory or a ref.

`status` is the raw two-character porcelain code (`' M'`, `'M '`, `'??'`, `'R '`,
`'UU'`, …): the index column and the worktree column are independent and any
one-word summary loses one of them. `patch` is the staged patch followed by the
working-tree patch; it is capped at 512 KB, and `truncated` says the tail was
cut.

**409 is normal.** Panes run in `~`, in `/tmp`, in scratch directories. Say "no
repository here", not "something went wrong".

---

## 6. Approvals

The reason the app exists. When a Claude Code pane raises an `AskUserQuestion`
prompt, the daemon records a request any authenticated surface can answer.

```
GET  /api/approvals          → {pending: [...], recentlyResolved: [...]}
POST /api/approvals/<id>     body: {decision: 'approve' | 'deny'}
```

Request fields: `id`, `sessionId`, `agent`, `kind`, `state`, `createdAt`, and
optionally `workspaceId`, `question`, `options`, `screenTail`, `decision`,
`resolvedBy`, `resolvedAt`.

`question` and `options` are the agent's own text, sanitized and capped. Render
them — a blind Approve button is not an informed answer.

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
| 409 | `{error: 'already-resolved', resolvedBy}` | Another surface won. `resolvedBy` names it (`operator`, or `device <name> (<id>)`) |
| 410 | `{error: 'expired' \| 'prompt-gone', state?}` | The request outlived its usefulness, or the prompt left the screen. Stop showing it |
| 501 | `{error: 'unsupported-agent'}` | No keystroke map for this agent. Still answerable at the desktop — do not expire it locally |
| 404 | `{error: 'not-found'}` | No such request |

Only Claude Code is mapped today. Approve sends `1` (the first offered option),
deny sends ESC. Neither is followed by a carriage return: on a select, the digit
both moves and confirms, and a stray CR would press whatever the TUI renders
next.

**Known limitation, shipped deliberately:** options are agent-authored, so
Approve means "pick the first option", not "say yes". Deny is exact. A per-option
press needs the option list in the UI — that is app-side work, and the wire
already carries `options`.

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

Reject an envelope older than `PUSH_MAX_AGE_MS` (300 000 ms).

If the extension does not run, the lock screen shows a fixed placeholder
("wmux — New activity"). That is the relay's ceiling, not a bug.

---

### Registering

```
POST /api/push-registration      (device credential, never the operator token)
  body: {apnsToken, publicKey}
  → 200 {ok: true}
  → 400 {error: 'bad-token' | 'bad-key'}
  → 403 {error: 'push-is-for-devices'}
  → 409 {error: 'revoked' | 'not-found' | 'persist-failed'}
  → 503 {error: 'push-unavailable'}
```

`apnsToken` is lowercase hex; `publicKey` is base64 of the 32 raw bytes of your
X25519 public key. Register on every launch — APNs rotates tokens, and a
registration replaces the previous one wholesale rather than merging, so a
regenerated key pair never leaves the daemon sealing to a key you no longer
hold.

A `410` from Apple makes the daemon forget your registration, so a reinstalled
app must register again before it hears anything.

## 8. What is not built yet

- **`session:critical` is notify-only** and is not suitable for a remote approve
  button — see issue #605.
- **The relay is not deployed.** Until `WMUX_PUSH_RELAY_URL` and
  `WMUX_PUSH_RELAY_SECRET` are set on a daemon, push is inert by design — not an
  error, just nothing sent.

---

## 9. Things the browser client got wrong

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
