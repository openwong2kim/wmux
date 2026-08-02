# wmux web — Security Review & Remediation Plan (2026-07-24)

> **Status:** Review complete. Remediation status updated through #764; detailed
> finding text below records the original review state.
> **Scope:** The `wmux web` browser/PWA terminal surface only — the HTTP+SSE server
> inside the daemon, its CLI command, the main↔renderer IPC, and the bundled frontend.
> **Sources reviewed:** `src/daemon/web/WebTerminalServer.ts`, `src/daemon/web/__tests__/WebTerminalServer.test.ts`,
> `src/cli/commands/web.ts`, `src/shared/web.ts`, `src/main/ipc/handlers/web.handler.ts`,
> `src/daemon/web/frontend/{index.html,app.js,sw.js}`, `scripts/build-daemon-web.mjs`.
> **Cross-references:** `docs/SECURITY.md` (the web surface is a **new** trust boundary not
> yet declared there — see §6).

---

## 0. TL;DR

The web feature is **well-designed**. Its safe defaults are the right ones and several
non-obvious defenses are already in place: read-only + loopback-by-default, a per-start
rotating UUID token that never touches the daemon master token, `timingSafeEqual`
comparisons, Bearer-only auth on every non-SSE route, a 64 KB input cap, single-use
pairing with an attempt budget, xterm.js byte rendering (no terminal-output XSS), and
token storage in `sessionStorage` (not `localStorage`).

The residual issues are concentrated in **two areas**: (a) what happens when an operator
opts into network exposure (`--expose`), and (b) the standard localhost-service hardening
that every local HTTP server owes the browser (Host validation, frame protection, CSP).
None of them is a current-data-theft hole from an unauthenticated remote attacker on the
default config; the highest-impact one is operator-awareness-dependent.

**Recommended priority order (cheapest defense-in-depth first, biggest risk after):**

1. Frame protection + `nosniff` + `Referrer-Policy` on responses — ~10 lines, blocks clickjacking.
2. Host-header allowlist — ~25 lines, blocks DNS-rebinding-driven pairing DoS.
3. `connect-src 'self'` CSP — ~build-script work, contains any future XSS to `sessionStorage`.
4. Strengthen the `--expose` cleartext-token warning + offer auto TLS / `tailscale serve`.
5. Pairing-code regeneration after burn/expiry (anti-DoS).

---

## 1. Trust boundary

`wmux web` introduces a **network-reachable HTTP server inside the privileged daemon
process**. Unlike the named-pipe RPC surface (`docs/SECURITY.md` §1.2, same-machine only,
master-token-gated), this server can bind all interfaces on operator opt-in and speaks a
separate per-start token. Anything that reaches a bound port and holds the web token can
read the **entire scrollback of every live pane** and, if `--allow-input` was passed,
**type into any of them**. The review below treats the token as the only confidentiality
and integrity boundary and asks: *what can reach the port, and what can leak the token.*

Boundary strengths already in place (no action needed):

| Property | Where | Verdict |
|---|---|---|
| Read-only by default; input needs `--allow-input` | `WebTerminalServer.ts:387` | ✅ |
| Loopback by default; `--expose` is explicit | `shared/web.ts:56`, `web.ts:53` | ✅ |
| Per-start random token; master token never networked | `WebTerminalServer.ts:121` | ✅ |
| Bearer-only on non-SSE; token stays out of URL logs | `WebTerminalServer.ts:504` | ✅ |
| `timingSafeEqual` on token + pairing code | `WebTerminalServer.ts:479,514` | ✅ |
| 64 KB input cap (memory-exhaustion guard) | `WebTerminalServer.ts:65,402` | ✅ |
| Pairing: single-use, TTL, 5-attempt burn | `WebTerminalServer.ts:69-74,465` | ✅ |
| xterm.js byte render; metadata via `textContent` | `app.js:601,407` | ✅ no XSS |
| Token in `sessionStorage`, stripped from URL post-load | `app.js:17-24` | ✅ |
| `clientError` + `closeAllConnections` can't crash/hang daemon | `WebTerminalServer.ts:148,215` | ✅ |
| Static assets are fixed in-memory buffers (no path traversal) | `WebTerminalServer.ts:517` | ✅ |

---

## 2. Findings summary

