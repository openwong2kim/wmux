# UX dogfood — 2026-09-05 (after the design-audit lanes)

Build under test: packaged local build of main `7d1e5968` = DESIGN.md decisions (#1218) + lane U2 type/colour system (#1220) + lane U1 status vocabulary / sidebar summary / approval renditions / titlebar gauges (#1219) + lane U3 hit areas / accessible names / copy diet (#1221). Isolated instances: `WMUX_DATA_SUFFIX=-demo` (the long-lived dogfood data, 12 open tasks from the orchestrator runs) for the before/after comparison and scenario (b); a fresh `WMUX_DATA_SUFFIX=-demo2` for scenario (a). Viewport 1280×800 CSS px, DPR 2. Metrics are DOM measurements over CDP (`scratchpad/ux-metrics.mjs`); screenshots in the session scratchpad.

## Before → after (same screen, same data)

| Metric | 2026-09-05 baseline (main `024588c1`) | After (main `7d1e5968`) |
|---|---|---|
| UI font families | `system-ui`, ui-monospace, Cascadia Code | **Inter**, ui-monospace, Cascadia Code |
| Distinct text sizes on screen | 11 (8, 9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 16) | 6 (10, 11, 12, 13, 14, 16) — 12 px is the deliberate leftover (owner decision pending), 16 px is the terminal |
| Interactive elements under 24 px | 66 | 19 (see below) |
| Icon buttons with no accessible name | settings gear + 3 unlabeled | 0 |
| Amber-coloured DOM nodes (text/fill/border) | inline code spans in the transcript, Mode pill | 0 |
| Sidebar task rows | 12 rows + 12 green dots | one line `TASKS · 12 OPEN · CLEAN UP` |
| Deck task panel | all rows, scrolling | 5 rows + `+7 more`, row title jumps to the task workspace, `#` opens its channel |
| Titlebar | `553MB 09:22` always | nothing (memory chip only above threshold, clock off by default) |
| Mode control | red-tinted bordered pill | text + 8 px red dot |

Remaining <24 px targets (19): the deck task panel rows (title buttons, `#` jumps — U1 built these after U3's shared glyph was dropped, so they did not adopt the hit-area recipe), the `+N more` toggle, the sidebar `TASKS` line and `CLEAN UP`, the Mode / Loop / Schedules chips (27 px tall, 23 px wide for "Loop"), the briefing row and its "Jump to shell". All are height-bound by the 26–30 px row density; the recipe exists (`hitArea.ts`) and applying it to the deck rows is a one-lane follow-up.

## Scenario (b) — approval waiting, timeout, pending decision

Steps: from the owner pane, `fanout_start` × 2 with nobody approving; watch the deck; let the 45 s window expire.

| Step | Expected | Observed |
|---|---|---|
| Fan-out requested | one dialog + one countdown elsewhere | dialog with `auto-deny in 21s` + deck footer `Auto-reject in 21s` (Fleet inbox not on screen, so the deck badge is the second rendition) — **2 renditions, per contract** |
| Owner workspace had a pending decision | the caller is told | `fanout_start` reply led with `WARNING: owner workspace … has a pending decision …; worker events will not wake the brain until it is answered` |
| 45 s expiry | the UI says the request was denied and why | **nothing.** The dialog closes, the deck shows `BRIEFING 1 running.`, no toast, no line in the transcript, no channel post; only the main log says `fan-out … denied (timeout)`. From the operator's chair the fan-out simply never happened |
| Stale parked-work decision | asked once | the `A request from before this wmux session is still on the books. Resume it, or drop it?` card is raised again on **every** app launch while the record is parked; answering it (Drop it) on a previous run did not remove the parked work, so it came back |

## Scenario (a) — new user to first fan-out (fresh data dir)

Click count from first launch to the Multi Task dialog: **8** (wizard `Skip for now` → update prompt `No thanks` → tour `Skip` → `Expand dock` → Agent tab → `Mode:` → `Danger` → `Multi Task`), plus prompts and `Spawn`. Observations:

| Step | Observed |
|---|---|
| First launch | four onboarding surfaces stack within seconds: the first-run wizard, the automatic-updates prompt, then a 4-step tour, then a keyboard cheat sheet pinned bottom-right — each with its own dismiss control |
| Wizard | checks Claude Code / MCP / hooks and offers **"Try a sample task"** (a 2×2 split web search). Nothing in it leads to the orchestrator, the deck, or fan-out — the product's differentiator is not on the first-run path. The whole wizard renders in the mono face (prose should be Inter per DESIGN.md) |
| Deck on a fresh install | `BRIEFING · Welcome back. The agent is idle.` — "Welcome back" on a first run; Mode is `Off` with no hint that turning it on is how the orchestrator starts |
| Model picker | the `Default / Opus / Sonnet / Haiku` dropdown under the Agent tab stayed open over the deck after the tab click, covering the ledger panel until dismissed |
| Multi Task | opens (not `role=dialog`, so a screen reader is not told), defaults N=2, `no role` per task, `wtask/task-N` branch preview, 8192-byte counter. The workspace's cwd is `~` (not a git repository) and the dialog gives no warning before `Spawn 2` — the fan-out will be refused at submit time |

## Findings

1. **A denied or expired approval is invisible.** The 45 s auto-deny leaves no trace in the UI. Fix shape: a transcript line and a toast (`Fan-out denied: nobody answered in 45 s`) from the same path that logs `denied (timeout)`; the decision card pattern already exists for the brain, reuse it for the operator.
2. **The parked-work decision is re-raised on every launch** and "Drop it" does not clear the parked record. Fix: dropping must complete/clear the work record; the resume prompt should be raised once per record.
3. **First-run stacking.** Four surfaces compete on the first screen; fold the update prompt and the cheat sheet into the wizard (one step each) and make the tour a wizard option.
4. **The wizard never mentions the orchestrator.** Add a third card "Turn on the orchestrator" that sets Mode and opens the deck, or make the sample task a fan-out of two tiny tasks in a scratch repo.
5. **Wizard typography** is mono for prose; **"Welcome back" copy** on first run.
6. **Multi Task from a non-repository cwd** should say so before Spawn (the check exists server-side already).
7. **Deck task-panel rows** did not receive the 24 px hit-area recipe (19 small targets remain).
8. **12 px** is still on screen (47 nodes): decide whether to add it to the ramp or migrate to 11/13.

## What this run proves

The four contract decisions from the audit are visible on the packaged build (Inter, the four-step scale, one dot vocabulary, sidebar as navigation, two approval renditions, no dead gauges), and the measured surface improved on every metric (66 → 19 small targets, 11 → 6 text sizes, amber budget respected). The flow findings above (1–6) are the next design work; none of them is a regression from these PRs.
