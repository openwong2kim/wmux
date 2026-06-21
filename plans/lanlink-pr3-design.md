# LanLink PR-3 — Control Plane Design (config-reload + bind guard + NIC/Settings, network-0)

> Phase 2 design. Grounded in the 6-reader understand sweep (workflow `wchvilm54`). All anchors
> verified firsthand. **Network 0** — no `net.Server`, PAKE, AEAD, sanitizer (all PR-4).
> `enabled` default OFF, explicit opt-in.

## 0. Scope recap
Build the *control plane* that lets a future LAN listener (PR-4) be turned on safely:
1. `lanlink?` field in `DaemonConfig` (config.json), OFF default, backward-compatible.
2. Daemon-internal RPCs `lanlink.status` + `lanlink.configure` (runtime config mutate + persist + signal).
3. Pure `assertLanBindAddress(ip, ifaces?)` bind guard (PR-4 calls pre-`listen()`).
4. NIC enumeration (folded into `lanlink.status`).
5. Settings "LanLink" section: enable toggle (OFF) + NIC dropdown + Private-profile/Windows-prompt warning.
6. NIC identity persisted as **name+MAC**, never a raw IP.

## 1. Key runtime facts (from understand sweep)
- Daemon runs as a standalone Node process under **Electron 41's bundled Node 22** (`launcher.ts:456`,
  `ELECTRON_RUN_AS_NODE=1`). → `os.networkInterfaces()` `family` is the **STRING `'IPv4'`**, not numeric `4`.
  Comparing `=== 4` would reject every valid IPv4. **All comparisons use `family === 'IPv4'`.**
- `loadConfig()` is **boot-once** (`index.ts:1967`), result held as the local `const config` +
  referenced by `DaemonSessionManager.config` (same object via `setConfig`, `index.ts:1989`).
- `validateConfig` (`config.ts:222`) is **core-structure-only**; lifecycle knobs are backfilled
  *after* validation passes (`config.ts:142-187`). A failed `validateConfig` triggers a **whole-file reset**.
- `saveConfig` (`config.ts:198`) = atomic `.tmp`+rename, `mode 0o600`, **best-effort (swallows+logs errors)**.
- RPC 3-sync-points: `RpcMethod` union (`rpc.ts:90`) + `ALL_RPC_METHODS` (`rpc.ts:195`) +
  `METHOD_CAPABILITY` (`methodCapabilityMap.ts:161`). All daemon-internal = `{ capability: 'wmux.internal' }`.
- Daemon control pipe is **machine-local**; daemon `onRpc` handlers receive `(params)` only — **no origin
  context** (and none needed: the inbox.poll handler comment at `index.ts:1337` makes this explicit).
- `registerRpcHandlers` (`index.ts:962`, 11 params) + call site (`index.ts:2102`) move in lockstep.
- Execute-wall (`daemonExecuteWall.test.ts:18`) is a **text scan** of `src/daemon/**` — new files must
  not import `ClaudeWorker`/`RpcRouter`/`a2a.rpc` nor textually contain `claudeWorker.execute(`.
- `gen-api-reference --check` runs **inside `npm test`** (`genApiReference.test.mjs`) — daemon-internal
  methods DO appear in `reference.md`; must regen after touching `ALL_RPC_METHODS`/`METHOD_CAPABILITY`.

## 2. Config schema (config.json, DaemonConfig)
`src/daemon/types.ts` — add OPTIONAL top-level field (mirrors `idleShutdownMinutes?` optionality):
```ts
lanlink?: {
  enabled: boolean;          // default false
  nic: LanLinkNic | null;    // persisted identity (name+MAC), default null
  port?: number;             // optional; PR-4 picks a default when absent
};
```
`LanLinkNic = { name: string; mac: string }` (new, in `src/shared/lanlink.ts`).

