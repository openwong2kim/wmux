# First-Party MCP Trust — production fix for the enforce-mode lockout

Status: IMPLEMENTED (revised per codex adversarial review — see §0)
Branch base: main (fix to be cut as its own branch)
Author: investigate session 2026-06-06
Severity: HIGH — every packaged release since v2.12.0 silently locks the bundled
MCP server out of all capability-bearing RPCs.

---

## 0. IMPLEMENTED design (supersedes §5 A+C)

Eng review + codex adversarial review killed the original A+C (token) plan. The
decisive findings (all verified against code):

- **C is an incomplete safety net.** The bundled server calls `surface.list`
  and `company.a2a.*`, which map to `wmux.internal` in methodCapabilityMap.
  `permissionGrammar` forbids `wmux.*` in any declaration, so declare/approve
  (and pre-seed) can NEVER unblock those tools. Approach C alone leaves them
  broken.
- **`ctx.firstParty => allow` over-grants.** A blanket per-request bypass would
  open `daemon.*`, `workspace.new`, `company.*`, `hooks.signal` on any token
  leak — broader than pre-trusting the name.
- **Token-in-args buys ~nothing.** `~/.claude.json` is plain-written (no ACL);
  a same-user process that can read it can already read the daemon auth token
  and call the pipe directly. Second bearer secret, worse location.

**Implemented instead: name-recognized, scoped method allowlist in the enforcer.**

- `src/main/mcp/firstParty.ts` (new): `FIRST_PARTY_CLIENT_NAMES = {'claude-code'}`
  and `FIRST_PARTY_METHODS` = the exact RPC set the bundled server calls
  (browser.* incl. CDP fallbacks, pane.*, meta.setSkills, input.*,
  terminal.readEvents, events.poll, a2a.*, the `wmux.internal` company.a2a.* +
  surface.list, workspace.list, mcp.*). `isFirstPartyClient()`.
- `src/main/mcp/PermissionEnforcer.ts`: after the legacy/`!clientName` branch and
  before the unconfirmed reject — `if (isFirstPartyClient(ctx.clientName) &&
  trust?.status !== 'denied' && FIRST_PARTY_METHODS.has(method)) return allow`.
  Denied still wins (escape hatch); non-allowlisted methods fall through to
  normal enforcement (no silent widening).
