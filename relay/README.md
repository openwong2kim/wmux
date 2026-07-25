# wmux push relay

A stateless Cloudflare Worker that forwards already-encrypted push notifications
from wmux daemons to Apple Push Notification service.

## Why this exists

APNs will only accept pushes signed with the iOS app's `.p8` provider key. That
key cannot ship inside user daemons — whoever holds it can push to every wmux
user — so a relay operated by the project sits in between. This is a release
component, not a developer convenience: every user's daemon is a client of this
one deployment, and the owner's own daemon is simply its first client.

## The operator cannot read notification contents

This is the product claim, and it is meant to be checkable by reading
`src/index.ts` rather than trusted:

1. **The relay has no key material for the payload.** The daemon seals the
   notification with AES-256-GCM under a key derived from the per-device secret
   established at pairing (`src/shared/push/pushEnvelope.ts` in the main repo).
   That secret exists only on the daemon and on the paired iPhone. It is never
   sent here, and the relay has no pairing endpoint that could obtain one.
2. **The ciphertext is never opened.** It arrives as one opaque base64 string
   containing the whole envelope — including the device id and timestamp — so
   the relay cannot even see which device a notification is for beyond the APNs
   token it was told to use. `validate.ts` checks its length and charset;
   nothing in the relay calls `atob`, `JSON.parse`, or takes a substring of it.
   It is copied verbatim into the APNs payload.
3. **It cannot be logged.** `logEvent` in `src/index.ts` is the only logging
   path, and its parameter type admits exactly five fields — `event`, `status`,
   `apnsStatus`, `reason`, `ms` — none of which can hold a payload or a device
   token. Rejection reasons name the *field* that was wrong, never its value.
   Tests assert that nothing reaches the console on the success, rejection,
   APNs-error, and transport-error paths.
4. **There is nowhere to keep anything.** No KV, no D1, no queue, no database,
   no accounts. The single piece of state is the cached APNs provider JWT in
   isolate memory.

What the operator *can* see, and what Apple can see, is routing metadata: an
APNs device token, a payload size, a timestamp, and Apple's response code. The
visible alert the relay sends is a fixed placeholder ("wmux — New activity"); the
iOS Notification Service Extension decrypts on-device and rewrites it.

## Deploy

Prerequisites: a Cloudflare account, `wrangler` authenticated (`wrangler login`),
and an APNs auth key from the Apple Developer portal (Certificates, Identifiers
& Profiles → Keys → new key with the "Apple Push Notifications service" box
ticked; the `.p8` downloads exactly once).

```sh
cd relay
npm install
npm run typecheck

wrangler secret put APNS_KEY_P8    # paste the whole .p8 file, BEGIN/END lines included
wrangler secret put APNS_KEY_ID    # 10 chars, shown next to the key in the portal
wrangler secret put APNS_TEAM_ID   # 10 chars, top-right of the developer portal
wrangler secret put APNS_TOPIC     # the app's bundle id, e.g. com.example.wmux

npm run deploy
```

For TestFlight and debug builds, deploy the sandbox variant as well — it targets
`api.sandbox.push.apple.com` and carries its own copies of the four secrets:

```sh
wrangler secret put APNS_KEY_P8 --env sandbox   # …and the other three
npm run deploy:sandbox
```

Verify:

```sh
curl -s https://<your-worker>.workers.dev/health          # {"ok":true}
wrangler tail                                             # structured JSON log lines
```

### The four secrets

| Name | What it is | Where it comes from |
| --- | --- | --- |
| `APNS_KEY_P8` | Contents of `AuthKey_XXXXXXXXXX.p8` | Apple Developer portal, Keys |
| `APNS_KEY_ID` | 10-character key identifier | shown beside the key |
| `APNS_TEAM_ID` | 10-character team identifier | portal membership page |
| `APNS_TOPIC` | The iOS app's bundle identifier | Xcode target settings |

`APNS_ENV` is a plain var in `wrangler.toml`, not a secret: it only selects the
Apple host. Anything other than `sandbox` means production.

## API

### `POST /push`

```json
{
  "apnsDeviceToken": "<64-200 hex chars>",
  "ciphertext": "<base64 push envelope, ≤ 4000 chars>",
  "priority": 10,
  "collapseId": "ap_1234"
}
```

`priority` (5 or 10, default 10) and `collapseId` (≤ 64 chars,
`[A-Za-z0-9_.:-]`) are optional.

The response carries Apple's status code verbatim, plus a
`x-wmux-relay-stage: relay|apns` header so a caller can tell "the relay refused"
from "Apple refused" without guessing:

```json
{ "ok": true, "apnsStatus": 200, "apnsId": "…" }
```

Statuses worth handling in the daemon's `PushSender`:

| Status | Stage | Meaning |
| --- | --- | --- |
| 200 | apns | delivered to Apple |
| 400 | relay | malformed request; `reason` names the bad field |
| 400 | apns | Apple rejected it, e.g. `BadDeviceToken` |
| 403 | apns | provider-token problem; the relay already retried once |
| **410** | apns | **token is dead — prune the device record** |
| 413 | relay | body or ciphertext over the cap |
| 429 | apns | Apple is rate-limiting; back off |
| 500 | relay | `relay-misconfigured` (a secret is unset) or an internal error |
| 502 | relay | `apns-unreachable` / `apns-timeout` |

### `GET /health`

Returns `{"ok":true}`. Says nothing about configuration or traffic.

## Design notes

**Provider-token caching.** Apple accepts a token for one hour and rate-limits
issuing new ones, so the signed JWT is cached in isolate memory for 50 minutes
(`TOKEN_MAX_AGE_MS`). Isolate recycling costs one re-sign. A 403 with
`ExpiredProviderToken` or `InvalidProviderToken` drops the cache and retries the
push exactly once, so a clock jump degrades one request rather than every
request until the isolate recycles.

**Payload expiry.** `apns-expiration` is set to 300 seconds, matching
`PUSH_MAX_AGE_MS` in the envelope: a notification delivered after the envelope
goes stale would be rejected by the extension anyway, so asking Apple to keep
retrying past that point only produces an alert the phone will refuse.

**Rate limiting is not in the code.** The relay is deliberately unauthenticated
— accounts would mean a user database, which is exactly what "no storage" rules
out. A stranger who learns an APNs device token could therefore cause junk
notifications for that one device, but cannot produce a *readable* one: the
extension will fail to decrypt anything not sealed with the device's key, and
the user sees nothing beyond the generic placeholder. Mitigate volume with a
Cloudflare rate-limiting rule on `/push` (per-IP, and per-path) rather than with
application state.

**Interruption level.** The relay cannot know whether a notification is an
approval request or routine noise — it cannot read it. The extension sets
`interruptionLevel` when it rewrites the content on-device.

## Tests

The suites live in `relay/__tests__/` and run with the main repo's vitest, from
the repo root:

```sh
node ./node_modules/vitest/vitest.mjs run relay/__tests__
```

They generate a throwaway P-256 key at runtime; no key material, real or fake,
is committed.

Type checking is separate from the repo root's `tsc --noEmit`, because this code
targets the WebWorker global scope and must not see `@types/node`:

```sh
node ./node_modules/typescript/bin/tsc --noEmit -p relay/tsconfig.json
```