`src/daemon/config.ts`:
- `createDefaultConfig()` → add `lanlink: { enabled: false, nic: null }` (omit `port` → undefined).
- **Do NOT touch `validateConfig`** — leaving `lanlink` out is what makes an old config.json (no
  `lanlink` key) pass structural validation and avoid the whole-file reset.
- `loadConfig()` post-validate block (after line 187): add `coerceLanLink(raw, def)` helper + call,
  mirroring `clampLifecycle`: absent/garbage → `defaults.lanlink`; per-field coerce (enabled→boolean,
  nic→`{name,mac}`-or-null, port→finite-int-or-undefined) **without touching siblings**.

## 3. NIC introspection — `src/daemon/lanlink/bindGuard.ts` (pure, network-0)
Single cohesive module (file named `bindGuard.ts` per mission; also exports `enumerateNics` since both
parse the same `os.networkInterfaces()` snapshot). **Only imports `node:os` + `src/shared` types** —
stays execute-wall-clean.
```ts
// helper: all { internal:false, family:'IPv4' } entries across ifaces
function externalIPv4(ifaces): Array<{ name; mac; address }>

export function enumerateNics(ifaces = os.networkInterfaces()): NicInfo[]
  // group external IPv4 by interface name → { name, mac (from a non-internal entry), addresses[] }

export function assertLanBindAddress(ip: string, ifaces = os.networkInterfaces()): void
  // throw if !ip || ip==='0.0.0.0' || ip==='::' || ip==='' || ip==='::1' || ip.startsWith('127.')
  // then throw unless ip ∈ externalIPv4(ifaces).address
```
- `ifaces` default-param'd so tests pass a fixture (pure, network-0).
- **Scope note (anticipates codex):** bindGuard deliberately does NOT enforce RFC1918 private ranges —
  per roadmap §5 "LAN-locality" is enforced by the Windows **Private firewall profile** (PR-4), not a
  range check. bindGuard's job is only "real, non-wildcard, non-loopback, external IPv4 on a live NIC."
- `NicInfo = { name: string; mac: string; addresses: string[] }` → `src/shared/lanlink.ts`.

