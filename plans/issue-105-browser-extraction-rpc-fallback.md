# Issue #105 — Browser extraction/snapshot tools: RPC fallback for packaged builds

**Status:** PLAN (pre-implementation)
**Base:** `origin/main` @ `2808f38` (includes #104)
**Branch:** `fix/mcp-browser-extraction-rpc-fallback`

## Problem

In a packaged build, `connectOverCDP` (playwright-core) does not surface the
Electron `<webview>` guest as a Playwright `Page`. After #104 made
`PlaywrightEngine.getPage()` correctly refuse the app shell, the affected tools
get `null` from `getPage()` and — having **no fallback** — throw
`No browser page available`. Before #104 they silently returned the shell's DOM,
so the breakage was masked. #104 made the failure honest; #105 makes the tools
actually work.

`browser_evaluate`, `browser_snapshot`, and `browser_screenshot` already keep
working because they fall back to `sendRpc('browser.evaluate' | 'browser.screenshot')`,
which drives the guest `webContents` directly in the main process
(`browser.rpc.ts`). The RPC route reaches the webview fine; the Playwright-`Page`
route doesn't.

## Affected tools (current `getPage()`-only, no fallback → throw)

| Tool | File | In-page work | Reroutable via `browser.evaluate`? |
|---|---|---|---|
| `browser_extract_text` | extraction.ts | `extractMarkdown` → `page.evaluate(<string>)` returns JSON tree, converted in Node | **Yes, cleanly** — script is already a string |
| `browser_extract_data` | extraction.ts | `extractStructuredData` → 3× `page.evaluate(fn, {fieldNames})`, pure DOM, JSON return | **Yes** — wrap fn+arg as a string expression |
| `browser_smart_snapshot` | extraction.ts | `getSmartSnapshot` → CDP `Accessibility.getFullAXTree` + `innerText` | **Partial** — AX tree needs CDP; use DOM-based fallback over evaluate |
| `browser_highlight` | inspection.ts | `resolveRef` + `el.evaluate(style=...)` | **Yes** — resolve via `[data-wmux-ref]`, set style |
| `browser_console` | inspection.ts | `page.on('console')` streaming listener | **No** — needs main-process CDP event capture (out of scope) |
| `browser_network` | inspection.ts | `page.on('request'/'response')` streaming listener | **No** — same (out of scope) |
| `browser_response_body` | inspection.ts | depends on network listener buffer | **No** — same (out of scope) |

`browser_snapshot` / `browser_screenshot` / `browser_evaluate` already have
fallbacks → **untouched**.

## Goals

1. `browser_extract_text`, `browser_extract_data`, `browser_smart_snapshot`,
   `browser_highlight` work in packaged builds (page-null path) by rerouting
   through the proven `browser.evaluate` RPC channel.
2. **Zero behavior change on the Playwright path** (dev / when `getPage()`
   returns a real page). Extraction output must be byte-identical.
3. No new RPC method, no new IPC surface, no new permission gate — reuse
   `browser.evaluate` (already classified, already proven in packaged builds via
   `browser_evaluate`).
4. RPC-mode refs stay consistent with the existing `data-wmux-ref` system so
   `browser_click` / `browser_type` etc. resolve smart-snapshot refs.

## Non-goals (explicitly out of scope, documented as follow-up)

- `browser_console`, `browser_network`, `browser_response_body`. These rely on
  Playwright's **event-subscription** model (`page.on(...)`). A one-shot
  `browser.evaluate` cannot stream console/network events. Supporting them in
  packaged builds requires a **main-process CDP event-capture subsystem**
  (`Runtime.consoleAPICalled`, `Network.*` listeners buffered on the guest
  `webContents`, drained via new RPC) — a separate feature, not "the same
  fallback evaluate has." They keep their current honest error in RPC mode.
  → File as follow-up issue after #105.

## Design

### Decisions locked (eng review, 2026-06-05)

1. **console/network/response_body → OUT** + file a follow-up issue. They need a
   main-process CDP event-capture subsystem (an ocean, not a lake).
2. **smart_snapshot ref consistency → share the selector constant (option c).**
   Extract the interactive-element selector into a shared
   `INTERACTIVE_SELECTOR` constant; both `browser_snapshot`'s fallback script
   and `getSmartSnapshotViaEval` use it (plus the same `.slice(0,100)` cap and
   `data-wmux-ref=<i>` tagging convention) so the two tools assign identical ref
   indices in RPC mode. `browser_snapshot`'s output stays byte-identical (only
   the inline selector string is replaced by the constant).
