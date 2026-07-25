# wmux — Adversarial Security Audit (2026-07-25)

> **Status:** Audit complete. No code changed. Owner decision pending on P0/P1 phasing.
> **Scope:** Full audit — Electron main/renderer/preload, MCP broker + tools, daemon
> pipe server, web terminal server (opt-in), LanLink (opt-in), CDP exposure, CI/CD
> pipeline, dependency supply chain, git history.
> **Methodology:** `cso` skill (daily mode, 8/10 confidence gate). Three parallel
> `explore` agents mapped (a) IPC + preload + spawn, (b) MCP + HTTP + SSRF + TLS,
> (c) secrets + CI + install scripts. Manual reads of `navigationPolicy.ts`,
> `src/main/index.ts`, `docs/SECURITY.md`. `npm audit` + targeted greps for each
> OWASP class.
> **Cross-references:** `docs/SECURITY.md` (threat model this audit validates),
> `docs/web-security-review-2026-07-24.md` (web-surface-specific review).

---

## 0. TL;DR

This is one of the more disciplined Electron apps we have reviewed. The threat model
in `docs/SECURITY.md §3` is **explicit and honest**: wmux is a terminal substrate,
not a secure data vault, and same-user processes on the same machine are out of
scope. The codebase concentrates its defensive effort inside that scope and does
not waste it on theater outside.

**Maturity: 8.5 / 10.** Defenses are consistent across the highest-risk handlers
(`pty:create`, `fs:writeFile`, `shell:openPath`, `browser_open`): allow-lists,
`realpath`-based symlink re-checks, and SSRF guards with post-DNS resolution.
Secrets hygiene is strong — no hardcoded credentials, no tracked `.env`, no
disabled TLS, git history clean.

**One genuine gap.** The Electron CDP remote-debugging port is **on by default**
on a "randomized" port in `[18800, 18900)`. Randomization is presented as a
boundary; it is not. Any same-user process can read `DevToolsActivePort` or
scan 100 ports in milliseconds and then drive the renderer over CDP — which
gives it reach into every privileged IPC handler. This is the single shortest
path around every other defense. It is technically inside the SECURITY.md §3
same-user disclaimer, but it materially widens that opening and is fixable.

**Recommended priority:** P0 (CDP) buys the most defense, but not for the least
effort — see the correction in §2. P1 is consistency fixes (path confinement on
`git`/`gh` handlers, SHA-pinned CI actions, `env:` interpolation in
`release.yml`) and is where the cheap wins actually are. P2 is optional
hardening.

---

## 1. Findings (severity-ordered)

