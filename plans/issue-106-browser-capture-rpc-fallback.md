# Issue #106 — Browser console/network/response_body: RPC fallback for packaged builds

**Status:** PLAN (pre-implementation)
**Base:** `main` @ `711e165` (includes #105 / #107)
**Branch:** `feat/mcp-capture-rpc-fallback`

## Problem

`browser_console`, `browser_network`, `browser_response_body` still throw
`No browser page available` in packaged builds. #105 fixed the one-shot DOM
tools by rerouting through `browser.evaluate`; these three can't use that route
because they don't read the DOM once — they rely on Playwright's **event
subscription** model (`page.on('console' | 'request' | 'response')`), which a
single `Runtime.evaluate` cannot replicate.

## Why there is no shortcut (confirms the subsystem is required)

- **console:** a page does not expose its own console history to script. There
  is no `evaluate` expression that returns past `console.log` calls. The only
  capture path is CDP `Runtime.consoleAPICalled` (or `Log.entryAdded`).
- **network:** `performance.getEntriesByType('resource')` yields URLs + timing
  but NOT method, status, headers, or body. Full request/response data only
  comes from the CDP `Network` domain.
- **response body:** only retrievable via CDP `Network.getResponseBody` after
  `loadingFinished` (or eager `response.text()` on the Playwright path).

So packaged-mode capture requires enabling CDP domains on the guest
`webContents` and listening for events in the main process. There is no
evaluate-based fallback.

## Existing infrastructure (what we build on)

- `WebviewCdpManager.register()` already calls `wc.debugger.attach('1.3')` per
  surface and `detach()` on unregister (`WebviewCdpManager.ts:31,81`). The
  debugger is live; `browser.screenshot` / `browser.evaluate` already drive it
  via `wc.debugger.sendCommand`.
- **No `wc.debugger.on('message', ...)` listener exists anywhere yet** — #106 is
  the first CDP event consumer.
- The MCP side already buffers console/network with bounds in `inspection.ts`
  (`MAX_CAPTURE_ENTRIES=1000`, `MAX_RESPONSE_BODY_BYTES=256*1024`, capped ring,
  WeakMap<Page>, close cleanup). The main-process capture should mirror these.

## Goals

1. `browser_console` / `browser_network` / `browser_response_body` work in
   packaged builds (page-null path) by draining a main-process CDP capture
   buffer over new RPC methods.
2. Zero behavior change on the Playwright path (dev). Capture semantics match
   the existing tools ("accumulated over time", `clear` resets, level/glob
   filters, bounded buffers, 256KB body cap, textual-only body capture).
3. No always-on cost when the feature is unused (see lazy decision below).

## Decisions locked (eng review, 2026-06-05)

- **D1 = full parity.** Build console + network + response_body. (User chose to
  build despite browser automation being de-prioritized — restoring all three
  packaged-mode tools, not a subset.)
- **D2 = lazy.** Enable CDP domains + attach the listener on the first capture
  RPC call. Zero overhead when unused; matches the dev tools' "listener attached
  on first call" semantics. Pre-first-call events are not captured (same as dev).
- **D3 = three methods.** `browser.console.get`, `browser.network.get`,
  `browser.responseBody.get` (with a `clear` flag where applicable), matching the
  codebase's granular `browser.*` RPC convention. No unified `kind` dispatcher.

## Codex review fixes folded in (2026-06-05)

All incorporated below. Codex's "simpler path" (fix `getPage()` instead) was
assessed and rejected: the guest `<webview>` is driven via `wc.debugger.attach`
(in-process Electron Debugger), a different channel from the
`--remote-debugging-port` that Playwright's `connectOverCDP` uses; Electron
webview guests don't reliably surface as connectable "page" targets there
(that's why #104+ use RPC-direct everywhere). Fixing `getPage()` is Electron-
internal, not cheaper. RPC-direct is the correct channel.

C1. **Lazy enable ORDER**: attach `wc.debugger.on('message')` + init buffers
    BEFORE `Runtime.enable` / `Network.enable` (events can fire during enable).
C2. **Singleflight**: `ensure(wc)` caches an in-flight Promise (not a post-await
    boolean) so concurrent first calls don't double-attach / double-buffer.
C3. **Listener removal**: `detach` does NOT remove EventEmitter listeners —
    explicitly `removeListener('message')` + `removeListener('detach')` on cleanup.
C4. **DevTools detach (real)**: opening webview DevTools terminates the debugger
    session (Electron: single client). Hook `wc.debugger.on('detach')` → mark the
    wc's capture stale, drop buffers + listeners, and re-`ensure()` (re-attach +
    re-enable) on the next capture call. (Pre-existing fragility — `WebviewCdpManager`
    never listened for detach; capture must.)
C5. **Console formatting**: `Runtime.consoleAPICalled` gives `args: RemoteObject[]`,
    not text. Format each RemoteObject to a string (value/description/`unserializable
    Value`; objects → preview or JSON; undefined/NaN/bigint handled). Map CDP
    `warning` → `warn` so the tool's level filter (`inspection.ts:401,422`) works.
C6. **Network keyed by requestId** (not URL): correlate `requestWillBeSent` →
    `responseReceived` → `loadingFinished` by `requestId`. Handle `redirectResponse`
    on `requestWillBeSent` (record the redirect hop's status before overwriting).
C7. **Response body**: `Network.getResponseBody` → `{ body, base64Encoded }`.
    Decode base64 when `base64Encoded` (or skip non-textual). Wrap in try/catch —
    it rejects for cached/evicted/redirected/failed/navigated/detached requests;
    on failure leave a body-less but valid entry.
C8. **Network.enable buffer sizes**: pass `maxResourceBufferSize` /
    `maxTotalBufferSize` sized around the body cap so `getResponseBody` doesn't
    evict under load.
C9. **Memory budget (RAM-sensitive app)**: per-webContents **total retained body
    bytes** budget `MAX_TOTAL_BODY_BYTES = 4*1024*1024` — evict oldest bodies
    (keep entry metadata) when exceeded. Avoids the 1000×256KB ≈ 256MB worst case.
    Entry-count ring stays at `MAX_CAPTURE_ENTRIES`.
C10. **`methodCapabilityMap.ts`**: total over `RpcMethod` — the 3 new methods MUST
    get capability entries (`browser.read`) or the contract test fails the build.
C11. **`message` signature**: `(event, method, params, sessionId)` — 4 args; tests
    include the 4th.

## Design (D1=full, D2=lazy, D3=three methods)

```
 first browser_console/network call with getPage()==null
        │
        ▼
 sendRpc('browser.console.get' | 'browser.network.get' | 'browser.responseBody.get')
        │  (main process)
        ▼
 BrowserCaptureManager.ensure(webContentsId)
   ├─ wc.debugger already attached (WebviewCdpManager) — reuse it
   ├─ once per wc: sendCommand('Runtime.enable'), sendCommand('Network.enable')
   ├─ wc.debugger.on('message', (_e, method, params) => route + buffer)
   │     Runtime.consoleAPICalled   -> console ring  (level, text)
   │     Network.requestWillBeSent   -> net ring      (url, method)
   │     Network.responseReceived    -> fill status + headers
   │     Network.loadingFinished     -> if textual: getResponseBody -> body (capped)
   └─ wc.on('destroyed') / unregister -> drop buffers + listener
        │
        ▼
 return buffered entries (same shape the tools already format)
```

- **Buffers:** `Map<webContentsId, { console: ConsoleEntry[]; network: NetworkEntry[] }>`,
  capped rings reusing the `MAX_CAPTURE_ENTRIES` / `MAX_RESPONSE_BODY_BYTES`
  constants (lift them to a shared spot so MCP + main agree).
- **Body capture:** mirror the MCP `isTextual` content-type filter; fetch via
  `Network.getResponseBody`, truncate at 256KB with the same suffix.
- **Cleanup:** hook `WebviewCdpManager.unregister` (or `wc.on('destroyed')`) to
  delete the buffer and remove the listener, so a closed surface frees its
  (potentially large) retained bodies promptly. Detaching the debugger
  (unregister already does) drops the CDP events anyway.
- **Tool wiring (`inspection.ts`):** each of the three tools changes
  `getPage()` → `.catch(()=>null)`; on null, `sendRpc('browser.<x>.get', {
  surfaceId, filter?/level?/clear?/urlPattern? })` and format the returned
  entries with the SAME formatter the Playwright path uses (extract the
  formatting into shared helpers so both paths render identically).

## Files (D1=a)

| File | Change |
|---|---|
| `src/main/browser-session/BrowserCaptureManager.ts` | **NEW** — CDP event capture, bounded buffers, drain/clear API |
| `src/main/browser-session/WebviewCdpManager.ts` | call capture cleanup on `unregister` |
| `src/main/pipe/handlers/browser.rpc.ts` | new `browser.console.get` / `browser.network.get` / `browser.responseBody.get` handlers |
| `src/shared/rpc.ts` | add 3 methods to `RpcMethod` + `ALL_RPC_METHODS` |
| `src/main/mcp/methodCapabilityMap.ts` | add 3 `browser.read` entries (total map — build breaks without) |
| `src/mcp/playwright/tools/inspection.ts` | RPC fallback for the 3 tools; shared formatters |
| `src/main/browser-session/__tests__/BrowserCaptureManager.test.ts` | **NEW** — fake debugger emitter drives events; assert buffering, bounds, body cap, clear, cleanup |
| `src/mcp/playwright/tools/__tests__/*` | tool fallback unit tests (mock sendRpc) |

## Test strategy

- `BrowserCaptureManager` is the bulk of the logic and is unit-testable with a
  **fake `wc.debugger`** (an EventEmitter with a `sendCommand` stub). Drive
  `consoleAPICalled` / `Network.*` messages → assert ring contents, 1000-entry
  cap, 256KB body truncation, textual-only body fetch, `clear`, and
  cleanup-on-destroy. No real browser needed (node env).
- Tool fallback: mock `sendRpc`, assert the 3 tools call the right method with
  the right params and format identically to the Playwright path.
- Full suite + `tsc -p tsconfig.mcp.json` (MCP) + main typecheck + `build:mcp`.
- **Packaged smoke test (PENDING, like #105):** real `npm run make` bundle —
  open a page that logs to console + makes XHRs, then `browser_console` /
  `browser_network` / `browser_response_body`. Request from @junbeom09.

## Risks / trade-offs

- **Shared `wc.debugger` listener.** Only one `message` consumer should exist per
  webContents. Centralize in `BrowserCaptureManager`; never attach elsewhere.
  `sendCommand` (screenshot/evaluate) coexists fine with an event listener.
- **Domain-enable interaction.** `Runtime.enable` makes `consoleAPICalled` fire;
  `Network.enable` adds per-request CDP traffic. Lazy enable confines this to
  sessions that actually query capture.
- **Body fetch race.** `getResponseBody` must run after `loadingFinished`; the
  buffer entry can shift in a capped ring — hold a stable entry reference
  (the MCP side already learned this, `inspection.ts:124`).
- **Double counting.** dev uses the Playwright path (page exists), packaged uses
  RPC (page null) — mutually exclusive per call, so no double capture. A
  null→page flip just means the two buffers diverge (best-effort, acceptable).
- **Wire surface growth.** Three new experimental RPC methods. Additive; classify
  experimental in `docs/api/inventory.md`.

## Decision gate

Because browser automation is de-prioritized and this is a ~300-400 LOC
subsystem (vs #105's reuse of an existing channel), D1 (build/scope) is a real
"is it worth it now?" call — surfaced first at eng review before any code.