3. **extract_data → keep the Playwright path native (option b).** dev path stays
   `page.evaluate(fn, arg)` (zero behavior change, risk isolated); only the RPC
   fallback stringifies via `(${fn.toString()})(${JSON.stringify(arg)})`
   (`.toString()` verified safe: `build-mcp.js` esbuild has no `minify`, and the
   3 functions reference only browser globals + their arg).

### Core abstractions — `src/mcp/playwright/page-eval.ts` (NEW)

Two small transport helpers, both genuinely used:

```ts
export type JsonEvaluator = (expression: string) => Promise<unknown>;

export function pageEvaluator(page: Page): JsonEvaluator {
  return (expression) => page.evaluate(expression);   // page.evaluate(string)
}
export function rpcEvaluator(surfaceId?: string): JsonEvaluator {
  return async (expression) => {
    const r = await sendRpc('browser.evaluate', {
      expression, ...(surfaceId && { surfaceId }),
    }) as { value: unknown };
    return r.value;
  };
}
/** String-script tools (extract_text, smart_snapshot RPC path). Playwright
 *  page if available, else RPC. extract_text's dev path was ALREADY string-based
 *  (buildSerialiseScript), so this is a zero-behavior-change unification. */
export async function resolveEvaluator(
  engine: PlaywrightEngine, surfaceId?: string,
): Promise<JsonEvaluator> {
  const page = await engine.getPage(surfaceId).catch(() => null);
  return page ? pageEvaluator(page) : rpcEvaluator(surfaceId);
}

/** Function+arg tools (extract_data, decision b): native page.evaluate(fn,arg)
 *  when a page exists, else stringify the fn for the RPC channel. */
export async function evalFunctionOrRpc<A, R>(
  page: Page | null, fn: (arg: A) => R, arg: A, surfaceId?: string,
): Promise<R> {
  if (page) return (await page.evaluate(fn, arg)) as R;
  const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
  const r = await sendRpc('browser.evaluate', {
    expression, ...(surfaceId && { surfaceId }),
  }) as { value: R };
  return r.value;
}
```

### Per-tool plan

**`browser_extract_text`** — refactor `markdown-extractor.ts`:
- Split `extractMarkdown(page, opts)` into:
  - `buildSerialiseScript(...)` (already exists, returns string) — unchanged.
  - `treeToMarkdown(tree, opts)` (NEW pure Node fn) — the existing
    `convertNode` + `cleanMarkdown` body, extracted.
  - `extractMarkdown(evaluate: JsonEvaluator, opts)` — `const tree = await
    evaluate(script); return treeToMarkdown(tree, opts)`.
- Tool: `const evaluate = await resolveEvaluator(engine, surfaceId); const md =
  await extractMarkdown(evaluate, {...})`. Drop the `if (!page) throw`.
- Fidelity: identical — conversion was always Node-side; in-page part was always
  a string.

**`browser_extract_data`** — refactor `markdown-extractor.ts` (decision b):
- Keep the 3 in-page functions (`extractFromTables/Lists/RepeatedElements`) as
  real functions. Route each through `evalFunctionOrRpc(page, fn, {fieldNames},
  surfaceId)`: dev path runs `page.evaluate(fn, arg)` **unchanged**; RPC path
  stringifies `(${fn.toString()})(${JSON.stringify(arg)})`.
  - **Security:** `fieldNames` is user-supplied (`Object.keys(fields)`). It is
    embedded **only** via `JSON.stringify` (data literal, cannot break out to
    code). No template interpolation of raw values. No fetch/cookie/storage in
    the scripts → no `detectDangerousPatterns` concern (the RPC handler doesn't
    gate; the gate is at the `browser_evaluate` tool layer for user expressions).
- `extractStructuredData(page, surfaceId, goal, fields)` — signature gains
  `page: Page | null` + `surfaceId`; runs the 3 strategies, first non-empty wins
  (unchanged order).
- Tool: `const page = await engine.getPage(surfaceId).catch(()=>null); const
  records = await extractStructuredData(page, surfaceId, goal, fields);`

**`browser_smart_snapshot`** — branch in the tool, add to `dom-intelligence.ts`:
- Keep `getSmartSnapshot(page, opts)` (CDP AX tree) for the Playwright path —
  **unchanged**, preserves full accessibility fidelity in dev.
- Add `getSmartSnapshotViaEval(evaluate, opts)` (NEW): one injected script that
  tags interactive elements with `data-wmux-ref="<i>"` and returns
  `{ url, title, content, elements:[{ref, role, name, value?, description?}] }`.
  Refs are the `data-wmux-ref` indices, so `browser_click({smartRef})`'s RPC
  fallback (`[data-wmux-ref="<n>"]`) resolves them. Lower role fidelity than the
  AX tree (tag/role heuristic), the accepted packaged-mode degradation.