| ID | Severity | Finding | Location | Status |
|---|---|---|---|---|
| W1 | **Medium** | Bare `--expose` sends the token + full scrollback in cleartext over HTTP | `WebTerminalServer.ts`, `web.ts` | 🟡 Mitigated — explicit warning shipped via [#607](https://github.com/openwong2kim/wmux/issues/607); native `--tls-cert`/`--tls-key` added via [#764](https://github.com/openwong2kim/wmux/issues/764); bare `--expose` remains plaintext by design |
| W2 | **Medium** | No frame protection → authenticated localhost page is clickjackable (worse with `--allow-input`) | `WebTerminalServer.ts:517` (`serveStatic`) | ✅ Resolved — `securityHeaders()` on every response |
| W3 | **Low-Med** | No `Host` header validation → DNS rebinding can reach unauthenticated `/api/pair` and burn it (pairing DoS) | `WebTerminalServer.ts:238` | ✅ Resolved — Host allowlist checked before routing |
| W4 | **Low** | No `Content-Security-Policy`; an XSS (future regression) would exfiltrate the token freely | `index.html` / `serveStatic` | ✅ Resolved — [#608](https://github.com/openwong2kim/wmux/issues/608): full policy on `GET /` with per-build inline-script hashes, `connect-src 'self'` |
| W5 | **Low** | Pairing code is generated once per start; after burn/expiry it is gone until restart → permanent pairing DoS | `WebTerminalServer.ts:123,449` | ✅ Resolved — cooldown-limited regeneration |
| W6 | **Info** | `timingSafeEqual` short-circuits on length; `nosniff` absent; SSE token in URL (unavoidable, contained) | `WebTerminalServer.ts:512-514`, `:528` | ✅ No action needed (nosniff shipped with W2) |

The detailed findings below are kept as reviewed (pre-remediation), for the record; the
Status column above is authoritative for what actually shipped.

Severity assumes the **default** config unless the finding is specifically about the
opt-in. "Low" = defense-in-depth or availability; "Medium" = real exploitable risk under
documented operator choices.

---

## 3. Detailed findings & remediation

### W1 — Cleartext token over `--expose` (Medium)

**Impact.** `wmux web --expose` binds `0.0.0.0` over plain HTTP. The per-start UUID token
(and the entire scrollback, which routinely contains secrets) travels unencrypted. Any
on-path observer on the same LAN/Wi‑Fi — ARP spoofing, a rogue AP, monitor mode on open
Wi‑Fi, or a corporate MITM proxy — captures the token and gains full read (and, with
`--allow-input`, write) access to every pane.

**Current warning gap.** `web.ts:96-109` tells the operator to "treat the URL as a secret"
and warns about secrets *on screen*, but never states that the **token itself is sniffable
on untrusted networks**. The `tailscale serve` mention is framed as a PWA/install
convenience, so it reads as optional rather than as the security floor.

**Remediation (pick one tier).**

- **Tier A (wording, ship now):** When `exposed === true`, print a stronger, explicit
  cleartext warning, e.g.:

  ```text
  ⚠ EXPOSED OVER PLAIN HTTP. The access token and your full scrollback travel
    UNENCRYPTED. Anyone on this network who can sniff traffic (open Wi-Fi, ARP
    spoof, corporate proxy) can steal the token and read every pane. Use this
    only on a trusted network, or front it with HTTPS (`tailscale serve`,
    `caddy`, nginx) before opening it remotely.
  ```

- **Tier B (wording + nudge):** On `--expose`, if a Tailscale adapter
  (`collectIpv4` already detects `100.64.0.0/10`) is present, auto-suggest
  `tailscale serve --bg` in the report.

- **Tier C (TLS, larger):** Add a `--tls-cert`/`--tls-key` pair (or auto-TLS via a
  packaged `tailscale serve` wrapper) so the daemon can serve HTTPS directly. This is the
  only tier that removes the risk instead of warning about it.

**Acceptance.** `--expose` report contains the word "UNENCRYPTED" and a concrete HTTPS
fronting instruction; a test in `web.handler.test.ts` (or a CLI snapshot) asserts the
wording is present when `host === '0.0.0.0'`.

---

### W2 — No frame protection; clickjacking of an authenticated terminal (Medium)

**Impact.** `serveStatic` (`WebTerminalServer.ts:517`) sets no `X-Frame-Options` or CSP
`frame-ancestors`. A page on `evil.com` can iframe `http://127.0.0.1:<port>/`. The framed
page is same-origin for `127.0.0.1:<port>`, so it reads its own `sessionStorage` token,
connects, and renders the live terminal. SOP prevents the attacker page from *reading* the
content cross-origin — but it can overlay UI to trick the user into clicking within the
terminal, and if `--allow-input` is enabled, those clicks/keystrokes go into the pane
(UI redressing). This is the standard localhost-service clickjacking vector.

**Remediation.** Add a small header helper and apply it to HTML (and cheaply, all)
responses:

```ts
// WebTerminalServer.ts
private securityHeaders(): Record<string, string> {
  return {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',         // also helps W6 (SSE token in URL)
    'Content-Security-Policy': "frame-ancestors 'none'", // see W4 for the full policy
  };
}
```

Spread `...this.securityHeaders()` into `serveStatic`'s `extraHeaders` default and into
`json()`/`handle()` responses. `frame-ancestors 'none'` is the CSP successor to
`X-Frame-Options: DENY` and is respected by modern browsers; keep both for coverage.

**Acceptance.** New test: a `GET /` returns `x-frame-options: DENY`; fetching `/` from a
synthetic iframe-origin is not required — the header presence assertion is sufficient.
Add to `WebTerminalServer.test.ts`.

---

### W3 — No Host-header validation; DNS-rebinding pairing DoS (Low-Medium)

**Impact.** `handle()` (`WebTerminalServer.ts:238`) never inspects `Host`. On the default
loopback bind, a malicious webpage can DNS-rebind its own domain to `127.0.0.1` and reach
the server from the user's browser. `/api/*` still needs the token (CORS blocks reading
responses, and the token lives in a different origin's `sessionStorage`), so **terminal
data is not exposed**. The reachable surface is the **unauthenticated** `/api/pair` route
(`WebTerminalServer.ts:265`): the attacker page can fire up to 5 wrong codes and
permanently burn the pairing code (see W5), denying phone pairing to the legitimate user
until the server restarts. This is a localized availability issue, not confidentiality.

**Remediation.** Reject requests whose `Host` is not one of the addresses the server
actually serves. Populate an allowlist at `start()` and check it at the top of `handle()`:

```ts
// at start(), after bind:
this.allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
if (host === '0.0.0.0' || host === '::') {
  for (const ip of collectIpv4()) this.allowedHosts.add(ip);
  this.allowedHosts.add(this.opts!.host); // the literal bind, e.g. a specific NIC IP
} else {
  this.allowedHosts.add(host);
}

// top of handle() — bracket-aware, so a legitimate `[::1]:7681` Host is not
// mangled into `[` by a naive split(':'):
const hostHeader = req.headers.host ?? '';
const h = hostHeader.startsWith('[')
  ? hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase()
  : hostHeader.split(':')[0].toLowerCase();
if (!this.allowedHosts.has(h)) {
  return this.json(res, 403, { error: 'host not allowed' });
}
```

This is the same control Electron, Docker, and VS Code apply to their local HTTP servers.
`localhost` is included so the PWA's own origin resolves; raw IPs are included so a phone
hitting the LAN IP is not rejected.

**Acceptance.** New tests: (a) `Host: localhost` is accepted, (b) `Host: evil.com` is
rejected with 403, (c) under `--expose`, the detected LAN IP is accepted.

---

### W4 — No Content-Security-Policy (Low)

**Impact.** Today there is no XSS (xterm writes bytes; metadata uses `textContent`). But a
future regression that rendered a session field as HTML would run in the page's origin and
could read the token from `sessionStorage`. A strict CSP — especially `connect-src 'self'`
— turns such a regression into a no-exfil dud: even with script execution, the token
cannot leave the origin.

**Remediation.** The build already inlines everything into one self-contained
`terminal.html` (`build-daemon-web.mjs` comment even notes "CSP-safe"). Two options:

- **Quick:** `script-src 'self' 'unsafe-inline'; ...` — weak (inline allowed) but still
  gets `connect-src 'self'` exfil-blocking.

- **Right:** have `build-daemon-web.mjs` compute `sha256-...` of each inlined block
  (`xterm.js`, `app.js`) after substitution and inject them into a CSP `<meta>` or the
  response header. Then:

  ```text
  default-src 'none';
  script-src 'self' 'sha256-<xterm>' 'sha256-<app>';
  style-src 'self' 'unsafe-inline';     // xterm + app CSS, or hash these too
  img-src 'self' data:;
  connect-src 'self';                    // SSE + fetch only to own origin
  manifest-src 'self';
  frame-ancestors 'none';
  base-uri 'none';
  form-action 'self';
  ```

  Hashing is deterministic over the built blob, so it is stable per release. Ship as the
  full `securityHeaders()` policy from W2.

**Acceptance.** Browser devtools shows no CSP violations on a working session; a test
asserts `connect-src` is present in the `Content-Security-Policy` header on `GET /`.

---

### W5 — Pairing code never regenerates; permanent DoS (Low)

**Impact.** `generatePairCode()` runs only in `start()` (`WebTerminalServer.ts:123,449`).
After 5 wrong attempts (`:472`) or 10-minute expiry (`:468`) the code becomes `''` until
the next `start()`. Combined with W3, a webpage can burn the code; combined with W1, a
network attacker can too. The legitimate user then cannot pair from a phone without
re-running `wmux web`.

**Remediation (choose).**

- **Regenerate-on-demand:** when `/api/pair` finds the code empty/expired/burned, mint a
  fresh one and surface it via `daemon.web.status` (the CLI already polls status). Add a
  short cooldown (e.g. refuse regeneration more than once per 30 s) to avoid trivial
  regeneration storms.

- **Per-IP rate limit on `/api/pair`:** cap wrong-code attempts per source IP (e.g. 10/min)
  independent of the global burn budget, so a single attacker cannot exhaust the feature
  for everyone.

Either bounds the DoS to "wait a bit and try again" instead of "restart the server".

**Acceptance.** Test: after burning the code, `status()` reports a *new* code (under the
regen-on-demand option) rather than none; or, after N wrong attempts from one fake IP, the
4th returns a 429 (under the rate-limit option).

---

### W6 — Informational (no action required)

- **Timing length leak:** `a.length === b.length && crypto.timingSafeEqual(...)` at
  `:512-514` short-circuits on length. Non-issue here because both compared values have
  fixed, public formats (36-char UUID token; 6-char pairing code). No change.
- **`nosniff`:** addressed by W2's `securityHeaders()`.
- **SSE token in URL:** unavoidable (EventSource cannot set headers), already narrowed to
  the single `/api/stream` route; the page strips the token from its own `location.search`
  (`app.js:20-24`) so Referer does not carry it. W2's `Referrer-Policy: no-referrer`
  closes the last gap.

---

## 4. Suggested phasing

| Phase | Items | Effort | Risk reduced | Status |
|---|---|---|---|---|
| **P1 — ship now** | W2 (frame + nosniff + referrer) + W1 Tier A (wording) | ~1 h | Clickjacking; operator misuse of `--expose` | ✅ Shipped ([#607](https://github.com/openwong2kim/wmux/issues/607)) |
| **P2 — next PR** | W3 (Host allowlist) + W5 (pairing regen/rate-limit) | ~3 h | DNS-rebinding DoS; pairing DoS | ✅ Shipped in this PR |
| **P3 — hardening** | W4 (full hashed CSP; hashes computed server-side from the served bytes, not in the build script) | ~0.5 day | Containment under future XSS | ✅ Shipped ([#608](https://github.com/openwong2kim/wmux/issues/608)) |
| **P4 — optional** | W1 Tier C (native TLS or `tailscale serve` wrapper) | larger | Removes cleartext risk instead of warning | ✅ Native TLS implemented ([#764](https://github.com/openwong2kim/wmux/issues/764)) |

P1–P4 mitigation work is implemented. W1 remains an operator-selected risk on bare
`--expose`; the default remains loopback-only and read-only, and network exposure
still requires an explicit operator choice.

---

## 5. Test additions

All go in `src/daemon/web/__tests__/WebTerminalServer.test.ts` alongside the existing
auth/pairing/teardown tests:

1. `GET /` returns `x-frame-options: DENY` and a CSP containing `frame-ancestors 'none'`
   and `connect-src 'self'`. (W2, W4)
2. `GET /` with `Host: evil.example` returns 403; with `Host: localhost` returns 200;
   under `--expose`, with `Host: <detected LAN IP>` returns 200. (W3)
3. After 5 wrong pairing attempts, `status()` either reports a fresh code (regen option)
   or further `/api/pair` calls from the same IP return 429 (rate-limit option). (W5)

No new dependencies required — all assertions use the existing `fetch` + bearer helper
already in the test file.

---

## 6. Documentation follow-up (complete)

`docs/SECURITY.md` §1.5 now declares the **Browser/PWA terminal server** as a trust
boundary. It records the credential model, loopback/expose split, read-only default,
separate input/upload grants, and the three confidentiality postures: native TLS,
Tailscale HTTPS, and explicitly warned plaintext binding.