## 4. Daemon RPCs (2 methods) + PR-4 seam
### `src/daemon/lanlink/controller.ts` — `LanLinkController extends EventEmitter`
Constructed in `main()` next to `LanLinkInbox` (`index.ts:1979`); threaded into `registerRpcHandlers`.
```ts
new LanLinkController({ config, persist: saveConfig, ifaces: os.networkInterfaces })
getStatus(): LanLinkStatus            // { enabled, nic, port, nics: enumerateNics(ifaces()) }
configure(patch: LanLinkConfigurePatch): LanLinkStatus
  // 1. validate patch shape (enabled boolean; nic null|{name,mac strings}; port finite int range)
  // 2. compute new lanlink object; assign config.lanlink = next  (single source of truth, in-place)
  // 3. persist(config)            (saveConfig — atomic .tmp+rename, parity w/ existing config writes)
  // 4. emit('changed', next)      ← THE PR-4 SEAM (in-daemon LanLinkServer subscribes in-process)
  // 5. return getStatus()
```
- **Seam rationale:** PR-4's `LanLinkServer` lives *in the daemon* (roadmap §4). The correct toggle
  signal is therefore **in-process** (`controller.on('changed')`), NOT a `DaemonEvent` broadcast to main
  (main can't toggle a daemon-side listener). → PR-3 adds **no** new `DaemonEvent`/`DaemonClient` case,
  keeping the wire surface untouched.
- `config.lanlink` is always present at runtime (loadConfig backfills) but typed optional → controller
  reads `config.lanlink ?? { enabled:false, nic:null }` defensively.

### Registration (`index.ts`, inside `registerRpcHandlers`, next to inbox.poll ~1343)
```ts
pipeServer.onRpc('lanlink.status',    async () => lanLinkController.getStatus());
pipeServer.onRpc('lanlink.configure', async (params) => lanLinkController.configure(coercePatch(params)));
```
No origin gating (control pipe is machine-local, same as inbox.poll).

### Wire registration (3 sync points + DaemonClient wrappers)
- `rpc.ts`: add `'lanlink.status'`, `'lanlink.configure'` to RpcMethod union + ALL_RPC_METHODS.
- `methodCapabilityMap.ts`: `'lanlink.status': { capability: 'wmux.internal' }`, same for configure.
- `DaemonClient.ts` (next to `inboxPoll`): `async lanlinkStatus()` / `async lanlinkConfigure(patch)`.
- Regen `docs/api/reference.md` (`node scripts/gen-api-reference.mjs`).
- Wire types (`LanLinkStatus`, `LanLinkConfigurePatch`, `NicInfo`, `LanLinkNic`) → `src/shared/lanlink.ts`.

## 5. Main IPC + Settings UI
- `src/shared/constants.ts`: `IPC.LANLINK_STATUS='lanlink:status'`, `IPC.LANLINK_CONFIGURE='lanlink:configure'`.
- `src/main/ipc/handlers/lanlink.handler.ts`: `registerLanLinkHandlers(daemonClient)` →
  `ipcMain.handle(IPC.LANLINK_STATUS, wrapHandler(... daemonClient.lanlinkStatus()))` etc.
  (mirror `mcp.handler.ts`). Wire in `registerHandlers.ts:128`.
- `src/preload/preload.ts`: `status` + `configure` (`ipcRenderer.invoke`) are MERGED into PR-2's
  existing post-hoc `(electronAPI as Record<…>).lanlink = { onRemote, requestResync, … }` assignment
  (a second `lanlink:` literal would clobber it). `src/shared/electron.d.ts` extends the `lanlink?` type.
- **Settings section is INLINE in `SettingsPanel.tsx`** (not a standalone file — the `Toggle`/
  `SettingSelect`/`SettingRow`/`SectionLabel` primitives are module-local and unexported, so the
  `McpStatusSection` inline pattern reuses them without a circular import):
  - container `LanLinkSection` — `useIpc({ silent:['NOT_FOUND','UNKNOWN','DAEMON_DISCONNECTED'] })`,
    lazily reads `window.electronAPI.lanlink`; reads `lanlink.status` on mount AND re-probes on
    `daemon:onConnected` (daemon = SoT); toggle/select call `lanlink.configure`, update component state
    from the response; in local-only mode (daemon unreachable) it renders an explanatory placeholder
    rather than a blank pane.
  - exported pure `LanLinkView` (typed props) + exported `nicOptions(nics, selectedNic, t)` helper
    (merges persisted-but-currently-absent NIC as a stale option) → node-env testable.
  - primitives: `Toggle` `SettingSelect` `SettingRow` `SectionLabel` (all local to `SettingsPanel.tsx`).
  - warning copy: i18n key `settings.lanlinkWarning` ("opens this LAN port; Windows may prompt to
    allow" + "Private profile only").
- `SettingsPanel.tsx`: extend `TabId`, add a `tabs` entry + `IconLanLink`, add
  `activeTab==='lanlink' && <LanLinkSection/>`.
- `src/renderer/i18n/locales/en.ts` (+ ko.ts): `settings.lanlink*` keys.
- **No uiSlice mirror / buildSessionData entry** — daemon status is the single source of truth (avoids
  the two-source divergence trap the settings reader flagged).

## 6. Adversarial analysis (design-time REFUTE pass)

| Vector | Defense | Residual |
|---|---|---|
| **C2 bind bypass** (0.0.0.0 / '' / '::' / loopback / internal / absent NIC / IPv6-only) | `assertLanBindAddress` fail-closed: explicit wildcard/loopback rejects + membership in `family==='IPv4' && !internal` set. Unit-tests every reject case + a real LAN IPv4 pass. | RFC1918 deliberately out of scope (firewall profile, PR-4) — documented. |
| **Backward-compat break** (old config.json no `lanlink` → reset) | `lanlink` absent from `validateConfig`; per-field backfill after validate gate. Regression test: old config (no lanlink) → `{enabled:false,nic:null}`, every sibling field byte-preserved. | — |
| **Reload race / partial write** | Daemon single-threaded; `configure` mutates-then-`saveConfig` synchronously (atomic .tmp+rename). No interleave, no torn file. | `saveConfig` is best-effort (parity w/ all config.json writes) — phantom-state window on disk-full is identical to existing config behavior; acceptable for a config file (not a message log). |
| **NIC disappearance** | Persist name+MAC, re-resolve at PR-4 listen via bindGuard. `status.nics` reflects live NICs; `nicOptions` keeps the persisted NIC visible as a stale option. | Live listener rebind = PR-4. |
| **Remote reachability of `lanlink.configure`** | Triple structural: (a) `wmux.internal` (no plugin/MCP can declare), (b) daemon control pipe is machine-local, (c) PR-4 `LanLinkRouter` allow-list won't register it. Drift-lock test asserts both methods are `wmux.internal`. | — |
| **Dev-gate inversion** | No new dev-only RPC needed; if one is added, use the positive allowlist (`NODE_ENV dev/test \|\| WMUX_*`), never `!== 'production'`. | — |
| **Validator array-bypass** | `coerceLanLink` checks `typeof === 'object' && !Array.isArray` before field reads (the #269 lesson). | — |

## 7. File manifest (as shipped)
**New:** `src/daemon/lanlink/bindGuard.ts`, `src/daemon/lanlink/controller.ts`,
`src/daemon/lanlink/__tests__/bindGuard.test.ts`, `.../controller.test.ts`,
`src/main/ipc/handlers/lanlink.handler.ts`,
`src/renderer/components/Settings/__tests__/LanLinkSection.test.tsx`,
`src/shared/__tests__/lanlink.pr3.test.ts`, `scripts/lanlink-pr3-dogfood.mjs`.
(The LanLink Settings section ships INLINE in `SettingsPanel.tsx`, not as a separate file; config
backfill tests are appended to the existing `src/daemon/__tests__/config.test.ts`.)
**Modified:** `src/daemon/types.ts`, `src/daemon/config.ts`, `src/shared/lanlink.ts`, `src/shared/rpc.ts`,
`src/main/mcp/methodCapabilityMap.ts`, `src/main/mcp/__tests__/methodCapabilityMap.test.ts`,
`src/main/DaemonClient.ts`, `src/daemon/index.ts`, `src/main/ipc/registerHandlers.ts`,
`src/shared/constants.ts`, `src/preload/preload.ts`, `src/shared/electron.d.ts`,
`src/renderer/components/Settings/SettingsPanel.tsx`,
`src/renderer/i18n/locales/en.ts` (+ ko.ts), `docs/api/reference.md` (regen).

## 8. Verification
- Unit: bindGuard reject/pass matrix + enumerateNics (family-string, excludes internal);
  config backward-compat + per-field backfill; controller configure persist+emit+idempotent + status shape;
  drift-lock (lanlink.* = wmux.internal); LanLinkView markup + nicOptions helper.
- `tsc` 4-config exit0 + vitest full suite green + `gen-api-reference --check` (rides in `npm test`).
- `npm run build:daemon` locally (root tsc won't catch a daemon-only `src/main` import).
- Live dogfood (`scripts/lanlink-pr3-dogfood.mjs`, standalone daemon, `WMUX_DATA_SUFFIX` isolation):
  spawn → `lanlink.configure(enable+NIC)` → assert config.json reflects → SIGKILL → respawn →
  `lanlink.status` asserts persistence + NIC re-resolution.
- Phase 4: opus adversarial panel (per-finding REFUTE) + codex `review --uncommitted` gate.
