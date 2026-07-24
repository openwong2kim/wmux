# `browser_tabs` Workspace-Scoped Contract

> **Status:** Implemented and submitted as PR [#575](https://github.com/openwong2kim/wmux/pull/575). Independent security/TypeScript reviews and the §7.2 live dogfood are complete; the §9 gate was satisfied before submission and now governs future changes to this contract.
> **Issue:** [#565](https://github.com/openwong2kim/wmux/issues/565), follow-up to [#554](https://github.com/openwong2kim/wmux/issues/554) / PR [#563](https://github.com/openwong2kim/wmux/pull/563).
> **Scope:** Define the caller-visible tab model, isolation boundary, wire shape, and acceptance criteria for `browser_tabs`.
> **Out of scope:** External-Chrome routing (#517), a privileged cross-workspace operator view, and general authorization changes for every browser tool that accepts an explicit `surfaceId`.

---

## 0. Decision summary

1. A `browser_tabs` tab is a wmux browser `Surface`, not an arbitrary Playwright `Page`, `BrowserContext`, app-shell target, or DevTools target.
2. The stable address is the surface's opaque string `surfaceId`. The unsafe numeric `tabId` index is removed rather than translated or retained as a compatibility alias.
3. Every action is implicitly scoped to the calling MCP session's workspace. The public tool does not accept a `workspaceId`.
4. Workspace identity is mandatory. If identity cannot be resolved, every action, including `list`, fails closed before reading browser state.
5. `list` is sourced from the workspace's logical surface tree, not from live CDP pages. It therefore includes a browser surface that lightweight mode has discarded and excludes the Electron shell and DevTools by construction.
6. `select` and `close` re-check ownership at the mutation boundary and return the same not-found error for a missing surface and a surface owned by another workspace.
7. `new` creates a new wmux browser surface in the caller's workspace. It never creates a detached Playwright page and never reuses an existing surface.
8. There is no implicit cross-workspace/operator behavior. A future fleet-wide view must be a separate privileged API with an explicit capability and audit model.

This is an intentionally breaking correction to an experimental API. `docs/api/inventory.md` explicitly allows `browser_*` wire shapes to evolve before v3.0.

## 1. Why the current model is invalid

The current implementation in `src/mcp/playwright/tools/navigation.ts` calls `PlaywrightEngine.getBrowser()`, flattens every Playwright page in every context, and assigns an index based on the resulting array:

```ts
const contexts = browser.contexts();
const allPages = contexts.flatMap((ctx) => ctx.pages());
```

That collection is global to the Electron CDP connection. It can contain:

- the Electron app shell;
- DevTools pages;
- browser guests owned by other workspaces; and
- pages whose ordering changes as targets attach, detach, reload, or are discarded.

Consequently, a numeric index has neither stable identity nor an ownership boundary. Filtering the array after assigning indexes would reduce the immediate leak but would preserve the wrong entity model and a race-prone address.

Current main also supports more than one browser surface per workspace. The `forceNew` path in `src/renderer/utils/browserPane.ts` creates another browser pane, and renderer store tests exercise multiple browser surfaces. The contract must therefore support zero, one, or many surfaces rather than encode a singleton assumption.

Finally, #517's discard mode deliberately unregisters a hidden guest's live CDP target while retaining its logical browser surface. `browser.cdp.info` is authoritative for live attachment metadata, but it is not a complete tab inventory.

## 2. Normative entity model

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

### 2.1 Tab identity

A browser tab is a `Surface` satisfying:

```ts
surface.surfaceType === 'browser'
```

Its public address is:

```ts
surfaceId: string
```

`surfaceId`:

- MUST be treated as opaque by callers;
- MUST remain stable across listing, pane reorder, navigation, CDP re-registration, discard, and wake for the lifetime of that logical surface;
- MUST NOT be derived from list position;
- MUST NOT expose `targetId` or `webContentsId`; and
- MAY be passed to other browser tools that already accept an explicit `surfaceId`.

A surface ceases to exist after a successful close. A newly created surface receives a new ID.

### 2.2 Ownership

Every browser surface is owned by exactly one workspace: the workspace whose pane tree contains it.

The caller's workspace is resolved from the MCP session by the same strict identity mechanism used by `browser_open` and `browser_close` (`requireWorkspaceId`). A caller-supplied workspace selector is not part of this tool contract.

CDP metadata is only a secondary live-target mapping. Whenever a live target is used, the implementation MUST require both:

```ts
target.surfaceId === requestedSurfaceId
target.workspaceId === callerWorkspaceId
```

An untagged target is never sufficient evidence for a workspace-scoped action.

### 2.3 Selection

A surface is `selected` when both are true:

```ts
workspace.activePaneId === pane.id
pane.activeSurfaceId === surface.id
```

Selection is workspace-local and non-yank:

- selecting a surface updates the owning workspace's active pane and active surface;
- it MUST NOT change the app's global `activeWorkspaceId`; and
- it MUST NOT use Playwright `Page.bringToFront()` as the source of truth.

For this issue, selection is a wmux UI-state operation only. Callers that subsequently operate on a particular tab SHOULD pass the returned `surfaceId` explicitly to the next browser tool.

Changing the default target semantics of every browser tool that omits `surfaceId` is a related but separate hardening task; see §8.1.

### 2.4 Logical versus live state

The renderer surface tree is the source of truth for existence, ownership, pane placement, stored URL, title, and selection.

`browser.cdp.info` is the source of truth only for whether a corresponding live guest target is currently registered. A discarded, mounting, or temporarily unregistered browser surface remains a valid tab and MUST remain visible in `list`.

`list` MUST NOT wake, attach to, lease, or auto-open a browser merely to obtain metadata.

## 3. Public MCP tool contract

### 3.1 Input

The schema is a discriminated union:

```ts
type BrowserTabsInput =
  | { action?: 'list' }
  | { action: 'new'; url?: string }
  | { action: 'select'; surfaceId: string }
  | { action: 'close'; surfaceId: string };
```

Rules:

- omitted `action` means `list`;
- `surfaceId` is required for `select` and `close`;
- `surfaceId` is rejected for `list` and `new`;
- `url` is accepted only for `new`;
- a numeric `tabId` is rejected by schema validation; and
- there is no legacy index-to-surface conversion, even when only one tab exists.

The tool description SHOULD say that it manages browser surfaces in the calling workspace and that callers must use the returned `surfaceId`, never a list position.

### 3.2 Descriptor

Every successful read/create/select response uses this descriptor:

```ts
interface BrowserTabDescriptor {
  surfaceId: string;
  paneId: string;
  url: string;
  title: string;
  selected: boolean;
}
```

Field semantics:

- `surfaceId`: stable opaque address described in §2.1.
- `paneId`: owning pane in the caller's workspace.
- `url`: last known normalized `browserUrl`, falling back to wmux's default browser URL only when the stored value is absent.
- `title`: last known logical surface title. It may be the generic `"Browser"` label; `list` does not attach to CDP merely to refresh it.
- `selected`: exact predicate from §2.3.

The response MUST NOT include `workspaceId`, CDP `targetId`, `webContentsId`, partition credentials, or data from another workspace.

### 3.3 Output envelopes

The MCP result contains one text item with pretty-printed JSON.

`list`:

```json
{
  "action": "list",
  "tabs": [
    {
      "surfaceId": "surface-...",
      "paneId": "pane-...",
      "url": "https://example.com/",
      "title": "Browser",
      "selected": false
    }
  ]
}
```

`new`:

```json
{
  "action": "new",
  "tab": {
    "surfaceId": "surface-...",
    "paneId": "pane-...",
    "url": "https://example.com/",
    "title": "Browser",
    "selected": false
  }
}
```

`select`:

```json
{
  "action": "select",
  "tab": {
    "surfaceId": "surface-...",
    "paneId": "pane-...",
    "url": "https://example.com/",
    "title": "Browser",
    "selected": true
  }
}
```

`close` snapshots the descriptor before mutation and returns it as `closed`:

```json
{
  "action": "close",
  "closed": {
    "surfaceId": "surface-...",
    "paneId": "pane-...",
    "url": "https://example.com/",
    "title": "Browser",
    "selected": false
  }
}
```

List order is deterministic pane-tree depth-first order followed by each leaf's surface-array order. Ordering is presentation only and MUST NOT be used for addressing.

## 4. Action semantics

### 4.1 `list`

`list` MUST:

1. resolve the caller workspace strictly;
2. read only that workspace's pane tree;
3. positively include only `surfaceType === 'browser'`;
4. include live and discarded logical browser surfaces;
5. return an empty `tabs` array when the caller owns none; and
6. perform no browser connection, auto-open, wake, selection, or lease side effect.

App-shell and DevTools pages cannot enter the result because neither is a wmux browser surface.

### 4.2 `new`

`new` MUST:

1. resolve the caller workspace strictly;
2. validate a supplied URL with the existing navigation policy, including resolved-address checks;
3. create a new browser surface through wmux's renderer/store path;
4. use create-new semantics (`forceNew: true`) rather than `BrowserContext.newPage()` or open-or-reuse behavior;
5. create it in the caller's workspace even when another workspace is visible;
6. leave the app's global active workspace unchanged;
7. avoid stealing the existing active pane focus (`focusPane: false`);
8. return the exact created descriptor; and
9. fail rather than report success if the pane or surface was not actually created.

If `url` is omitted, wmux's normal default browser URL applies.

### 4.3 `select`

`select` MUST:

1. resolve the caller workspace strictly;
2. look up `surfaceId` only within that workspace;
3. re-check that it is a browser surface immediately before mutation;
4. atomically set that workspace's active pane and the pane's active surface;
5. leave global `activeWorkspaceId` unchanged; and
6. return the post-selection descriptor with `selected: true`.

It MUST NOT call `Page.bringToFront()`, enumerate Playwright pages, or fall back to a globally matching surface.

### 4.4 `close`

`close` MUST:

1. resolve the caller workspace strictly;
2. look up `surfaceId` only within that workspace;
3. re-check ownership and browser type immediately before mutation;
4. close the logical surface through the same store/UI lifecycle as a user close;
5. preserve the existing empty-pane/root-pane cascade behavior;
6. leave global `activeWorkspaceId` unchanged; and
7. return the pre-close descriptor after successful mutation.

It MUST NOT call `Page.close()` directly or use the current global explicit-ID behavior of `surface.close` / `browser.close` without an ownership re-check.

If the surface disappears between lookup and mutation, the operation fails as not found. It never retargets by index or URL.

## 5. Isolation and error contract

Failures return `isError: true` and a stable code in the text:

```text
Error [BROWSER_TAB_NOT_FOUND]: Browser tab was not found in the calling workspace.
```

Recommended codes:

| Code | Condition |
|---|---|
| `BROWSER_TABS_WORKSPACE_UNRESOLVED` | Caller workspace identity cannot be established. |
| `BROWSER_TABS_UNSUPPORTED` | The connected main process lacks the workspace-scoped tabs contract. |
| `BROWSER_TABS_UNAVAILABLE` | The scoped RPC transport failed or returned a malformed response. |
| `BROWSER_TABS_INVALID_ARGUMENT` | Action/field combination is invalid after schema parsing. |
| `BROWSER_TAB_NOT_FOUND` | Surface is absent, was concurrently removed, is not a browser, or belongs to another workspace. |
| `BROWSER_TAB_URL_BLOCKED` | Initial or resolved URL violates navigation policy. |
| `BROWSER_TAB_CREATE_FAILED` | Pane cap, missing workspace after an async gap, or another creation failure. |

Security rules:

- a foreign `surfaceId` and a nonexistent `surfaceId` MUST produce the same code and materially identical message;
- the error MUST NOT reveal the foreign workspace, URL, title, pane, or whether the ID exists elsewhere;
- unresolved identity MUST NOT fall back to the UI-active workspace;
- an older main without workspace ownership support MUST NOT trigger legacy global enumeration; and
- no action may acquire `withAutomationLease(undefined)`.

These rules bound what **this tool** discloses. They are not a system-wide guarantee that workspace ownership is unobservable: §8.2 records a sibling RPC that still exposes live-target metadata across workspaces.

If a later implementation needs CDP for a specific action, it acquires a lease for the positively owned `surfaceId` only.

## 6. Recommended internal boundary

The tool should not reconstruct this contract from global Playwright state. The smallest robust boundary is a first-party internal RPC, for example:

```ts
browser.tabs({
  action,
  workspaceId, // supplied only after requireWorkspaceId()
  surfaceId?,
  url?,
})
```

Recommended properties:

1. `registerNavigationTools` receives a per-connection strict workspace resolver, rather than reaching through `PlaywrightEngine`'s private lenient resolver.
2. The RPC is gated as `wmux.internal` unless/until the pipe protocol can bind an arbitrary plugin request to a verified caller workspace. A public `browser.read` capability plus a caller-controlled `workspaceId` would not be an ownership boundary. Within the repository's current same-OS-user trust ceiling, adding this reserved method also requires an explicit `FIRST_PARTY_METHODS` entry, an `ALLOWED_RESERVED_FIRST_PARTY` security-review exception, and their synchronization tests. Because the multiplexed method can execute `close`, the whole method also belongs in `COMMANDER_TEARDOWN_DENY`; browser tools are already absent from the commander surface, and this is the server-side effect backstop.
3. The renderer handler reads and mutates the named workspace's surface tree. `select` and `close` perform scoped lookup and mutation in the same handler so the security decision is revalidated at the effect boundary.
4. `new` delegates to `openUrlInBrowserPane` with `{ workspaceId, forceNew: true, focusPane: false }`; main retains resolved-URL validation.
5. `close` shares the existing browser close cascade helper after that helper is made workspace-exact. It does not duplicate a subtly different close lifecycle.
6. The MCP tool serializes the typed RPC result to JSON and never calls `engine.getBrowser()`.

`browser.cdp.info` remains useful when another browser operation must map the returned `surfaceId` to a live target. It is not used as the sole inventory because discarded surfaces intentionally have no registered target.

## 7. Acceptance criteria

### 7.1 Unit and contract tests

- Identity resolution failure makes all four actions fail closed and makes zero RPC, Playwright, lease, or renderer calls.
- With workspaces A and B, A's `list` returns every browser surface in A and none from B.
- App shell and DevTools targets are absent even when connected and visible in Playwright contexts.
- A discarded/unregistered browser surface remains in `list`.
- No browser connection is required for an empty successful list.
- Two browser surfaces in one workspace receive distinct stable string IDs and remain addressable after list order changes.
- Numeric `tabId` input is rejected; no index shim runs.
- `select` on A's surface updates A's active pane/surface without changing global `activeWorkspaceId`.
- `select` on B's surface from A returns `BROWSER_TAB_NOT_FOUND` and performs no mutation.
- `close` on B's surface from A has the same externally visible failure as a random ID and performs no mutation.
- A surface removed between initial lookup and mutation returns `BROWSER_TAB_NOT_FOUND`; it never closes another surface.
- A successful close uses the same last-surface pane cascade as the UI close path.
- `new` always creates a distinct surface in A, never reuses A's existing browser, never creates in B, and does not change global `activeWorkspaceId`.
- `new` rejects unsafe initial and resolved URLs before creating or navigating a surface.
- No action acquires a global/undefined automation lease.
- An untagged or mismatched live CDP target is never accepted as ownership evidence.
- A validated commander request cannot call the multiplexed `browser.tabs` RPC; the teardown backstop rejects it before dispatch.

### 7.2 Live two-workspace dogfood

1. Open two browser surfaces in workspace A and one in workspace B.
2. Open app DevTools so shell and DevTools targets are present.
3. Allow one A surface to enter discard mode.
4. From A, verify `list` returns exactly A's two logical surfaces, including the discarded one.
5. From B, verify `list` returns exactly B's surface.
6. From A, attempt to select and close B's captured `surfaceId`; both must return the scoped not-found error and B must remain unchanged.
7. From A, select and close each owned surface by ID while targets reload/reorder; the intended surface alone must change.
8. From a background workspace, run `new`; the surface must appear there without switching the user's visible workspace or duplicating/stranding panes (#531 regression).

**2026-07-24 result — pass (one-time manual run; not reproduced by CI).**
The observations below were recorded by hand on a single machine. Nothing in
the automated suite re-runs them, so treat them as evidence that the
implementation behaved correctly on that day rather than as a standing
guarantee — that is precisely why §9 requires the matrix again for any later
change to this boundary. The matrix ran in a uniquely suffixed dev
instance with the documented short discard-dwell override. The global CDP
catalog contained the app shell, an open DevTools target, and all three initial
guests, while logical lists stayed exactly A=2 and B=1. After A was hidden,
its two registered guests dropped to zero while A's logical list remained at
two. Foreign select/close matched random-ID failures
(`BROWSER_TAB_NOT_FOUND`), background new/select did not yank the visible
workspace, reveal remounted the discarded guests, and stable-ID close removed
only the intended surface through the full sequence.

## 8. Adjacent findings and explicit non-goals

### 8.1 Omitted-`surfaceId` navigation remains a separate audit

Static inspection found that `browser_navigate` and `browser_navigate_back` send `browser.navigate` / `browser.goBack` without a workspace ID when their optional `surfaceId` is omitted. Main then calls `WebviewCdpManager.getTarget(undefined)`, whose documented fallback is the first globally registered target.

That path is not fixed merely by making `browser_tabs select` workspace-scoped. Until a separate audit resolves the default-target contract, callers should pass the `surfaceId` returned by `browser_tabs` to subsequent browser operations.

This should be confirmed with a focused two-workspace test and, if reproduced, tracked separately rather than silently expanding the #565 implementation.

### 8.2 `browser.cdp.info` still exposes live-target metadata across workspaces

Independent review of the implementation surfaced a pre-existing side channel that §5 does not close, and that a reader could otherwise assume it did.

`browser.cdp.info` (`src/main/pipe/handlers/browser.rpc.ts`) returns every **registered** CDP target with its `surfaceId`, `targetId`, and owning `workspaceId`, unfiltered by caller. Its capability is `browser.read` — an ordinary declarable capability, not `wmux.internal` — so a plugin the user approved for browser reads can enumerate which workspaces currently hold live browser guests, and learn their surface IDs.

It composes with the sibling in §8.1: `browser.close` resolves an explicit `surfaceId` across **every** workspace by design (the "surface.close lesson" — scoping an unambiguous ID only manufactures false not-founds). A caller holding `browser.read` plus `browser.navigate` can therefore read a foreign `surfaceId` out of `browser.cdp.info` and hand it to `browser.close`.

Both legs predate this issue and neither is introduced by it. `browser_tabs` never consults `browser.cdp.info` and never leaves the caller's workspace, so its own contract is unaffected. The exposure is also bounded: no URL, title, or page content, and a discarded surface is absent because it holds no registered target. It sits inside the repository's same-OS-user trust ceiling. It is recorded here because #565 is where the browser-tab isolation boundary is defined, so the boundary's known gaps belong in the same document rather than in a reviewer's notes.

Closing it is a separate change. `browser.cdp.info` is load-bearing for `PlaywrightEngine`'s attach path, which legitimately needs global target data to recognize the app shell, so scoping it needs its own design and its own regression tests.

### 8.3 Other non-goals

- No cross-workspace commander/operator listing.
- No external Chrome backend selection.
- No promise that page title is refreshed while a surface is discarded.
- No global rewrite of explicit-`surfaceId` authorization for unrelated browser tools.
- No compatibility mode for numeric indexes.
- No version bump in the implementation PR.

## 9. Implementation review gate

All five steps were completed before this contract and its implementation were
submitted. They stay here as a standing gate rather than a one-off checklist:
any later change to the isolation boundary defined above repeats them before it
is pushed, because the guarantees in §5 are only as good as the last time
someone re-ran §7.2 against a real two-workspace instance.

1. produce the implementation diff against current upstream main;
2. run the focused unit/contract suite plus typecheck and lint for touched files;
3. run the two-workspace live matrix from §7.2;
4. obtain an independent Claude review covering isolation, TOCTOU behavior, discard-mode completeness, URL validation, and compatibility; and
5. obtain explicit human approval after the diff and review are visible.
