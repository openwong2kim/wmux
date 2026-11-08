# wmux Substrate — Security Model

> **Status:** Draft 1 (Phase 0 baseline). Companion to the [substrate protocol](./PROTOCOL.md) and the v3.0 [stability contract](./api/stability.md).
> **Audience:** plugin authors, integrators, security reviewers, and anyone trying to decide whether wmux fits a given threat model.

This document states the wmux substrate's security posture. It is deliberately narrow about what wmux protects against and explicit about what it does not. The substrate's identity is a small neutral core plus a plugin layer (§4 of `PROTOCOL.md`); the security model follows the same shape — small core guarantees, hard delegations to the OS, and a clear list of out-of-scope threats.

---

## 0. The substrate's security stance

wmux is a **terminal substrate, not a secure data vault**. Its job is to own panes, terminal I/O, and the event bus, and to expose a stable surface to external tools. It is not designed to be a confidentiality boundary against same-user adversaries on the same machine.

If a workflow demands strong at-rest confidentiality (compliance-grade key material, regulated PII, classified data), the correct primitive is OS-level isolation — Windows Sandbox, a Hyper-V or VirtualBox VM, a container — and wmux running inside it. wmux does not replace those primitives.

This is the same trade-off as `tmux` and most terminal multiplexers: persistence and recoverability are surface-level features, and confidentiality is delegated to the operating system.

---

## 1. What wmux guarantees

The following are first-class commitments. Regressions here are bugs.

### 1.1 At-rest file mode