| ID | Severity | Title | Effort (CC) |
|----|----------|-------|-------------|
| F1 | MEDIUM | CDP remote-debugging port on by default — [#613](https://github.com/openwong2kim/wmux/issues/613) | needs design — see §2 correction |
| F2 | MEDIUM | `git`/`gh` execFile calls accept unconfined `repoPath` — [#615](https://github.com/openwong2kim/wmux/issues/615) | ~2h |
| F4 | LOW | CI workflows use tag-pinned (not SHA-pinned) actions — [#615](https://github.com/openwong2kim/wmux/issues/615) | ~15min |
| F5 | LOW | `release.yml` interpolates step outputs into PowerShell `run:` — [#615](https://github.com/openwong2kim/wmux/issues/615) | ~20min |
| F3 | LOW | `WebTerminalServer /api/pair` is unauthenticated (rate-limited) — [#615](https://github.com/openwong2kim/wmux/issues/615) | ~30min |
| F6 | LOW | 48 npm audit findings, all in devDependencies — [#615](https://github.com/openwong2kim/wmux/issues/615) | optional |

Severity is calibrated against the stated threat model. Items marked same-user
are not new vulnerabilities in the SECURITY.md sense — they are distance-closing
opportunities that reduce the surface available to a same-user attacker.

---

## 2. P0 — Close the CDP shortcut

### F1. Electron CDP enabled by default on a "random" port

**Location:** `src/main/index.ts:128-137`

```ts
let cdpPort = 0;
if (process.env.WMUX_DISABLE_CDP !== 'true') {
  const basePort = 18800;
  const range = 100;
  cdpPort = basePort + crypto.randomInt(range);
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort.toString());
  console.log(`[WinMux] CDP enabled on port ${cdpPort}`);
}
```

**Attack scenario.** A process running as the same user:
1. Reads `DevToolsActivePort` from the user-data dir, OR scans 100 ports on
   loopback in milliseconds.
2. Connects to the CDP HTTP endpoint at `http://127.0.0.1:<port>/json`.
3. Drives the renderer via `Target.createTarget`, `Runtime.evaluate`,
   `Page.navigate`. This is full renderer control.
4. From the renderer, calls every privileged IPC handler that the preload
   exposes — `pty:create`, `pty:write`, `fs:writeFile`, `shell:openPath`,
   `rpc:invoke`. That is the ballgame: shell spawn, file write, path open.

The `WMUX_DISABLE_CDP=true` opt-out exists but defaults to off. The port
randomization does not change the security boundary — it changes the
convenience of the scan.

**Why this matters more than the other same-user items.** All other same-user
attacks require reading the auth token file or attaching a debugger. CDP needs
neither — it is a network-style socket that bypasses the token gate entirely.
Every other defense (token DACL re-hardening, shell allow-list, SSRF guard)
runs through the same IPC surface that CDP exposes for free.

**Recommendation (in priority order):**

> **Correction (2026-07-25, after the audit was published).** The original
> version of this section recommended option A — switching to
> `--remote-debugging-pipe` — at ~1h, on the claim that Playwright's
> `connectOverCDP` supports pipe transport. **That claim is wrong and option A
> is withdrawn.** Two independent blockers:
>
> 1. **Playwright cannot attach over a pipe.** `ConnectOverCDPOptions` in
>    playwright-core 1.58.2 exposes `endpointURL`, `headers`, `isLocal`,
>    `logger`, `slowMo`, `timeout` — no transport hook.
>    `--remote-debugging-pipe` speaks CDP over fd 3/4, which
>    `connectOverCDP(endpointURL)` has no way to reach. Every call site is
>    HTTP or WebSocket: `PlaywrightEngine.ts:283`
>    (`connectOverCDP('http://localhost:<port>')`), `PlaywrightEngine.ts:791`
>    (`/json` fetch), `WebviewCdpManager.ts:176`
>    (`ws://127.0.0.1:<port>/devtools/page/...`), `WebviewCdpManager.ts:179`.
> 2. **The port is public API.** `docs/api/reference.md:135-144` documents
>    `browser.cdp.info`, `browser.cdp.target`, `browser.type.cdp`,
>    `browser.click.cdp`, `browser.press.cdp`, and
>    `src/main/pipe/handlers/browser.rpc.ts:587` returns `cdpPort` to callers.
>    External MCP consumers attach to that port by contract. Removing it is a
>    breaking change and forces a `gen-api-reference.mjs` regeneration.

| Option | Effort (CC) | Trade-off |
|--------|-------------|-----------|
| ~~A. Switch to `--remote-debugging-pipe`~~ | — | **Withdrawn.** Playwright cannot attach over a pipe, and `cdpPort` is a documented RPC return value. See the correction above. |
| **B. Default off, opt-in via `--enable-cdp`** | ~30min | Keeps the port mechanism, so Playwright and the `browser.cdp.*` contract are untouched — only the default flips, and `WMUX_DISABLE_CDP=true` already proves the opt-out path works. Cost: `browser_*` MCP tools stop working out of the box, so anyone using browser automation has to flip a flag. That user-visible regression is the real decision here, not the engineering effort. |
| **C. CDP handshake token** | ~4-6h (was estimated ~2h) | Front the CDP port with a proxy that checks a token and relays. `connectOverCDP` accepts a `headers` option, so the Playwright side is feasible — but `WebviewCdpManager`'s direct `ws://` connection at `:176` has to be routed through the proxy too, and the proxy becomes a component that has to stay alive for the lifetime of the app. Earlier ~2h estimate assumed only `/json/list` needed intercepting; it does not. |

**Recommend B**, with the caveat that it is a product decision as much as a
security one — it turns browser automation into opt-in. If that regression is
unacceptable, C is the fallback at meaningfully higher cost. Owner decision
required before either is started.

**Verification (option B):** add a test asserting no `--remote-debugging-port`
switch is appended unless the opt-in is present, and confirm that with the flag
set, `src/mcp/playwright/PlaywrightEngine.ts:283`'s `connectOverCDP` still
attaches.

---

## 3. P1 — Consistency fixes

### F2. `git` / `gh` execFile calls accept unconfined `repoPath`

**Locations:**
- `src/main/ipc/handlers/worktree.handler.ts:494, 503, 516, 528, 542, 554, 566`
- `src/main/ipc/handlers/diff.handler.ts:446, 473, 490` (note: `diff:apply-hunks` writes files)
- `src/main/ipc/handlers/toolbar.handler.ts:23` (`git:status` with renderer-supplied `cwd`)
- `src/main/ipc/handlers/github.handler.ts:51, 62`

**Current state.** Arguments are validated as non-empty strings. `repoPath` /
`cwd` is passed verbatim to `git -C <path>`. There is no confinement to a
project root or workspace root, and no sensitive-path blocklist applied.

**Contrast with `pty:create`** (`pty.handler.ts:48-68`) which uses an
`isAllowedShell()` basename allow-list plus `validateCwd()` (existence + UNC
block), and `fs:readFile` / `fs:writeFile` (`fs.handler.ts:19-77`) which run
through `resolveAccessiblePath()` with a sensitive-path blocklist
(`.ssh`, `.aws`, `.gnupg`, `.kube`, `.env`, `.npmrc`, `.netrc`,
`.wmux-auth-token`, …) and `realpath`-based symlink re-check.

The shell-spawn surface is well-guarded; the more-frequently-called git surface
is not. This is an inconsistency, not a fresh hole — same-user already wins —
but it is the kind of inconsistency an audit should flag.

**Recommendation.** Reuse `resolveAccessiblePath()` from `fs.handler.ts:19-77`
for every renderer-supplied path that reaches `git -C` / `gh`. Alternatively,
confine to registered workspace roots. `diff:apply-hunks` writes file
modifications inside the supplied directory and deserves the strongest guard
of the three.

**Verification:** add test cases that assert arbitrary paths
(e.g. `~/.ssh/`, `/etc/`) are rejected by each affected handler.

### F4. CI workflows use tag-pinned, not SHA-pinned, actions

**Locations:**
- `.github/workflows/ci.yml:14, 16`
- `.github/workflows/ci-cross-platform-baseline.yml:48, 51`
- `.github/workflows/perf.yml:39, 43, 85`

**Current state.** `release.yml` is SHA-pinned with the convention
`actions/checkout@<sha> # v4`. CI workflows are not — they use `@v4` tags.

**Why it matters.** A compromised maintainer account or a tag-retag attack on
a first-party action would let an attacker run modified code inside the CI
runner with access to `secrets.*`. SHA-pinning (already used in `release.yml`)
defeats this.

**Recommendation.** Apply the `release.yml` discipline to all workflows. This
is mechanical — resolve each tag to its current SHA and paste with the same
`# vN` comment convention. ~15 minutes.

### F5. `release.yml` interpolates step outputs into PowerShell `run:` blocks

**Locations:** `.github/workflows/release.yml:110-111, 129, 204-205, 218`

**Current state.** `${{ steps.pkg.outputs.version }}` and
`${{ steps.checksum.outputs.sha256 }}` are interpolated directly into
`run:` blocks. Both values come from earlier steps (`package.json` version,
file hash). The maintainers are aware — `release.yml:154-157` documents the
concern, and `release.yml:159` already demonstrates the safer pattern
(`PKG_VERSION` passed through `env:`).

**Recommendation.** Migrate every interpolation in `release.yml` to the
`env:` + `$ENV_VAR` pattern that `release.yml:159` already uses. Maintainer
intent is already there; this is finishing the job.

---

## 4. P2 — Optional hardening

### F3. `WebTerminalServer /api/pair` is unauthenticated

**Location:** `src/daemon/web/WebTerminalServer.ts:440`, reachable only when
operator runs `wmux web --expose` (`src/cli/commands/web.ts:7`,
`EXPOSE_HOST = '0.0.0.0'`).

**Current mitigations (already strong):**
- 5-attempt burn limit (`:94`, `:846`)
- 10-minute TTL (`:92`)
- 30-second regeneration cooldown (`:100`)
- `Sec-Fetch-Site: cross-site` refused (`:448`) — defeats `<img>` code-burning
- DNS-rebinding host allowlist (`:280-295`, `:413`)
- Per-start random `crypto.randomUUID()` token (`:215`), timing-safe compared
  (`:881-892`)

**Residual:** An attacker on the LAN who discovers the port can burn the
pairing code, forcing the operator to regenerate. Practical exploitation is
near-zero (5 guesses in 1,000,000), but defense-in-depth is cheap.

**Options (pick one):**
- Increase pairing code from 6 digits to 8 (1M → 100M space)
- Per-IP rate limit (1 attempt / 30s) in addition to the global burn budget

### F6. `npm audit` — 48 vulnerabilities, all in devDependencies

**Current state.** 1 critical (CWE-770 in `tmp`, transitive via
`@electron-forge/cli` → `@inquirer/prompts` → `external-editor`), 35 high
(mostly the `@electron-forge/*` build chain), 6 moderate, 6 low. **Zero
runtime dependencies are affected.** All shipped code is clean.

**Recommendation.** Optional. `npm audit fix --force` would bump
`@electron-forge/cli` to a new major and may break the build pipeline. A
separated build environment is sufficient mitigation. Track for the next
forge-cli upgrade.

---

## 5. Defense-in-depth confirmed (no findings)

These were tested and **passed**. Listed so reviewers do not need to re-derive them.

### Electron hardening
- `contextIsolation: true` + `nodeIntegration: false` on every BrowserWindow
  and webview (`src/main/window/createWindow.ts:120-122, 174-178`).
- Raw `ipcRenderer` is **never** exposed to the renderer — only curated thunks
  via `contextBridge.exposeInMainWorld` (`src/preload/preload.ts:1140-1163`).
- `will-attach-webview` forces `sandbox: true`, `nodeIntegration: false`,
  `webSecurity: true` (`createWindow.ts:171-179`).
- `will-navigate` blocks everything except the dev-server URL (`createWindow.ts:186-189`).
- `setWindowOpenHandler` denies `window.open` and reroutes http(s) to the OS
  browser (`createWindow.ts:193-198`).
- Electron fuses: `EnableNodeOptionsEnvironmentVariable` and
  `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on. The two
  disabled fuses (`RunAsNode`, `EnableEmbeddedAsarIntegrityValidation`) are
  intentional and documented in `docs/SECURITY.md §1.4`.

### IPC handler discipline
- Every handler in `src/main/ipc/handlers/*` is wrapped via `wrapHandler`
  (`src/main/ipc/wrapHandler.ts`) which deep-redacts secret/command/env
  fields and classifies errors. A static test
  (`src/main/ipc/__tests__/wrapHandler.rollout.test.ts`) enforces 100% rollout.
- `pty:create` (`pty.handler.ts:345`): shell binary allow-list (12 basenames),
  `validateCwd()` (existence + UNC block), env denylist via `resolveSpawnEnv`.
- `pty:write` (`pty.handler.ts:658`): hard 10MB cap, ptyId must match a live
  PTY.
- `fs:writeFile` (`fs.handler.ts:138`): basename must equal `CLAUDE.md`, 100KB
  cap, sensitive-path blocklist, `realpath` symlink re-check.
- `fs:readDir` / `fs:readFile` (`fs.handler.ts:92, 125`): same guard + 1MB cap.
- `shell:openPath` (`shell.handler.ts:58`): executable-extension blocklist
  (`.exe/.bat/.cmd/.ps1/.js/.vbs/.msi/.lnk/.hta/...`), NUL byte rejected,
  `path.isAbsolute` enforced post-`normalize`, falls back to
  `showItemInFolder` on block/failure.
- `shell:openExternal` (`shell.handler.ts:38`): http/https prefix only.
- AI brain subprocess command is **hardcoded in main**
  (`deck.handler.ts:199`); renderer cannot name a different binary. The
  `model` field is regex-confined to `[A-Za-z0-9._-]{1,64}` before reaching
  the SDK subprocess command line (`deck.handler.ts:404`).

### SSRF defense
- `validateResolvedNavigationUrl` (`src/main/security/navigationPolicy.ts:118`)
  resolves hostname via `dns.lookup` and validates **every** returned address.
- Blocklist covers `0.0.0.0`, `10/8`, `172.16/12`, `192.168/16`,
  **`169.254/16` (cloud metadata)**, IPv6 private `fc00::/7`, link-local
  `fe80::/10`, IPv4-mapped IPv6 bypasses (`::ffff:169.254.169.254`,
  `::ffff:a9fe:a9fe`, `::169.254.169.254`).
- `localhost` and `127.0.0.1` / `::1` explicitly allowed.
- Test coverage in `src/main/security/__tests__/navigationPolicy.test.ts:68-85`
  explicitly asserts the metadata-IP bypass cases.
- Only two outbound `fetch()` calls exist in `src/`, both to
  `http://127.0.0.1:<cdpPort>/json` (CDP discovery). No `axios`, `node-fetch`,
  `http.get`, `https.get`, or `undici`.

### Token hygiene
- IPC tokens generated with `crypto.randomUUID()` (122 bits).
- Stored at `~/.wmux-auth-token` and `~/.wmux/daemon-auth-token`.
- POSIX: mode `0o600`. Windows: DACL rebuilt to owner-only Full Control by
  SID (not by `%USERNAME%`, which mangles on non-ASCII names — documented in
  `SECURITY.md §1.2` as RCA #124). Re-applied on **every load** via
  `reHardenTokenFileAcl` (RCA A12).
- Constant-time comparison (`crypto.timingSafeEqual`) at every gate
  (`DaemonPipeServer.ts:448`, `PipeServer.ts:316`, `SessionPipe.ts:550`,
  `broker.ts:58-65`).
- Pre-auth rate caps on every listener
  (`DaemonPipeServer.ts:65, 259`; `PipeServer.ts:21, 31`; `broker.ts:70`;
  `SessionPipe.ts:154` max 1 connection).

### MCP surface
- Broker uses Named Pipe / Unix socket, not TCP. No HTTP/SSE transport.
- Handshake-required within 10s, oversized-handshake guard (8KiB).
- `--commander` flag swaps the tool surface to a tight allow-list
  (`src/mcp/index.ts:394-414`).
- Commander-only tools (`deck_ask_decision`, `deck_resolve_decision`)
  fail-closed without `WMUX_COMMANDER_TOKEN`.
- `terminal_send` / `terminal_send_key` walk the PID map to resolve workspace
  identity; `senderPtyId` enables self-loop rejection. Spoofable env hints are
  reject-only fallbacks (`src/mcp/index.ts:920-934`, comments at `:927`).
- File tools sandboxed: `browser_file_upload` to `~/.wmux/uploads/`,
  `browser_pdf` / `browser_trace` to `~/.wmux/exports/`, both with
  `realpathSync` symlink-traversal defense.

### LLM / AI surface
- System prompts are hardcoded in main (`AcpBrainAdapter.ts:161`,
  `deck.handler.ts:199`). User input never enters system-prompt or tool-schema
  string interpolation — it lands in the user-message position only.
- Zero `dangerouslySetInnerHTML` / `v-html` / `innerHTML` sinks for AI output
  in production code. Every grep hit is either a test setup or a comment
  declaring the absence (`BrainMarkdown.tsx:9`, `ChannelView.tsx:140`,
  `RemoteInboxList.tsx:8`).
- No `eval` / `exec` / `new Function` of LLM output anywhere in `src/`.

### Network posture
- No webhooks, no inbound signature-verification gaps (because no webhooks).
- LanLink (`src/daemon/lanlink/server.ts`) is opt-in, NIC-pinned (never
  wildcard — `bindGuard.ts:87-99`), refuses Windows Public network category,
  uses PAKE → X25519 → scrypt → HMAC transcript → per-connection
  XChaCha20-Poly1305 AEAD. Hard rate caps and absolute 5s handshake deadline
  (slow-loris defense).
- PipeServer TCP fallback (Windows only) binds `127.0.0.1` only.
- Zero TLS-disabling patterns (`rejectUnauthorized: false`,
  `NODE_TLS_REJECT_UNAUTHORIZED`, `InsecureSkipVerify`, `verify: false`)
  anywhere in `src/`.

### Secrets & supply chain
- No hardcoded secrets in source. Every `sk-`/`AKIA`/`ghp_`/`sk_live_` hit is
  a scrubber-test fixture in `__tests__/` or `core/harness/__tests__/`.
- Git history clean — `git log -p --all -S` for each pattern returns only the
  same scrubber-test fixtures.
- No `.env*` files exist anywhere; `.gitignore:60-62, 99-100` excludes them.
- `install.ps1:224-256` downloads `Setup.exe` and verifies a pinned SHA-256
  against a side-car `update-manifest.json` (regex `^[A-Fa-f0-9]{64}$`),
  deletes the binary on mismatch, enforces TLS 1.2+.
- Auto-updater (`src/main/updater/verifyUpdate.ts`): URL allow-list
  (github.com HTTPS only), constant-time SHA-256 comparison via
  `timingSafeEqual`, fail-closed.
- `scripts/fix-node-pty.js` (the only `postinstall` hook) patches local `.gyp`
  text files only — no network, no shell exec.

### macOS-specific credentials
- Claude OAuth token read from Keychain via
  `security find-generic-password -s "Claude Code-credentials"`
  (`claudeCredential.ts:99-137`). Win/Linux inherit Anthropic's plaintext
  `.credentials.json` (see tracking items below).

---

## 6. STRIDE summary

| Component | S | T | R | I | D | E |
|-----------|---|---|---|---|---|---|
| Electron Renderer | OK | OK | OK | OK | — | — |
| Main IPC (`pty`/`fs`/`shell`) | OK | OK | OK | OK via F1 | — | OK |
| Named Pipe daemon | OK | OK | OK | OK | OK | OK |
| MCP broker (pipe) | OK | OK | OK | OK | OK | — |
| WebTerminalServer (opt-in `--expose`) | OK | OK | OK | OK | OK | OK |
| LanLink TCP (opt-in) | OK PAKE | OK AEAD | OK | OK | OK | — |
| AI brain subprocess | OK hardcoded spec | OK | — | OK | — | OK |
| **CDP port (always on)** | — | — | — | **F1** | — | OK loopback |

`OK` = defense present · `F1` = actionable finding · `—` = n/a or low

---

## 7. Data classification

| Class | Item | Storage | Protection |
|-------|------|---------|------------|
| RESTRICTED | wmux IPC auth tokens | `~/.wmux-auth-token`, `~/.wmux/daemon-auth-token` | mode 0600; Windows DACL rebuilt by SID + re-hardened on every load |
| RESTRICTED | Claude OAuth token (macOS) | Keychain | OS keychain |
| RESTRICTED | Claude OAuth token (Win/Linux) | `~/.claude/.credentials.json` | **Plaintext — inherited from Anthropic's storage decision** |
| CONFIDENTIAL | Scrollback / session JSON | `~/.wmux/` | mode 0600; OS-level pagefile encryption delegated |
| CONFIDENTIAL | LanLink peer DB | `~/.wmux/lanlink-peers.json` | HMAC integrity; X25519+AEAD keys |
| INTERNAL | Logs / IPC error messages | `%LOCALAPPDATA%` | `wrapHandler` deep-redaction of secret/command/env fields |

---

## 8. Tracking items (not findings)

These are deliberate trade-offs or known gaps documented in `SECURITY.md`. Listed
for completeness.

| Item | Current state | Completion criteria |
|------|---------------|---------------------|
| **F1 — CDP remote-debugging port on by default** | MEDIUM. Loopback only, no remote path, no priv esc beyond same-user, but lowers the same-user bar from "filesystem access" to "loopback socket access." Tracked in [#613](https://github.com/openwong2kim/wmux/issues/613). | Option B (default off / `--enable-cdp` opt-in, ~30min) or C (token proxy, ~4-6h). Option A (pipe transport) is withdrawn — see the correction in §2. Owner decision required: B makes browser automation opt-in. |
| Authenticode signing not yet enforced | Mitigated by SHA-256 side-car. SignPath wiring present in `release.yml:52-84`. | Acquire cert → activate SignPath step. Track via issue #200. |
| Asar integrity validation disabled | Intentional — `postPackage` repacks asar for `node-pty`, changing the hash (`SECURITY.md §1.4`). | Either extract `node-pty` to unpacked natives or split it out, then re-enable the fuse. Larger refactor. |
| Claude credential plaintext on Win/Linux | Inherited from Claude Code's own storage. macOS uses Keychain. | Add one line to `SECURITY.md` documenting the inheritance so users running wmux on Win/Linux are aware. wmux-side encryption would not protect what Claude Code already wrote plaintext. |
| Unpinned 1st-party CI actions | See F4. | Same fix as F4. |

---

## 9. Verification checklist (post-remediation)

- [ ] `npm run lint && npm run test:parallel` passes.
- [ ] F1 (option B): no `--remote-debugging-port` switch is appended unless the
      opt-in is present, and with the flag set Playwright still attaches
      (`src/mcp/playwright/PlaywrightEngine.ts:283`). The `browser.cdp.*` RPCs
      in `docs/api/reference.md:135-144` must keep returning a usable
      `cdpPort` whenever CDP is enabled.
- [ ] F2: Existing `worktree`/`diff` handler tests pass; add rejection cases
      for arbitrary paths (`~/.ssh/`, `/etc/`, etc.).
- [ ] F4: Open a PR with the SHA pinning change and observe that the CI
      workflows still run.
- [ ] F5: `release.yml` dry-run if available; at minimum, confirm no
      `${{ steps.*.outputs.* }}` remains in `run:` blocks.

---

## 10. Methodology notes

- **Confidence gate:** 8/10 (daily mode). Only findings at or above the gate
  are reported. Lower-confidence observations are listed in §8 as tracking
  items rather than findings.
- **Tools:** `cso` skill workflow (Phases 0-14), three parallel `explore`
  agents for surface mapping, `npm audit`, targeted greps per OWASP class,
  manual source reads of the most security-critical files.
- **Scope exclusions:** none. Every directory under the repo was considered;
  `node_modules/`, `out/`, `dist/`, `.vite/build/` were inspected as built
  artifacts (and found to match source) but are not independently tracked as
  findings.
- **Out of scope by design:** same-user attacks as defined in
  `docs/SECURITY.md §3`. F1 is reported because it materially widens that
  opening and the fix is cheap; the other same-user distance-closers (F2)
  are reported because they are consistency gaps, not because the same-user
  ceiling itself is a defect.