- **No wire-format change, no secret, no args injection, no McpRegistrar/
  PipeServer/bundled-server change.** The bundled server already stamps
  `clientName='claude-code'` (shipped in #71), so the enforcer change alone
  fixes the lockout. ~2 files + 3 test files.

Security posture (documented, matches the spec's "declared, not verified"
stance): recognition is by self-asserted clientName. On a single-user OS this
is no weaker than any local secret. What the *scoped* allowlist buys over a
blanket bypass: even a clientName impersonator only reaches the curated method
set — never daemon/ workspace-mutation/ company-mutation/ reserved surface.

### Verification (dynamic, 2026-06-06)
- `tsc -p tsconfig.json` clean. `build:daemon` + `build:mcp` clean (no bundle drift).
- New tests 18/18: `firstParty.test.ts` (source-invariant — parses src/mcp/** so
  the allowlist can't drift from the tools), `PermissionEnforcer.firstParty.test.ts`,
  `RpcRouter.firstParty.enforce.test.ts` (real RpcRouter + real PluginTrustStore
  dispatched in **enforce mode** — reproduces the exact live failure: claude-code
  `unconfirmed` → browser.open/surface.list/company.a2a.whoami now pass; external
  plugin + reserved methods still rejected; denied honored).
- Full parallel lane: **2236/2236 pass**, zero regressions.
- Remaining last-mile: relaunch the packaged app with this fix and call
  `browser_open` from inside wmux (the enforcer runs in the Electron main
  process, which the user must rebuild+restart — can't self-restart from inside).

---

## 1. Symptom

In a packaged build, every wmux MCP tool fails with:

```
browser.open: plugin is unconfirmed; call mcp.identify + mcp.declarePermissions first
```

`a2a.whoami`, `pane.*`, `browser.*`, everything capability-bearing — all rejected.
Host Claude Code restart does not help.

## 2. Root cause (confirmed, code + live evidence)

v2.12.0 (#71, commit `7b4d201`) shipped two things together:

1. Production default `enforcementMode = 'enforce'`
   (`src/main/mcp/enforcementMode.ts:33` → `isDev ? 'shadow' : 'enforce'`;
   `src/main/index.ts:465` → `!app.isPackaged` ⇒ not dev ⇒ enforce).
2. The bundled MCP server began stamping `clientName = 'claude-code'` on every
   RPC envelope (`src/mcp/index.ts:704` `setClientIdentity`, `src/mcp/wmux-client.ts:70`).

But the bundled server only ever calls `mcp.identify` (`src/mcp/index.ts:707`).
It **never calls `mcp.declarePermissions`**, and there is **no first-party
auto-trust path** anywhere.

Consequence chain in enforce mode:
- `mcp.identify` → `PluginTrustStore.upsertContact` → record with
  `status:'unconfirmed'`, `declaredCapabilities: []`.
- `browser.open` (cap `browser.navigate`) → `PermissionEnforcer.check`
  (`src/main/mcp/PermissionEnforcer.ts:198`) → reject `identity-status / unconfirmed`.
- The approval-dialog branch (`src/main/pipe/RpcRouter.ts:277-282`) requires
  `trust.declaredCapabilities.length > 0` — it is empty, so **no dialog ever fires**.
- `applyContact` never demotes and there is no auto-promote, so status stays
  `unconfirmed` forever. **Permanent silent deadlock.**

Live evidence on this machine (packaged build):
- `~/.wmux/plugin-trust.json` → `"claude-code": { "status":"unconfirmed" }`,
  no `declaredCapabilities`, never trusted since `firstSeen`.
- `~/.wmux/shadow-rejections.log` → repeated
  `{"clientName":"claude-code","method":"browser.open","rejection":{"status":"unconfirmed","capability":"browser.navigate"}}`.
- `~/.wmux/config.json` has no `mcp.mode` override ⇒ enforce default applies.

Why it stayed hidden: dev (`npm start`) defaults to **shadow** (allow + log), so
all in-dev dogfooding worked. This is effectively the first packaged enforce-mode
exercise of wmux's own MCP tools by the maintainer. Recent browser PRs
(#104/#107/#108) touched browser internals only, not the enforcement gate — they
did not cause this and their packaged smoke was pending.

## 3. Why this is a design error, not just a missing call

The enforcement layer exists to scope **external, third-party** MCP plugins and
to give the user a consent surface for them. wmux's **own bundled MCP server**
ships inside the app the user installed and launched; it is not a third party.
Treating it as an untrusted plugin — with no way to ever become trusted — is the
defect.

## 4. Threat model / constraints (these bound the design)

- **Shared daemon token.** Every pipe client (first-party or external) presents
  the same `~/.wmux/daemon-auth-token` to talk to the daemon at all
  (`PipeServer.ts:302` timing-safe compare). The token is an admission gate, not
  a per-plugin identity.
- **Declared, not verified identity.** `clientName` is self-asserted; the spec
  says so explicitly (`src/shared/rpc.ts:14-18`: "declared identity, not a
  verified one … any caller can self-name"). User approval is the root of trust.
- **Single-user OS reality.** Any same-user process can read owner-only files and
  another process's argv. No purely-local secret (env, args, file, compiled
  constant) can cryptographically separate "wmux's bundled server" from a
  determined same-user impersonator. A hostile same-user token-holder is already
  out of scope (it can do anything the user can).
- **Registration cannot use `env`.** `McpRegistrar` deliberately omits the `env`
  field (`McpRegistrar.ts:147`) because Claude Code may *replace* (not merge) the
  child environment and break PATH/USERPROFILE. **`args` are appended**, so args
  are the only safe injection channel.
- **Two bundled servers.** `wmux` and `wmux-a2a` are both registered
  (`McpRegistrar.register`). Both are first-party. (Note: the a2a_* tools the
  shadow log shows rejected come from the primary `wmux` server, `src/mcp/index.ts`;
  the separate `wmux-a2a` registration must be confirmed/covered — see §8 open Q.)
- **The approval machinery is fully wired** and only blocked by the empty
  declaration: `ApprovalQueue` (`index.ts:469`) → IPC `PERMISSION_PROMPT_OPEN` →
  `PermissionApprovalDialog.tsx` → `PERMISSION_PROMPT_RESOLVE` →
  `setUserDecision('trusted')`. So enabling declarations re-activates an existing,
  tested path.

Design takeaway: the realistic goal is **strictly stronger than name-only trust,
fail-safe (never a silent deadlock), zero-friction for first-party**, while
accepting the inherent same-user limit (documented, not pretended-away).

## 5. Recommended approach — A (verified first-party token) + C (declare safety net)

### A. Per-connection verified first-party bypass (primary — makes it silent)

1. **Secret.** Main process owns a stable per-install secret
   `firstPartySecret` (32-byte random), persisted to `~/.wmux/first-party-secret`
   with owner-only ACL via the existing `secureWriteTokenFile`, generated once and
   reused thereafter (mirrors the auth-token reuse in `PipeServer.initAuthToken`,
   so no per-boot churn / no args staleness).
2. **Inject via args.** `McpRegistrar.register` appends the secret to BOTH bundled
   server registrations: `args: [mcpScript, '--wmux-fp', firstPartySecret]`.
   Stable secret ⇒ args don't churn ⇒ the existing "args changed → rewrite"
   guard (`McpRegistrar.ts:206`) stays quiet after the one-time migration.
3. **Present it.** The bundled server reads `--wmux-fp` from `process.argv` at
   startup (`src/mcp/index.ts`) and `wmux-client.ts` adds `firstPartyToken` to
   every RPC envelope (next to `clientName`).
4. **Verify it.** `RpcRouter` gets an injected verifier
   (`setFirstPartyVerifier(fn)`, mirroring `setTrustLookup`). In `dispatch`, after
   building `ctx`, it constant-time-compares `request.firstPartyToken` to the
   secret and sets `ctx.firstParty = true` on match. The compare lives in main,
   which holds the secret in memory — no extra cross-process plumbing.
5. **Honor it.** `PermissionEnforcer.check`: add at the top, right after the
   totality guard — `if (input.ctx.firstParty) return { kind: 'allow' }`. Pure
   function unchanged (ctx is already an input). **No trust-DB write** — first
   party is a per-connection property, so a later `clientName:'claude-code'`
   plugin without the secret inherits nothing.

### C. Declaration safety net (built-in — makes failure recoverable, never silent)

6. After `mcp.identify`, the bundled server also calls `mcp.declarePermissions`
   with its full first-party capability set (the KNOWN_CAPABILITIES the bundled
   tools actually use: `browser.*`, `a2a.*`, `pane.*`, `meta.*`, `terminal.*`,
   `events.subscribe`, `workspace.read`, `workspace.claim`, `pane.search`).
   Effect: if the token path ever fails (registration skew right after an upgrade,
   missing secret, stripped arg), the server is `unconfirmed` **with a
   declaration**, so the approval dialog **fires** (`RpcRouter.ts:280` satisfied)
   and the user gets one "Allow wmux's tools?" click — degraded, not deadlocked.
   On approve → `trusted` persists → silent thereafter even without the token.

Net behavior:
- Normal packaged run: token verified ⇒ **zero clicks**, everything works.
- Token path broken for any reason: **one approval dialog**, then trusted.
- Never a silent permanent lockout again.

### Files touched (estimate)
- `src/main/pipe/RpcRouter.ts` — `firstPartyVerifier` field + setter; ctx.firstParty.
- `src/shared/rpc.ts` — `RpcRequest.firstPartyToken?`, `RpcContext.firstParty?`.
- `src/main/mcp/PermissionEnforcer.ts` — one early allow branch.
- `src/main/index.ts` — load/generate secret, `setFirstPartyVerifier`, pass secret to registrar.
- `src/main/mcp/McpRegistrar.ts` — append `--wmux-fp` to both registrations; secret param.
- `src/mcp/index.ts` — parse `--wmux-fp`; call `declarePermissions` after identify.
- `src/mcp/wmux-client.ts` — stash fp token; add to envelope.
- `src/shared/constants.ts` — `getFirstPartySecretPath()`.
- Tests: enforcer first-party allow; RpcRouter verifier (match/mismatch/absent);
  registrar args injection; envelope round-trip; e2e dynamic (bundled daemon +
  RPC probe) proving browser.open passes with token and dialog-fires without.

## 6. Alternatives considered

- **B. McpRegistrar pre-seeds `claude-code: trusted` (+ declared caps) in
  plugin-trust.json.** Simplest (no envelope/bundled-server change), but: pollutes
  the name-keyed DB so ANY `clientName:'claude-code'` client inherits full trust;
  crosses a concern boundary (registrar managing the trust DB); stale 'trusted'
  row survives installs. Security-equivalent to A against same-user, weaker against
  accidental name collision. Keep as fallback if A is deemed too big for a hotfix.
- **C alone (declare only, no token).** Smallest diff; correct fail-safe; but costs
  the user one approval click on first run / after any widened declaration. The
  maintainer explicitly chose "automatic trust" (zero friction), so C-alone misses
  intent — but C is retained as A's safety net.
- **OS peer-credential verification (pipe client PID → image path/signature).**
  The only truly-verified option, but the bundled server runs as `node.exe`
  spawned by Claude Code (not by wmux), so PID→image can't distinguish it from any
  other node process; fragile cross-platform. Rejected.

## 7. Rollout

- Cut `fix/first-party-mcp-trust` from `main` (not from the taskbar branch).
- Land behind the existing enforce/shadow switch — dev stays shadow, so the token
  path is exercised only where it matters (packaged/enforce) and dev keeps working
  even mid-implementation.
- Patch release (v2.16.x). CHANGELOG: "Fixed: wmux's own MCP tools (browser,
  terminal, panes) were blocked in packaged builds under permission enforcement."
- Dynamic verification in a bundled daemon subprocess (template:
  `scripts/v281-dynamic-test.mjs`) BEFORE any release — this bug is invisible to
  unit tests and to dev/shadow.

## 8. Open questions for eng review

1. Token transport: per-RPC envelope field (stateless verify, simplest) vs.
   verify-once-on-identify and mark the connection (less data on the wire, but
   the pipe is connection-per-request here — confirm there's no persistent
   connection to pin to). Leaning per-RPC.
2. Does the separate `wmux-a2a` registration share `wmux-client.ts`/argv parsing,
   or does it need its own injection? Confirm the a2a bundle source path
   (`dist/mcp/mcp/a2a/index.js`) and that the secret reaches it.
3. Should the full first-party capability set be derived from a single source of
   truth (e.g. `listKnownCapabilities()` minus reserved) so it can't drift from
   the methods the bundled tools actually call?
4. Secret lifecycle: stable-per-install (recommended, no staleness) vs. rotate on
   `rotateAuthToken`. If we ever rotate, McpRegistrar must rewrite args AND the
   user must restart Claude Code — the safety net covers the gap, but call it out.
5. Is documenting the residual same-user impersonation risk in
   `docs/api/mcp-plugin-spec.md` sufficient, or does the threat model need an
   explicit "first-party is best-effort, not a security boundary against same-user
   code" statement?
