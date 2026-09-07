# Dogfood handoff — 3.49.3 browser stack

Written 2026-09-01. For the next session: what to exercise in real daily use once
3.49.3 is installed, and what to look for. Everything below already passed
synthetic dogfooding on an isolated instance; what is untested is **real use over
days**, which is exactly what the remaining questions need.

## Preconditions

1. Release PR #1155 (`chore(release): 3.49.3`) merged, tag `v3.49.3` pushed,
   installer built, and the **installed app updated** — the daemon/main half of
   these features (ActionCacheStore, promote/demote RPC, PromotedSkillStore,
   sweep) lives in the app, not in the MCP bundle. A dev rebuild alone gives you
   only the MCP half and `browser.actionCache.*` calls will be refused by the
   older main.
2. `browser_replay` and promoted flows need the **chrome backend**. The builtin
   webview falls back to a DOM snapshot with no accessibility refs, so every
   recorded step becomes an unrecordable hole. Switch the workspace's backend
   before recording anything.

## What shipped (five PRs, all merged)

| PR | Feature | What to watch in real use |
|---|---|---|
| #1145 | Popup notice on click, file-input proximity search, page-facts footer (scrollable containers, loading hints) | Are the loading hints ("nearly empty", "skeleton screen") accurate on real sites, or noisy? The thresholds (interactive <10 AND text <200) were tuned synthetically. |
| #1146 | `browser_click` x/y with an explicit coordinate contract; screenshot states its coordinate basis | Does the DPR wording actually prevent mis-clicks when you work from screenshots? |
| #1149 | Frame-aware refs; iframe and OOPIF grafting | Payment/login/map widgets: do refs inside third-party frames resolve? Watch for false `StaleRefError`s on pages with many same-src iframes, and for snapshot bloat on ad-heavy pages (frame content shares a 40% budget pool). |
| #1150 | Action recording ring + `browser_replay` (list/save/run/forget) | The savings claim is "replay exposes no snapshot text". Confirm that repeat work on a familiar site actually feels cheaper, and that `sameNameIndex` matching survives real page churn. |
| #1153 | `promote`/`demote`, permanent flows in `~/.wmux/promoted-skills`, `[skill]` hints on navigation | **The main open question.** Are the hints useful or noise? |

## Round 1 results (2026-09-02, live on the installed 3.49.3)

Two defects, both invisible to every synthetic test. Fixed and merged; they
need a patch release before the rest of this dogfood can proceed.

- **#1158 — `browser_replay` was dead in every shipped build.** Every action,
  `list` included, was refused as "plugin is unconfirmed" because the eight
  `browser.actionCache.*` methods were missing from `FIRST_PARTY_METHODS`. Dev
  builds do not enforce that lane, which is why the feature passed its tests
  and its synthetic dogfood. The guard test that exists to catch exactly this
  scanned only `callRpc`/`sendRpc` and never saw `sendScopedBrowserRpc`;
  widening it surfaced a second unlisted method, `browser.lifecycle.get`,
  whose silent failure had been dropping navigation events on the builtin
  backend. **Lesson: features gated by first-party enforcement cannot be
  validated on a dev build at all.**
- **#1159 — the skeleton hint fired on every application UI.** A fully
  rendered GitHub pull-request list (954 chars / 1226 elements,
  `readyState: complete`) was reported as "skeleton screen likely". Density
  separates document-shaped pages from app-shaped ones, not loaded from
  loading — Node docs read 8.39 chars/element against GitHub's 0.78. The
  verdict is now gated on in-flight requests. Answers question 3 below.

Still unanswered: everything that needs `browser_replay` to actually run
(questions 1, 2, 4). Resume after the next patch release + app update.

## Priority questions this dogfood should answer

1. **Is the `[skill]` navigation hint worth its cost?** It fires on every
   landing on a URL that has promoted flows, capped at 3 lines plus a summary.
   Track: how often it fires, how often you (or the agent) actually act on it,
   whether it ever fires where it's irrelevant. If it reads as noise, the fix is
   a narrower trigger, not a rewrite — the plumbing is deterministic.
2. **Does replay hold up against real page churn?** Synthetic tests changed one
   button label. Real sites re-order lists, A/B test, and lazy-load. Watch for
   the failure *mode*: a clean "stopped at step N, here's why, take over live"
   is the designed behavior; a silently wrong element is a bug worth filing.
3. **Do the page-facts loading hints misfire?** They were calibrated on
   fixtures. Article pages, dashboards, and SPAs are the interesting cases.
4. **Is the promotion gate (3 successful runs) the right bar?** Too strict means
   nothing ever gets promoted; too loose means junk flows earn permanent hints.

## Do not automate search engines

Google flags the whole public IP on repeated automated searches ("unusual
traffic" reCAPTCHA) — it hit the owner's own Chrome on 2026-09-01 from an
unrelated source. Replay/promoted flows must never target google.com search
pages; use local fixtures or sites you own for repetition tests.

## Known limitations (documented, not bugs)

- Same-URL frame re-creation and frame re-ordering mid-capture can produce a
  stale-ref error rather than a correct resolve. Worst case is a refusal, never
  a wrong click.
- Promoted flows are workspace-scoped; a flow promoted in workspace A is not
  visible to B.
- Non-password typed values are stored in plaintext in promoted records —
  parameterize sensitive values as `{{var}}` before promoting.
- Trace TTL is 30 days, 40 traces per workspace, LRU. Promotion is what makes a
  flow survive that.

## Open follow-ups (not blocking dogfood)

- **Issue #1151** — an isolated instance (`WMUX_DATA_SUFFIX`) still rewrites the
  production `~/.claude.json` MCP registration. Hit twice during dogfooding and
  restored by hand both times. Fix before the next isolated-instance run.
- `browser_navigate` returns `BROWSER_NO_TARGET` when no surface exists;
  `browser_open` first is required. Friction, not a defect.
- Not adopted: browser_exec-style tool compression (browser_* is 40 tools; the
  full profile has ~1.8 KB of budget headroom left). Would need its own plan.

## Isolated-instance harness (if you need to reproduce something without touching daily state)

Established across three dogfood rounds; each line below cost a failed attempt:

- `WMUX_DATA_SUFFIX=-<name>` drives the data dir (`~/.wmux-<name>`) and the
  userData dir (`~/Library/Application Support/wmux-<name>`). Do **not** rely on
  `--user-data-dir`; it is ignored.
- Launch with `nohup npx electron .`, not `electron-forge start` — the forge
  wrapper detaching kills its electron child.
- `npx vite build` overwrites `dist/`, wiping `dist/mcp-bundle`. Re-run
  `npm run build:mcp` after it. Dev server needs `--host 127.0.0.1` (default
  `::1` fails the main process's localhost load).
- Chrome backend: write `{"backend":"chrome"}` to the instance's
  `browser-backend.json`, restart, and close any existing surface (a reused
  surface stays builtin).
- The MCP client must send `clientInfo.name: "claude-code"` — other names are
  refused as non-first-party, which looks like a scope error but is not.
- Scrub `CLAUDE*` / `ANTHROPIC*` / `AI_AGENT*` from the spawned environment and
  inject only the isolated instance's ids.
- Snapshot refs live in the MCP process's memory: snapshot and click must happen
  in the same session. Promoted flows survive restarts; traces survive as long
  as the app-side cache file does.
