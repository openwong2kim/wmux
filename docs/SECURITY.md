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

The wmux daemon exposes its RPC surface over a Windows Named Pipe (or Unix socket on POSIX). Every connection must present the per-user auth token from `%USERPROFILE%\.wmux-auth-token` (POSIX: `~/.wmux-auth-token`) — a random UUIDv4 (122 bits) persisted to disk and reused across boots, rotated only on explicit request. The token file is mode `0o600` and written via the `secureWriteTokenFile` helper; on Windows it grants the current user Full control and then strips inherited ACEs (`icacls /grant:r *<owner-SID>:F /inheritance:r`), so no other local account can read it. The owner is named by **SID**, not by `%USERNAME%` — a non-ASCII profile name (e.g. a Korean account) gets mangled by icacls into a ghost principal, which previously granted Full control to a non-existent account and locked the real owner out of their own token file. If the SID can't be resolved (e.g. `whoami` is unavailable) the helper falls back to the account name **only when it is pure ASCII**; for a non-ASCII or empty name it refuses to harden rather than risk re-introducing the mangle, failing safe (the write path deletes the token and errors; the re-harden path is a best-effort no-op that leaves the existing ACL untouched). The grant is also applied **before** stripping inheritance, so the owner keeps `WRITE_DAC` through the strip (granting after `/inheritance:r` can fail silently — see §1.1 note). The same ACL is re-applied on **every load** via `reHardenTokenFileAcl` (RCA A12 / v2.14.0), not just on first write. Clients without the token are rejected before any RPC is dispatched. See `PROTOCOL.md` §5 for the full token model.

### 1.3 Per-plugin permission enforcement (Phase 2.1, planned)

MCP plugins declare `wmuxPermissions` in their manifest. The substrate enforces those at four points (method · path · event · workspace claim) on every RPC and event delivery. A plugin without `pane.read` permission for a given pane never sees that pane's content via the substrate API.

Permission enforcement is a substrate guarantee for plugin access through documented surfaces. It is *not* a sandbox: a same-user plugin process can read disk files directly without going through the substrate. Plugin disk access is governed by §1.1.

> Status: Phase 2.1 implementation work item. The contract above is the Phase 0 declaration of intent; enforcement code ships across the v3.0 release window. See `plans/generic-wandering-teapot.md`.

### 1.4 Packaging fuse posture

The shipped Electron build sets these fuses (`forge.config.ts`), recorded here so the disabled ones are on the record and not mistaken for oversights:

- `EnableCookieEncryption`: **on**.
- `EnableNodeOptionsEnvironmentVariable` / `EnableNodeCliInspectArguments`: **off**.
- `OnlyLoadAppFromAsar`: **on** — the app only loads from the packaged asar.
- `EnableEmbeddedAsarIntegrityValidation`: **off** — *intentional*. The `postPackage` hook repacks `app.asar` to bundle `node-pty`, which changes the asar hash; enabling this fuse would FATAL at runtime. `OnlyLoadAppFromAsar` still constrains load origin.
- `RunAsNode`: **on** — *required*. The background daemon is spawned as a detached Node process from `wmux.exe` via `ELECTRON_RUN_AS_NODE=1`. Acceptable for a terminal multiplexer that already executes arbitrary shell commands.

The in-app updater downloads the `Setup.exe` itself and verifies a pinned SHA-256 (published in `update-manifest.json` by CI) before launching it — fail-closed, so a tampered or unverifiable artifact is never run. Authenticode code signing of the installer + update artifacts is **not yet in place** (pending a code-signing certificate); until it lands, direct downloads still trip the SmartScreen "unknown publisher" prompt and the updater's trust floor is the SHA-256 pin, not a signature. See the release pipeline (`.github/workflows/release.yml`).

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
- **Pagefile / swap leak of PTY bytes.** Scrollback lives in process memory and is subject to normal OS paging. Use OS-level pagefile encryption if this matters.
- **Crash dumps.** A daemon or renderer crash may produce a dump containing scrollback bytes. Disable crash dumps at the OS level if this matters.
- **GPU / framebuffer memory inspection.** Rendered terminal text passes through the GPU; same-user GPU memory access can recover it.
- **Side-channel timing attacks** against PTY input or rendering.
- **Cloud sync engines mirroring `~/.wmux/`.** If a user has redirected their profile root to OneDrive Known Folder Move or set up Windows Backup over the profile, scrollback gets mirrored. The user must add an exclusion in their backup tool — wmux does not.
- **Compromised plugins running as the same user.** Permission enforcement (§1.3) defends documented substrate access only. A compromised plugin process can do anything its user account can do.
- **Network-level attacks on PTY data carried over shells the user opens.** wmux is the multiplexer; SSH / VPN / TLS are the user's responsibility.

---

## 4. For high-sensitivity workflows

If a session is sensitive enough that the above out-of-scope items matter, the correct posture is OS-level isolation:

- **Short-lived secret handling** (env dumps, key prints, AWS CLI output): run the shell inside a transient Windows Sandbox or Hyper-V VM. Close the sandbox when done. wmux outside the sandbox never sees the bytes.
- **Compliance-regulated workflows** (PCI, HIPAA, classified): run wmux inside a regulated VM with the appropriate disk encryption, swap encryption, and crash-dump policy. The substrate's `~/.wmux/` lives inside the VM and inherits the VM's protections.
- **Multi-tenant developer machines** where the user account itself is not trusted: do not use wmux. The substrate explicitly does not protect against same-user adversaries.

There is no per-session "secure mode" toggle in wmux. The substrate is neutral: every session gets the same persistence and recovery guarantees described in `PROTOCOL.md`, and confidentiality is achieved by OS-level isolation, not by per-session opt-outs.

---

## 5. Reporting security issues

Security issues should be reported privately. Use GitHub's "Report a vulnerability" workflow on the wmux repository, or email the maintainer directly (see repository README). Please do not file public issues for security-relevant findings until a fix is available.

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