- POSIX (`macOS`, `Linux`): `~/.wmux/` and every file inside it are created with mode `0o600` (owner read/write only). Directories are `0o700`.
- Windows: `%USERPROFILE%\.wmux\` inherits the default user profile ACL. The substrate relies on the OS user profile boundary as the trust line — same-user processes can read substrate files; other users on the same machine cannot.

> **Note (2026-05-16):** an earlier draft of this document described additional Windows-side `icacls` hardening and cloud-sync exclusion signals applied by the daemon on startup. That code path produced a broken ACL state in user-dogfood testing (lock-out of the owner) and was reverted. Any future hardening over what `0o600` / the default user profile ACL provides will be re-introduced only after dogfood passes on a real `%USERPROFILE%\.wmux\` directory, not just a fresh-tmpdir dynamic test.

### 1.2 Named Pipe authentication

The wmux daemon exposes its RPC surface over a Windows Named Pipe (or Unix socket on POSIX). Every connection must present the per-user auth token from `%USERPROFILE%\.wmux-auth-token` (POSIX: `~/.wmux-auth-token`) — a random UUIDv4 (122 bits) persisted to disk and reused across boots, rotated only on explicit request. That is the **default** path: the resolver (`getAuthTokenPath()`) is suffix-aware, so an instance launched with `WMUX_DATA_SUFFIX` (dev builds, dogfood instances) uses `~/.wmux<suffix>-auth-token` instead — reading the unsuffixed path there yields the wrong token and authentication fails. The token file is mode `0o600` and written via the `secureWriteTokenFile` helper; on Windows the DACL is **rebuilt** so the only surviving entry is Full control for the current user — inheritance is disabled and discarded, and every pre-existing ACE (inherited **or** explicit) is removed, so no other local account can read it. The owner is named by **SID**, not by `%USERNAME%` — a non-ASCII profile name (e.g. a Korean account) gets mangled by native ACL tooling into a ghost principal, which previously granted Full control to a non-existent account and locked the real owner out of their own token file. If the SID can't be resolved (e.g. `whoami` is unavailable) the helper falls back to the account name **only when it is pure ASCII**; for a non-ASCII or empty name it refuses to harden rather than risk re-introducing the mangle, failing safe (the write path aborts without ever installing the new token, and removes the previous one unless its DACL reads back owner-only; the re-harden path reports failure and leaves the existing ACL untouched).

The rebuild works by **writing the content through a fresh inode** rather than editing the live file's ACL: a file that did not exist before we created it carries only inherited ACEs, so `/inheritance:r` on it is sufficient and the pre-existing-explicit-ACE case (issue #124) becomes unreachable by construction. The staged copy is created inside a per-operation staging **directory** that is locked down (`icacls /grant:r <owner>:(OI)(CI)F /inheritance:r`) while still empty, so the secret is owner-only from the instant its inode exists — never briefly readable on an inode another process could have opened a surviving handle to. The staged copy is then renamed over the target. Note the primitives that do **not** work here: a plain in-place `icacls /grant:r *<sid>:F /inheritance:r` leaves a pre-existing explicit broad ACE (e.g. `Everyone:(R)`) in place — the file stays world-readable; `Set-Acl` re-stamps the owner/group section and throws `SeSecurityPrivilege` on the upgrade-from-icacls state; and `icacls /restore` with a DACL-only SDDL fails with *"Not all privileges or groups referenced are assigned to the caller"*, processing 0 files.

The rebuild **no longer shells out to PowerShell** (changed 2026-08-11). The previous implementation ran a .NET `FileInfo.SetAccessControl` rebuild via `powershell.exe -ExecutionPolicy Bypass -EncodedCommand`. Under Constrained Language Mode — the AppLocker/WDAC default on managed fleets — that script cannot run at all (`MethodInvocationNotSupportedInConstrainedLanguage`), and every such attempt silently degraded to the plain `icacls` strip, which removes only the four well-known broad SIDs and leaves any other explicit ACE in place: those machines ran with weaker token ACLs than this section promised. Norton Behavioral Protection also flags that argument shape as `IDP.HELU.PSE85` and blocks `powershell.exe` (GHSA-8fj2-47w9-jxq3). No wmux ACL path spawns `powershell.exe` today.

When the target is held open by another process (an AV or backup tool scanning it — `FILE_SHARE_NONE` blocks both the read and the rename), the helper retries the swap with backoff and then repairs the DACL **in place** and reads it back: reading a security descriptor is not subject to file share modes and an ACL edit needs only `WRITE_DAC`, so both still work on a locked file. Verified owner-only ⇒ success; anything else ⇒ failure, and the fail-closed callers discard the secret. The verification is a real read-back (`icacls /save`, parsed as SDDL) — a swap failure never *assumes* the untouched original is safe, because on an upgrade boot the pre-existing ACL is exactly the weak one.

The same hardening is re-applied on **every load** via `reHardenTokenFileAcl` (RCA A12 / v2.14.0), not just on first write; because it rewrites through a fresh inode, the file's inode identity changes even though its bytes do not (readers see the old or the new inode atomically; a future `fs.watch` on a token file would observe a rename). Clients without the token are rejected before any RPC is dispatched. See `PROTOCOL.md` §5 for the full token model.

### 1.3 Per-plugin permission enforcement (Phase 2.1, planned)

MCP plugins declare `wmuxPermissions` in their manifest. The substrate enforces those at four points (method · path · event · workspace claim) on every RPC and event delivery. A plugin without `pane.read` permission for a given pane never sees that pane's content via the substrate API.

Permission enforcement is a substrate guarantee for plugin access through documented surfaces. It is *not* a sandbox: a same-user plugin process can read disk files directly without going through the substrate. Plugin disk access is governed by §1.1.

> Status: Phase 2.1 implementation work item. The contract above is the Phase 0 declaration of intent; enforcement code ships across the v3.0 release window. See `plans/generic-wandering-teapot.md`.

### 1.3.1 Browser calls act on the caller's verified workspace

**Guarantee.** No wmux tool, MCP tool argument, or CLI flag lets an agent
choose or name the workspace or pane a browser call acts on. Every `browser.*`
RPC takes its workspace (and, where there is one, its pane) from an identity
main recorded for the caller:

- a validated commander token (the workspace orchestrator);
- the plugin host's binding (an iframe plugin);
- a workspace claim token, which main mints:
  - from `mcp.claimWorkspace`, for a caller outside every pane (a dedicated
    workspace);
  - from main's own walk of the caller's process tree up to a live pane, for
    an agent in a pane (a pane claim, bound to the workspace and the pane);
  - from the owner record of a shared Codex app-server thread, for a caller
    main has seen running under that server. Windows has no owner record, and
    there the wmux MCP server refuses browser tools under a shared server
    rather than use the walk, which names the pane that started the server;
  - for a WSL pane whose agent the daemon follows inside the distro, when the
    walk does not reach the pane.

A `workspaceId` in the request only narrows that identity: a different one,
or a call with no recorded identity, is refused in both `mcp.mode`s. A pane
claim goes stale when the pane moves or closes. The envelope's `callerPtyId`
picks a pane only for the in-process operator and plugin-host lanes. The
renderer operator (the person at the window, and the phone browser that acts
through it) is the one caller that may act across workspaces.

The inputs the MCP server and the CLI send for this — their own process id,
the calling Codex thread, the pane named in their environment — are routing
inputs. They come from the calling process itself, never from tool arguments
or flags, and main checks each against what it can observe itself (the live
process table, live panes, the thread owner index, the daemon's agent
tracking) before it mints a claim.

**Out of scope.** Code running as the same OS user that speaks the pipe
protocol directly. Such code can already read the pipe token, other
processes, and browser profiles (§3), so it is not confined by this boundary.
Like §1.3, this is a guarantee for callers that use the documented surfaces —
agents and the tools they are given — not a defence against same-user code.

### 1.3.2 Protected Chrome panes

**Guarantee.** A pane bound to its own Chrome profile can be protected. Its
agent's browser calls then reach only the hosts on that pane's allowed list,
and the pane's Chrome itself runs behind a main-owned filtering proxy.
A page script (`browser_evaluate`), a download, and reading or changing a
sensitive site's sign-in data each run only with the operator's consent, asked
when the agent tries it: Allow once, Always on this pane (revocable in the
pane's protection editor, cleared when the pane is rebound or moved), or Deny.
An unanswered question is denied after a minute, a scheduled run nobody is
watching is refused at once, and an approved download is the only one let
through, from the tab it was approved for. The agent's own `allowDangerous`
and `allowSensitiveDomains` flags unlock nothing here. The wmux tools that
run caller-supplied code, `browser_repl` and `repl_run`, are refused on a
protected pane, and also wherever wmux cannot confirm that the calling pane is
unprotected. Desktop computer use (the `computer` tool) is refused from a
protected pane, and from any caller wmux cannot identify while a pane is
protected. A missing or unreadable policy keeps every previously protected
pane blocked until the operator confirms it again. The policy is set only from
the main window; no tool argument or CLI flag can change it.

**Out of scope.** As in §1.3.1, this confines the documented surfaces: the
wmux browser tools, MCP and CLI an agent is given. It does not confine code
that runs as the same OS user outside those surfaces, including a shell an
agent runs in a pane. Such code can reach a Chrome profile's files and its
debugging endpoint directly (§3). Use a protected pane to keep an agent's
browser tools on the sites you chose, not as a sandbox for an agent with a
shell. Protection also does not confine what other panes do: a tool that acts
through another pane (`terminal_send`, `send_message`, `a2a_*`, `fanout_start`)
runs under that pane's own scope, not this one's, and an unprotected pane's
agent with computer use can operate a protected pane's Chrome window like any
other desktop app.

### 1.4 Packaging fuse posture

The shipped Electron build sets these fuses (`forge.config.ts`), recorded here so the disabled ones are on the record and not mistaken for oversights:

- `EnableCookieEncryption`: **on**.
- `EnableNodeOptionsEnvironmentVariable` / `EnableNodeCliInspectArguments`: **off**.
- `OnlyLoadAppFromAsar`: **on** — the app only loads from the packaged asar.
- `EnableEmbeddedAsarIntegrityValidation`: **off** — *intentional*. The `postPackage` hook repacks `app.asar` to bundle `node-pty`, which changes the asar hash; enabling this fuse would FATAL at runtime. `OnlyLoadAppFromAsar` still constrains load origin.
- `RunAsNode`: **on** — *required*. The background daemon is spawned as a detached Node process from `wmux.exe` via `ELECTRON_RUN_AS_NODE=1`. Acceptable for a terminal multiplexer that already executes arbitrary shell commands.

The in-app updater downloads the `Setup.exe` itself and verifies a pinned SHA-256 (published in `update-manifest.json` by CI) before launching it — fail-closed, so a tampered or unverifiable artifact is never run. Authenticode code signing of the installer + update artifacts is **not yet in place** (pending a code-signing certificate); until it lands, direct downloads still trip the SmartScreen "unknown publisher" prompt — and on Windows 11 devices with Smart App Control enforcing, the unsigned installer may be blocked outright with no override (see [#200](https://github.com/openwong2kim/wmux/issues/200); winget/Chocolatey or build-from-source are the workarounds) — and the updater's trust floor is the SHA-256 pin, not a signature. See the release pipeline (`.github/workflows/release.yml`).

### 1.5 Browser/PWA terminal server

`wmux web` is loopback-only and read-only by default. Network binding
(`--expose` or `--host`), terminal input, and photo upload are separate explicit
operator grants. Anyone who reaches the listener and holds a valid web or device
credential can read the full scrollback of every live pane; input and upload
remain disabled unless separately enabled.

Remote confidentiality has two supported paths: `wmux web --tailscale` puts an
HTTPS Tailscale front in front of a loopback HTTP listener, while
`--tls-cert`/`--tls-key` makes the daemon terminate HTTPS directly. A bare
non-loopback bind is still available for trusted networks, but it is plaintext
and the CLI says so explicitly. Durable native-TLS state stores only absolute
certificate/key paths, never PEM bytes; if either path becomes invalid, restart
fails closed with no plaintext listener. PEM files are read when the listener
starts, not hot-reloaded, so certificate renewal requires re-running `wmux web`
with both TLS paths or restarting the listener/daemon. A re-run keeps every
option it is not given (bind, `--tailscale`, allowed hosts, TLS, and each
`--allow-*` grant), and it prints a warning when an explicit flag narrows the
exposure scope; turning something off takes `--no-allow-<x>`, `--loopback`,
`--no-tls` or `--stop`. Reconfiguring across the
encrypted/plaintext boundary rotates the operator token and revokes every
paired-device credential; same-transport reconfiguration preserves them. An
explicit `wmux web --stop` also revokes both credential classes. Rotation is
acknowledged only after the device roster and new web state are durable;
otherwise the new listener is stopped and the operation fails.

Phone git writes (push, PR create, squash merge) are a further host ceiling,
`--allow-git-write`, off by default, and they also need a device input grant
that was set explicitly: a device record that predates grants is allowed to
type but not to write to GitHub. Push and merge need a fresh preview and a
single-use confirm token bound to that device, session, repository, action,
GitHub login and the values shown; every execute is keyed by a request id
whose receipt is kept on disk, so a resent request returns the stored outcome
instead of running again. These guard against mis-taps, replays, stale
screens and mistakes. They do **not** guard against a stolen, unlocked,
paired device: `--allow-input` already lets such a device type arbitrary
input into a shell, including `git push`. Revoking the device is the answer
to theft.

---

## 2. What wmux delegates to the operating system

| Concern | OS primitive |
|---|---|
| At-rest disk encryption | BitLocker (Windows), FileVault (macOS), LUKS / dm-crypt (Linux) |
| Process-to-process isolation | OS user accounts, ACLs, process tokens |
| Memory protection | OS memory manager (no `mlock`, no pinning) |
| Pagefile / swap leak | OS-level pagefile encryption (BitLocker on Windows, encrypted swap on macOS/Linux) |
| Crash-dump scrubbing | OS crash-dump policy (Windows Error Reporting opt-out, etc.) |
| Network confidentiality (PTY over remote shells) | The user's SSH / VPN / TLS stack |
| Folder-level access restriction | The OS user profile ACL (Windows) / `0o700` mode (POSIX) |
| Cloud-sync / backup exclusion | The user's sync / backup tool's own ignore configuration |

If your threat model requires any of these, configure the OS layer. wmux does not duplicate them.

---

## 3. What wmux does NOT try to protect against

Stated explicitly so reviewers and operators don't infer guarantees that don't exist.

- **Same-user malware or unauthorized processes.** A process running as the same user can read `~/.wmux/` directly, attach a debugger to the daemon, or inspect process memory. No application-level mitigation defeats this.
- **CDP remote-debugging port (same-user, lower bar).** Browser automation runs over Electron's CDP port on loopback. Unlike the other same-user vectors above, reaching it needs only a loopback socket — no filesystem or process access. A same-user process that reaches CDP can drive every privileged IPC handler the preload exposes. The port is on by default (browser automation depends on it) but can be closed: set `browser.cdp.enabled = false` in `~/.wmux/config.json`, or export `WMUX_DISABLE_CDP=true`. Closing it disables browser automation with an explicit error. This is the single largest distance-closer within the same-user ceiling.
- **The pipe relay for a dedicated Chrome (opt-in, `WMUX_CHROME_TRANSPORT=pipe`).** A dedicated Chrome on a debugging pipe has no port. Clients reach it through one wmux relay, each connection with a one-time token that `browser.cdp.info` hands out over the authenticated wmux pipe. The relay listens on a Unix socket in a private temp directory, or on Windows on a named pipe whose DACL admits only the current user and SYSTEM. It falls back to loopback TCP, logging one line that names no endpoint, when no usable private temp directory exists, or on Windows when that DACL cannot be set on a fresh pipe (three names are tried) or wmux runs as another user than the signed-in session. Either way the token is required. On Windows the DACL keeps other local accounts out once it is set, which wmux does in the same tick the pipe is created. Until then the pipe has the default DACL, so another account that opens it in that moment, or holds every waiting instance, keeps a connection until the header timeout, or makes wmux try fresh names and then fall back to loopback TCP; the token is still required there. Each grant also carries a proof key, handed out only with the token over the authenticated wmux pipe and never sent on the relay connection. Once connected, the MCP engine asks for an HMAC of a fresh nonce under that key, and the relay answers it from the key of the token that connection spent; the engine drops a connection that does not answer correctly within five seconds, without retrying, so a process that serves the relay's socket, pipe or port after the relay stops listening there is not used. The relay drops a listener's unused tokens and keys before it lets the name or port go. Before the proof, such a process sees the token the client spent and Playwright's attach commands (including its download temp path), and can send the client crafted events; nothing uses the browser until the proof passes. The DACL does not refuse an SMB client that signs in as the same user, and wmux provides no remote-SMB refusal. The daemon's own RPC pipe keeps the default pipe DACL, under which every account can open it for reading, so another local account can still hold that pipe's pending connections until they time out. This narrows who can connect from any local process to holders of the pipe auth token, and no further: a same-user process can still read `~/.wmux-auth-token`, ask `browser.cdp.info` for a token, and connect. Every client of one Chrome sees all of that Chrome's targets, as on a port, whichever workspace it connected for; nothing narrows that per client yet. An opt-in mode, `WMUX_CDP_TARGET_GRANT=1`, narrows it: each client sees and addresses only the pages wmux opened for its workspace, the pages it created, and the pages those opened, and no client sees tabs, service or shared workers, extension pages or browser UI. In that mode a client cannot use Fetch or Tracing on the browser itself, address a window that holds none of its pages, clear the shared default browser context's cookies, cache or site data, or change its download behaviour or permissions, and the browser tools' downloads do not work yet. It narrows targets, not the profile: pages on one profile still share its cookies (a page can read and set those of its own sites), site storage, permissions and downloads. With `DEBUG=pw:channel` (or `pw:*`) in the MCP server's environment, Playwright's debug log prints the token's header.
- **Pagefile / swap leak of PTY bytes.** Scrollback lives in process memory and is subject to normal OS paging. Use OS-level pagefile encryption if this matters.
- **Crash dumps.** A daemon or renderer crash may produce a dump containing scrollback bytes. Disable crash dumps at the OS level if this matters.
- **GPU / framebuffer memory inspection.** Rendered terminal text passes through the GPU; same-user GPU memory access can recover it.
- **Side-channel timing attacks** against PTY input or rendering.
- **Cloud sync engines mirroring `~/.wmux/`.** If a user has redirected their profile root to OneDrive Known Folder Move or set up Windows Backup over the profile, scrollback gets mirrored. The user must add an exclusion in their backup tool — wmux does not.
- **Compromised plugins running as the same user.** Permission enforcement (§1.3) defends documented substrate access only. A compromised plugin process can do anything its user account can do.
- **Network-level attacks on PTY data carried over shells the user opens.** wmux is the multiplexer; SSH / VPN / TLS are the user's responsibility.
- **PowerShell execution policy as a boundary.** Microsoft states that execution policy "isn't a security boundary", and wmux does not treat it as one. On a Windows client where **no** scope has ever set a policy (effective `Restricted`, the state of every fresh install), wmux spawns its Windows PowerShell 5.1 panes and 5.1 exec units with a process-scoped `-ExecutionPolicy RemoteSigned`; otherwise its own shell-integration script and npm agent shims such as `codex.ps1` cannot load (#1620). Inside those panes, local unsigned scripts therefore run. The decision reads only the persisted scopes (Group Policy, CurrentUser, LocalMachine): any explicit policy, and anything set by Group Policy, is left exactly as configured, and pwsh 7 panes are never touched because pwsh 7 ships `RemoteSigned`. wmux never passes `Bypass` to a pane (see §1.2 and GHSA-8fj2-47w9-jxq3).

---

## 4. For high-sensitivity workflows

If a session is sensitive enough that the above out-of-scope items matter, the correct posture is OS-level isolation:

- **Short-lived secret handling** (env dumps, key prints, AWS CLI output): run the shell inside a transient Windows Sandbox or Hyper-V VM. Close the sandbox when done. wmux outside the sandbox never sees the bytes.
- **Compliance-regulated workflows** (PCI, HIPAA, classified): run wmux inside a regulated VM with the appropriate disk encryption, swap encryption, and crash-dump policy. The substrate's `~/.wmux/` lives inside the VM and inherits the VM's protections.
- **Multi-tenant developer machines** where the user account itself is not trusted: do not use wmux. The substrate explicitly does not protect against same-user adversaries.

There is no per-session "secure mode" toggle in wmux. The substrate is neutral: every session gets the same persistence and recovery guarantees described in `PROTOCOL.md`, and confidentiality is achieved by OS-level isolation, not by per-session opt-outs.

---

## 5. Reporting security issues

Security issues should be reported privately. Use GitHub's "Report a vulnerability" workflow on the wmux repository, or email the maintainer at [open.wong2kim@gmail.com](mailto:open.wong2kim@gmail.com) (see [CONTRIBUTING.md](../CONTRIBUTING.md#reporting-security-issues)). Please do not file public issues for security-relevant findings until a fix is available.

What we consider a security issue:

- A defect that violates a §1 guarantee (e.g., a code path that writes a substrate file with broader ACL than stated).
- A documented substrate surface that returns data to a plugin without honoring `wmuxPermissions`.
- A token-handling defect in the Named Pipe / socket layer.
- Substrate-side parsing or deserialization defects exploitable from the plugin side.

What we do not consider a wmux security issue:

- Same-user disclosure paths covered by §3.
- Cloud-sync engines mirroring `~/.wmux/` (configure the sync tool, see §2 and §3).
- PTY content disclosure through tools the user runs *inside* a pane (that's the inner program's surface, not wmux's).

---

## 6. Change log

| Date | Change |
|---|---|
| 2026-05-16 | Initial draft (#41). Declared icacls + attrib + notice-file hardening signals + `mcp.claimWorkspace` enforcement. |
| 2026-05-16 | Reverted icacls/attrib/notice-file claims (§1.2 and §1.3 of the original draft). Dogfood on a real `%USERPROFILE%\.wmux\` directory produced a broken ACL state (`/inheritance:r` removed the owner's WRITE_DAC, and the subsequent `/grant:r` failed silently). The dynamic test (`scripts/substrate-hardening-dynamic.mjs`) had passed on a fresh `mkdtempSync` directory whose ACL constitution is different from a long-lived profile-scoped folder; the test did not catch the production-only regression. Phase 3.2 hardening will be re-attempted only after a hardening helper that (a) grants the owner explicit `(OI)(CI)F` *before* removing inherited ACEs and (b) is dogfooded against a real user profile passes. |
| 2026-07-30 | Documented the CDP same-user vector (§3) and added a config/env opt-out (`browser.cdp.enabled` / `WMUX_DISABLE_CDP`). CDP stays on by default for browser automation but is now closeable (#613). |
| 2026-08-02 | Documented the Browser/PWA trust boundary and native TLS fail-closed behavior (#764). |
| 2026-08-11 | §1.2 rewritten for the PowerShell-free token ACL rebuild. The `powershell.exe -ExecutionPolicy Bypass -EncodedCommand` .NET rebuild was removed: under Constrained Language Mode (AppLocker/WDAC, standard on managed fleets) it could not run at all and every attempt degraded silently to the weaker `icacls` strip — measured 22/22 failures on a real corporate machine, meaning that installed base ran with looser token ACLs than this section stated. Norton also flagged the argument shape as `IDP.HELU.PSE85` (GHSA-8fj2-47w9-jxq3). Replaced by a fresh-inode rewrite staged inside a pre-hardened staging directory, with an in-place repair plus `icacls /save` read-back verification when the target is locked. |
| 2026-09-28 | §3: documented the process-scoped `-ExecutionPolicy RemoteSigned` that Windows PowerShell 5.1 panes and exec units now get on a factory-default Windows client, and only there (#1620). `RemoteSigned`, not `Bypass`, because the `Bypass` argument shape is what Norton flagged (GHSA-8fj2-47w9-jxq3); explicit policies and Group Policy are never overridden. |
| 2026-10-09 | §1.5: documented the `--allow-git-write` ceiling for phone push, PR create and merge, and what it does and does not guard against. |
| 2026-10-11 | §1.3.2: documented protected Chrome panes and their scope: they confine the agent's browser tools, not same-user code such as a pane's shell. |
| 2026-10-11 | §1.3.2: `browser_repl` and `repl_run` are refused on a protected pane (and when protection cannot be confirmed); stated that a protected pane does not confine other panes. |
| 2026-10-11 | §1.3.2: computer use is refused from a protected pane and from an unidentified caller while a pane is protected; an unprotected pane's computer use is not confined. |
| 2026-10-11 | §1.3.2: page scripts, downloads and sensitive-site sign-in data on a protected pane ask the operator once instead of being refused (#2046). |
| 2026-11-07 | §3: documented the relay that reaches a dedicated Chrome on the debugging pipe (opt-in): one-time tokens over the authenticated pipe, what a same-user process can still do, that one Chrome's targets are visible to all its clients, and Playwright's debug log. |
| 2026-11-08 | §3: on Windows the pipe relay listens on a named pipe closed to every account but the user's and SYSTEM, with loopback TCP only when that cannot be arranged; no remote-SMB refusal; the daemon's RPC pipe keeps the default pipe DACL. |
| 2026-11-08 | §3: the pipe relay proves itself to the MCP engine with a per-grant key before the connection is used, and drops a listener's unused tokens and keys before it lets the name or port go; what a process serving the endpoint sees before the proof. |
| 2026-11-08 | §3: an opt-in mode (WMUX_CDP_TARGET_GRANT=1) narrows each relay client to its own pages, refuses browser-wide Fetch and Tracing, and keeps the shared default context's downloads, permissions and storage out of its reach. |