- Tool: `const page = await engine.getPage(surfaceId).catch(()=>null); const
  snap = page ? await getSmartSnapshot(page, o) : await
  getSmartSnapshotViaEval(rpcEvaluator(surfaceId), o);` then the existing
  formatter.
- **Ref-consistency (locked: option c, corrected by codex):** extract the
  interactive-element selector to a shared `INTERACTIVE_SELECTOR` constant
  (exported from `dom-intelligence.ts`). `browser_snapshot`'s fallback script
  interpolates the constant (output byte-identical); `getSmartSnapshotViaEval`
  reuses it (same `.slice(0,100)` cap). We share **only the selector** (which
  elements are interactive) — **NOT the numbering base.** `getSmartSnapshot` is
  **1-based** (`dom-intelligence.ts:123`, `getLocatorByRef` does `ref-1`);
  `browser_snapshot` tags `data-wmux-ref` **0-based**. So `getSmartSnapshotViaEval`
  stays **1-based** and tags `data-wmux-ref="<ref>"` with the SAME 1-based number
  (do NOT copy browser_snapshot's 0-based tagging). Refs do not align across the
  two tools (separate `ref` vs `smartRef` namespaces, ephemeral per the
  "re-snapshot for current refs" model) — that's fine.
- **elementCache MUST be populated (codex finding 1):** `browser_click({smartRef})`
  uses `getLocatorByRef(smartRef)` **whenever a page exists**
  (`interaction.ts:113-121`) and only falls to `[data-wmux-ref]` when page is null
  (`:141-143`). `getPage()` can flip null→page within a session (`playwrightFailed`
  resets, `PlaywrightEngine.ts:363`). So a snapshot taken in RPC mode whose click
  lands after recovery would miss the cache. Fix: `getSmartSnapshotViaEval` sets
  `elementCache = elements` with each `locator = '[data-wmux-ref="<ref>"]'`. That
  selector resolves in BOTH modes — page path: `page.locator('[data-wmux-ref="<ref>"]')`
  (the RPC snapshot's attributes persist in the same webview DOM); RPC path:
  `String(smartRef)` → `[data-wmux-ref="<ref>"]`. 1-based throughout, consistent.

**`browser_highlight`** — add RPC fallback in `inspection.ts` mirroring
`browser_hover`'s existing fallback:
- `page` path unchanged. Else: `sanitizeRef(ref)` → `sendRpc('browser.evaluate',
  { expression: querySelector('[data-wmux-ref="<ref>"]') + set outline })`,
  map `not_found` → `refNotFound`-style error.
- **`sanitizeRef` is currently private to `interaction.ts` (codex finding 6).**
  Export it from `interaction.ts` and import in `inspection.ts` (one-way edge,
  no cycle — verified neither imports the other today). Highlight MUST sanitize
  (the ref is interpolated into a CSS selector inside injected JS).

**Drive-by hardening (codex finding 6a):** `browser_scroll`'s RPC fallback
(`interaction.ts:559-560`) interpolates `ref` raw into the selector — the lone
sibling that skips `sanitizeRef` (hover/drag/select/scroll_into_view all
sanitize). 1-line fix to match its siblings, same `sanitizeRef` pattern this PR
formalizes. Documented as drive-by in the PR; trivially droppable if unwanted.

### Files touched

| File | Change |
|---|---|
| `src/mcp/playwright/page-eval.ts` | **NEW** — `JsonEvaluator`, `pageEvaluator`, `rpcEvaluator`, `resolveEvaluator` |
| `src/mcp/playwright/markdown-extractor.ts` | refactor to `JsonEvaluator`; extract `treeToMarkdown`; string-script builders for structured data |
| `src/mcp/playwright/dom-intelligence.ts` | export `INTERACTIVE_SELECTOR`; add `getSmartSnapshotViaEval` (1-based, populates `elementCache`) |
| `src/mcp/playwright/tools/extraction.ts` | extract_text → `resolveEvaluator`; extract_data → `evalFunctionOrRpc`; smart_snapshot → page?AX:eval branch; drop throws |
| `src/mcp/playwright/tools/inspection.ts` | `browser_highlight` RPC fallback (uses `sanitizeRef`); `browser_snapshot` uses shared `INTERACTIVE_SELECTOR` |
| `src/mcp/playwright/tools/interaction.ts` | export `sanitizeRef`; harden `browser_scroll` RPC fallback with it (drive-by) |
| `src/mcp/playwright/__tests__/markdown-extractor.test.ts` | **NEW** unit tests (mock evaluator) |
| `src/mcp/playwright/__tests__/page-eval.test.ts` | **NEW** unit tests (mock `sendRpc` / page) |
| `src/mcp/playwright/__tests__/dom-intelligence.test.ts` | **NEW** unit tests for `getSmartSnapshotViaEval` |

## Test strategy

No real browser needed — the Node-side logic is isolated behind `JsonEvaluator`:
- `markdown-extractor.test.ts`: feed a canned `SerializedNode` tree → assert
  markdown (headings, links, tables, truncation). Feed canned table/list/
  repeated results → assert `extractStructuredData` picks the right strategy and
  shapes records.
- `page-eval.test.ts`: `rpcEvaluator` calls `sendRpc('browser.evaluate', {...})`
  and unwraps `.value`; passes `surfaceId` only when set. `pageEvaluator`
  delegates to `page.evaluate`.
- `dom-intelligence.test.ts`: `getSmartSnapshotViaEval` with a mock evaluator
  returning a canned payload → assert SmartSnapshot shape + ref indexing.
- Full suite: `npx vitest run` must stay green (one pre-existing failure,
  `security.test.ts > secureWriteTokenFile`, is environment-specific — non-ASCII
  dev username — and unrelated; CI is green).
- Typecheck/build: `tsc -p tsconfig.mcp.json --noEmit` + `npm run build:mcp`.

## Risks / trade-offs

- **`smart_snapshot` RPC degradation:** roles come from tag/`role`-attr heuristic,
  not the CDP AX tree. Acceptable — only on the page-null (packaged) path; dev
  keeps full fidelity. Documented in the tool output is unnecessary; behavior is
  a superset of "throw".
- **No new RPC method:** intentionally reuses `browser.evaluate`. Means
  `browser.evaluate` RPC must be available — it is, and is the exact channel
  #104's verification proved working in packaged builds.
- **extract_data dev path stays native (decision b):** Playwright keeps
  `page.evaluate(fn, arg)` (zero behavior change). Only the RPC fallback uses
  `(${fn.toString()})(${JSON.stringify(arg)})`. `.toString()` is safe here:
  esbuild (`build-mcp.js`) sets no `minify`, and the 3 functions reference only
  browser globals (`document`, `Map`, `CSS`) + their arg (no module refs/closures).
- **RPC 10s timeout on huge pages (codex finding 3):** `extractMarkdown`
  transfers the full serialized DOM tree before Node-side truncation, and the RPC
  client has a hard 10s timeout (`wmux-client.ts:7`) the Playwright/CDP path does
  not. On a pathological multi-MB DOM the RPC path may time out where Playwright
  would survive. Accepted: the common case works and "times out" is still better
  than the current "always throws"; the dev path is unaffected. Future hardening:
  a node-count/depth cap inside `buildSerialiseScript` (deferred — it would alter
  the dev path's output, which decision b protects).
- **`browser_snapshot` RPC fallback ignores `format` (codex finding 4):** the
  existing fallback always returns the custom DOM summary, never the ARIA tree
  (`format:'aria'` only honored on the Playwright path). Pre-existing, NOT
  introduced here; #105 only swaps its inline selector for the shared constant.
  Noted as a possible follow-up, out of scope.
- **`clear`-buffer tools untouched:** console/network/response_body still throw
  in RPC mode (documented non-goal → follow-up issue).

## Verification (packaged)

The fix rides the `browser.evaluate` RPC path that `browser_evaluate` already
exercises successfully in packaged builds (junbeom09, #104). Unit tests cover
the Node-side conversion. A full packaged smoke test (`browser_extract_text` /
`browser_smart_snapshot` on a real page in a `npm run make` bundle with a fresh
daemon) is the highest-value manual check — request from @junbeom09 (has the
setup) or run locally before merge. **Do not merge before that packaged
verification.**

## Review record

- **Eng review (plan-eng-review):** Step 0 scope challenge + Architecture / Code
  Quality / Tests / Performance. 3 decisions surfaced + locked (console/network
  scope-out, ref-consistency option c, extract_data option b). No critical
  architecture gaps.
- **Codex review (gpt-5.5, read-only, high reasoning):** 6 findings, all
  incorporated — (1) smart_snapshot elementCache mode-flip bug → populate cache;
  (2) 1-based vs 0-based ref numbering → keep 1-based, share selector only;
  (3) RPC 10s timeout on huge pages → documented; (4) browser_snapshot fallback
  ignores `format` → pre-existing, noted; (5) plan self-contradiction on dev path
  → fixed; (6) `sanitizeRef` private + `browser_scroll` raw interpolation →
  export + drive-by harden. Security (fieldNames via JSON.stringify) confirmed safe.
