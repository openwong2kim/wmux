# Design System — wmux ("Bridge" redesign, 2026-07-11)

> SSOT for all visual/UI decisions. Read this before making any visual change.
> Token *values* live in `src/renderer/themes.ts`; this file defines the roles,
> rules, and layout contracts those tokens serve.

## Product Context

- **What this is:** a Windows-first terminal multiplexer for AI coders — runs many
  terminal-based coding agents (Claude Code, Codex, …) in parallel, with an
  orchestrator brain, channels, and reboot-surviving supervision.
- **Who it's for:** developers running fleets of CLI agents who need to steer,
  supervise, and inspect them without losing raw-terminal ground truth.
- **Identity decision (owner, 2026-07-11):** **terminal-first**. Real terminals are
  the protagonist; chrome recedes and frames. We deliberately do NOT become a
  chat-first (Conductor) or dashboard-first app.

## Design Thesis

**"The calm command bridge for a fleet of terminal agents."**
A dim, warm-graphite cockpit where a single amber is the only lit instrument.
Terminals are the bridge's windows (the hero). Premium feel comes from warmth,
1px hairlines, tight radii, and type discipline — never from gradients,
glows, or effects. (Lineage: orca's "recede and frame", Warp's warm-minimal
discipline, Zed's quiet chrome, Codex's instrument footer.)

## Window Chrome (the "app, not a webpage in a window" layer)

- **No native menu bar visible.** `autoHideMenuBar: true` (Alt still reveals;
  accelerators keep working). The File/Edit strip was the #1 "looks like a
  plain window" offender.
- **Custom titlebar, 36px** (border-box). `titleBarStyle: 'hidden'` +
  `titleBarOverlay: { color: <bgMantle>, symbolColor: <textSub>, height: 36 }`
  so Windows draws native snap-layout-capable window controls in theme colors.
- Titlebar contents: left segment (app mark + workspace name) is **tinted
  `--bg-mantle` and width-matched to the sidebar** so the top-left reads as one
  continuous panel with the sidebar (orca cue). Center stays **empty = drag
  region** (`-webkit-app-region: drag`; interactive children get `no-drag`).
  No search box in the titlebar (owner decision).
- `BrowserWindow.backgroundColor` must match the active theme's `bgBase`
  (no white flash on launch).
- The titlebar bottom divider is an inset hairline, not a border (keeps the
  36px content box exact).

## Layout Contract

```
┌ titlebar 36px ──────────────────────────────────────────────┐
│ [mantle: mark + workspace]      (drag)      [native overlay] │
├───────────┬──────────────────────────────────┬──────────────┤
│ sidebar   │  terminal grid  (THE HERO,       │ mission      │
│ 240px     │  largest area; focused pane =    │ control      │
│ workspaces│  steel tab-strip underline)      │ ~326px       │
│ ONLY      │                                  │ ┌ tabs ────┐ │
│ (mantle)  │                                  │ │icon tabs │ │
│           │                                  │ ├ Fleet ───┤ │
│           │                                  │ ├ Orch ────┤ │
│           │ [agent bar — overlay, on hover]  │ └ busy bar ┘ │
└───────────┴──────────────────────────────────┴──────────────┘
     (deck collapsed → that column is gone; reopen from the titlebar)
```

- **Left sidebar = navigation only** (workspaces). Agents do NOT live here —
  and neither do the deck's entry points: Agent · Git · Channels · web are
  glyphs on the deck's own 36px header strip, never labeled rows at the
  sidebar's foot (owner decision 2026-08-14). **Collapsed, the deck renders
  nothing on that edge at all** — one toggle beside Settings in the titlebar
  opens it (2026-08-18).
- **Right column = mission control** (one pillar): **Fleet** (agent roster:
  status dot + name + mono activity line + jump `→`), then **Orchestrator**
  thread, busy bar at bottom. Channels is a sibling tab. Rationale: agents ↔
  the brain that commands them ↔ their channels are ONE system; splitting them
  across both edges made them feel unrelated (owner feedback, 2026-07-11).
- **Fleet vitals = appearing chips in the titlebar status strip** («N running»
  amber dot · «N need you» danger, click = jump to the most urgent pane).
  They render ONLY when nonzero — no dead gauges, no extra chrome row.
  (Owner decision 2026-07-12: the always-on bottom instrument strip read as
  dead chrome at "0 running" and was removed the same day it landed.)
- **Agent verbs = one workspace-spanning bar, overlaid on the grid's bottom
  edge and revealed on approach** (owner decision 2026-08-18, reverting the
  2026-08-15 split). It takes no layout row, so no PTY is resized when it
  appears and the grid keeps its full height. Because it sits exactly where the
  terminal's prompt line lives, the reveal is guarded — a dwell delay,
  suppressed under a held pointer button and on keystrokes, and a keep-alive
  band as tall as the bar. The bar's own background is `pointer-events: none`
  and only its controls claim a hit area, so the two terminal rows it floats
  over keep their clicks and text selection. A pin toggle makes it the plain
  always-on strip; ⌘K carries the fan-out and pin commands so a minimal chrome
  preset (bar off) still reaches them.
- The terminal grid always gets the largest area. Any new surface must justify
  itself against "does this shrink the hero?"

## Color

- **Approach:** restrained. Warm graphite neutrals + a warm amber + a cool
  steel-blue counter-accent. Values are the `amber` theme tokens in `themes.ts`
  (`bgBase #151517 · bgMantle #19191C · bgSurface #202024 · textMain #EFEEEC ·
  textSub #A5A29C · textMuted #66645F · accent #E8A33D · accentSecondary
  (--accent-blue) #6E9BC4 · success #8FBF7F · danger #D96C6C`).
- **Two-accent grammar (owner 2026-07-15) — warm amber vs cool steel, each with
  ONE job.** Splits what was previously amber-overloaded ("alive AND focus AND
  links AND warning") so each color says exactly one thing:
  - **Warm accent (`--accent`, cursor variant `--accent-cursor`) = alive +
    attention + action:** running dots, spinners, terminal cursor, warning,
    "needs you" emphasis, unread badges, the footer model name — AND primary
    action (CTA) buttons. Actions are warm because pressing one makes the
    system DO something (alive), not GO somewhere (nav). A solid warm fill is
    reserved for the single primary action of a surface + tiny count badges;
    everything else warm is dots/rings/text. Budget: **5±2 warm meaning-points
    per screen** (dots of the same class count as one system).
  - **Steel-blue `--accent-blue` #6E9BC4 = navigation + interactive:** links,
    jump affordances, active-tab underline, focused-pane edge, focus rings,
    selection highlight. Reads as "where you are / what you click." An even
    quieter counter-accent than amber; **never fills areas** (same no-wash rule).
  - Focus moved from amber → steel (it's a "where you are" cue, not an "alive"
    one). The single `accentSecondary` token drives all of steel, so the hue is
    a 1-line change like the primary accent.
  - **Every theme carries the split** (`--accent` warm / `--accent-blue` cool):
    amber, nightowl, stars-and-stripes, taegeuk got dedicated cool/warm
    counterparts; catppuccin, red-dynasty, hinomaru already shipped two-tone;
    monochrome and void are exempt (colorlessness is their identity).
  - **Alive ≠ warning:** a theme's running/cursor hue must be perceptibly
    distinct from its warning hue (stars-and-stripes alive `#E89B4A` vs warning
    `#F2C85B`; taegeuk alive `#B87500` vs warning `#9B6A07`) so "running" never
    reads as "caution". Amber theme is the deliberate exception (one lit
    instrument: warning IS the amber).
- **No area washes.** Amber never fills areas. The only permitted wash is the
  danger `needs input` row. Accent may *expand* on hover only (links, AI-action
  buttons); at rest they are neutral.
- **Attention (danger) grammar:** one event = max 2 renditions (the evidence
  row + the global footer chip). Never three.
- **Terminal content owns its ANSI palette** (`amber-graphite` terminal theme):
  diffs/success are green, errors red — never theme-accent-colored. This keeps
  the hero visually separate from the chrome.
- **Hue is swappable by design:** the entire focus/accent identity hangs on the
  single `accent` token. Candidate alternates evaluated 2026-07-11: copper
  `#E08A57`, violet `#9E8CFF`, cyan `#5FB6C9`, green `#8FBF7F`. Amber kept for
  now; revisit freely — it is a 1-line change plus themes.
- Dark is primary. Light themes (hinomaru/taegeuk) follow the same grammar.

## Typography

- **UI/prose:** Inter (400/500/600). **Logs/paths/tool lines/terminal:** mono
  (Cascadia Code / JetBrains Mono). Rule: *prose in sans, logs in mono* — a
  mono line signals "machine evidence", a sans line signals "someone talking".
- Scale: 10px uppercase section labels (600, +0.09em) · 11px meta/tool lines ·
  13px body · 14px titles. Tabular figures for counters. **These four steps
  are the whole scale** (2026-09-05): no 8/9/10.5/11.5/12.5px anywhere in
  chrome — a lint rule forbids them. Inter is bundled (400/500/600) so the
  stack never falls through to `system-ui`.
- **Hierarchy from typography, not decoration.** Speaker labels differ by
  weight/color (You = muted 600, Orchestrator = main 700), not by accent color.

## Spacing & Geometry

- **36px chrome module.** Every horizontal chrome row — titlebar, sidebar
  header/footer, pane tab strip, deck tabs — is exactly 36px
  (`h-9`) so hairlines across the three columns land on the same y. A new
  chrome row must justify deviating from the module. The workspace-spanning
  agent toolbar keeps the module but **spends none of it**: it overlays the
  workspace column instead of taking a row (2026-08-18), so the terminals
  never lose the height and no PTY is resized when it appears.
- Base unit 4px. Density: compact-leaning (rows 26–30px). **Every interactive
  element has a hit area of at least 24×24px** (2026-09-05) — extend the hit
  area with padding or a pseudo-element, never the glyph.
- Radii: **5px buttons/controls · 6px inputs · 7px cards/panels**. Never larger
  on chrome. Full-round only for status dots and count badges.
- Borders: 1px hairline `rgba(255,255,255,.06)` (dark). Panel seams via inset
  box-shadow hairlines, not borders.
- Elevation: exactly 3 levels (flat hairline / subtle surface lift / one
  floating shadow for popovers). Don't add a fourth.

## Component Rules

- **Tool calls render as flat mono log lines,** never boxed chips: status glyph
  (`●` running amber / `✓` ok green / `✕` error red) + tool name + one-line
  arg summary + right-aligned jump link (muted at rest, accent on hover).
- **Every claim is one click from its evidence:** anything referencing a pane
  gets a jump affordance (litmus test inherited from the deck).
- **gpui-style control surfacing (2026-07-15):** two physical treatments only.
  *Raised* (buttons, active segments, menu-item hover chips, cards): faint
  surface fill + 1px `color-mix(text-main 10%)` hairline + **top 1px inset
  highlight** (`inset 0 1px 0 color-mix(text-main 6%)`) — the "machined" look;
  press = 0.5px sink. *Recessed* (inputs, search): slightly-darker-than-base
  fill + inset shadow + **cool focus ring** (`--accent-blue` border + 3px 22%
  ring). All values via color-mix on tokens so every theme inherits them.
- **Primary action = solid warm fill** (`--accent` bg, `--bg-base` text, top
  inset highlight): the one filled button per surface. Secondary = raised
  neutral. Destructive = red tint at rest, solid red only for final confirm.
- Toolbar buttons are text-first, boxless until hover; hover shows a soft
  raised chip (not a color change alone). AI-directed actions (fan-out,
  broadcast) stay neutral at rest.
- No emoji glyphs in chrome; use monochrome glyphs/icons only.
- Status dot vocabulary: amber = running · green = ok/idle-complete · gray =
  idle · red = needs input (with wash).

## Motion

- Minimal-functional. Spinners and blink-cursor are the only perpetual motion.
- Transitions ≤150ms ease-out, only for state changes (hover, expand, theme
  swap suppressed during switch).

## References

- Approved mockup: `designs/redesign-20260711-bridge/wmux-redesign-mockup.html`
  (interactive: layout/hue/accent/density/theme toggles) + `mock-dark-v3.png`
  (the approved rendition).
- Prior tokens: `designs/design-system-20260711/wmux-FINAL-amber.html` →
  encoded in `src/renderer/themes.ts` (amber theme, #405/#406).
- Research (2026-07-11): orca (custom 36px titlebar, sidebar-tinted top-left,
  reserved AI-accent), Warp (warm-minimal recipe, drag-region caution), Zed
  (positionable window controls, quiet chrome), Codex (status-line footer,
  approval as first-class), Cursor (agents-as-tabs + status column),
  Conductor (notification-driven supervision), Paperclip (approvals inbox).

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-11 | Terminal-first + premium chrome (not chat-first, not dashboard) | Raw-terminal ground truth is the moat; chrome was the gap |
| 2026-07-11 | Custom titlebar 36px, `autoHideMenuBar`, `titleBarOverlay`, no titlebar search | File/Edit strip killed the app feel; center = drag region (Warp cautionary tale) |
| 2026-07-11 | Unified mission control (Fleet + Orchestrator + Channels in right pillar; sidebar = workspaces only) | Agents/orchestrator/channels felt disconnected split across edges (owner feedback) |
| 2026-07-11 | Amber kept as focus hue; swappable via single `accent` token | Owner unsure on yellow — de-risked by token architecture + amber diet |
| 2026-07-11 | Amber diet codified (5±2 points, no washes, hover-expansion, diff=green, 2-rendition attention) | v1 mockup overused amber → read as "yellow app", not "one lit instrument" |
| 2026-07-11 | Status footer instrument strip (model·approval·ctx·cwd·running·needs) | Codex pattern; always-visible agent state |
| 2026-07-15 | Two-accent split: amber (`--accent-cursor`) = alive/attention, steel-blue (`--accent-blue` #6E9BC4) = navigation/interactive; focus moves amber→steel | `--accent-blue` was overloaded (157 renderer usages, all reading amber since accentSecondary==accent); one hue can't say "alive" AND "clickable". Cockpit warm/cool tension; `accentSecondary` token already existed for it |
| 2026-07-15 | gpui-style component surfacing: buttons/inputs/menus/cards get surface-lift + top inset-highlight (①), inputs recessed + accent focus ring (②); button radius 4→5px | Flat-to-the-point-of-unfinished read as cheap; adds crafted depth within the existing "elevation 3 levels" rule (not gradients/glows). Amber diet unchanged/improved |
| 2026-07-15 | Action = warm: primary/CTA buttons moved to `--accent` (solid warm fill, the one filled button per surface); new `--accent`/`--accent-rgb` semantic vars in every theme; alive≠warning hues for stars/taegeuk; 4 mono-accent themes gained the warm/cool split | Design review scored "primary=steel" as the brand-weakening flaw: the most important button read cold and amber demoted to a dot. Actions DO (warm), navigation GOES (cool) |
| 2026-07-19 | fan-out moved toolbar → deck control bar (revises the "AI-directed actions (fan-out, broadcast)" toolbar contract at Component Rules); Broadcast stays in the toolbar with an inline recessed popover (was a dead `window.prompt`) | fan-out is a fleet-spawn command → belongs next to Mode/Loop/Schedules, not the per-terminal toolbar; a deck-header/Fleet home dies on an empty fleet, the control bar renders on `activeWorkspaceId`. Broadcast's per-terminal scope matches the toolbar framing |
| 2026-07-19 | Menu IA = hybrid — Git·Review stay as deck tabs (not moved to center) + a warm Review badge (dirty-workspace count, reusing `metadata.gitSync` — no new polling); hunk diff stays center (DiffPanel); the orchestrator-model chip moves from the deck-tab header to the control bar | The "diff needs hero width" premise was false (diff already opens center via `addWorkspaceDiffSurface`); Git/Review are vertical rosters that belong on the deck. Always-on glance (dirty badge) beats hiding it behind a tab. Model chip frees the tab strip so 4 tabs + collapse fit the 248–320px deck |
| 2026-07-20 | 메뉴 IA=시안 A — Git·Review를 덱에서 중앙 페인 surface 탭으로 이관, 덱은 Orchestrator·Channels 2탭 (2026-07-19 hybrid 결정을 대체; Review dirty 뱃지도 롤백) | 오너가 시안 A를 명시 선택 — Git·Review 진입점을 각 페인의 SurfaceTabs 액션 클러스터로 옮겨 작업 맥락(활성 터미널 cwd) 옆에서 열고, 덱은 오케스트레이터/채널에 집중 |
| 2026-07-20 | fan-out은 에이전트 툴바로 복귀(2026-07-19 "toolbar→control bar" 결정 되돌림), 오케스트레이터 모델 선택은 컨트롤 바 칩에서 Agent 탭 인라인 드롭다운으로 이동 | fan-out 버튼을 툴바 우측(New chat 왼쪽)에 되돌려 함대 스폰 진입을 터미널 크롬에서 바로; 모델 선택은 탭 라벨 `Agent (모델)`을 활성 상태에서 재클릭해 여는 인라인 메뉴로 통합해 컨트롤 바를 Mode·Loop·Schedules로 정리 |
| 2026-07-20 | Git·Review=워크스페이스 헤더 탭(중앙 상단 행 우측)+중앙 전체 표면, 페인 탭=터미널·브라우저(·diff·editor) 전용 (같은 날 시안 A 페인-탭 결정을 대체) | Git·Review는 워크스페이스 단위 데이터인데 페인 surface 탭에 붙여 어색한 동작이 연쇄됐다(세트가 첫 터미널에 붙음, 분할 시 한쪽만, 다른 페인에서 점프, 좁은 탭 잘림). 헤더 탭으로 승격해 워크스페이스 스코프와 맞추고, 클릭 시 페인 그리드를 덮는 중앙 표면(GitTab/ReviewTab, max-w-720)으로 연다. 페인 그리드는 display로만 숨겨 터미널 PTY를 살린다. GitTab은 cwd prop 없이 활성 페인 cwd를 라이브로 따라간다 |
| 2026-08-14 | Deck header = icon strip (Agent · Git · Channels · web, 36px glyphs); collapsed deck = a 36px vertical glyph rail on the deck's edge; the Agent · Git · Channels · web rows at the sidebar's foot are gone | Three text tabs ate the entire header of a 248–320px column. The entry points sat on the opposite edge (the sidebar's foot) and disappeared outright when the sidebar was collapsed (MiniSidebar never carried them) — what opens the deck lives on the deck's edge. The tab name and the current orchestrator model moved to the tooltip / accessible name |
| 2026-08-15 | Agent verbs leave the workspace-spanning 36px toolbar and go home: compose (⌘G) + attach + new-conversation on the focused pane tab cluster; Broadcast is a compose target (This pane / All N terminals, All N armed 4s); Multi Task / Start agents on the selected workspace card (deck header only when the sidebar is collapsed). No titlebar verbs, no hover bar, no bottom strip | Chrome must match blast radius. A pane verb owned by both panes in a split lied; a fleet spawn that unmounted at 0 agents could not start a fleet; the 36px strip stole a chrome module from the terminals |
| 2026-08-18 | Reverts 2026-08-15. The agent verbs are one workspace-spanning bar again (attach · files · snippets · rich input ⌘G · Broadcast · Multi Task · new conversation), but it OVERLAYS the workspace column and is revealed on approach rather than always on. The pane tab cluster keeps split · browser · zoom only; the sidebar card and deck header carry no fan-out trigger. A pin toggle restores the always-on strip per operator | Owner call: the split homes cost more than the ownership precision bought. Three entry points for one verb (empty card / roster header / deck header, each with its own label and visibility rule) meant no muscle memory, and a 420px form opened from a 240px column covered the hero. Overlaying answers the objection the removal was built on — the bar spends no chrome module, so the terminals lose nothing — while the reveal is guarded so it cannot fight the prompt line it sits over: a dwell delay, suppressed under a held pointer button (drag-select) and on keystrokes, and a keep-alive band the height of the bar so it does not retreat from the cursor reaching for it |
| 2026-08-18 | The collapsed deck's 36px vertical glyph rail is gone. Reopening moves to a single `«`/`»` toggle in the titlebar's right cluster, beside Settings, carrying one aggregate dot when the collapsed deck holds unread channels or dirty worktrees. Tab selection stays in the deck's own header | The rail spent a full-height column on four glyphs and a chevron with ~85% of it empty, and the terminals paid for it. One command deserves one button, and the deck's state is app-global (no workspace scope), so the app-wide titlebar row is where it belongs — the same row that already carries Settings and the fleet vitals. This satisfies the 2026-08-14 decision's REASON better than the rail did: the entry point had to stop vanishing with the sidebar, and the titlebar never collapses. The dot is a boolean, not a total — unread messages and dirty worktrees are different kinds of thing and summing them would invent a number that means nothing; at zero there is no dot, per the no-dead-gauges rule. Cost accepted: opening a SPECIFIC tab is now two steps (open, pick) where the rail did it in one; ⌘K carries per-tab commands |
| 2026-08-24 | Stashed panes are listed in the SIDEBAR roster, after the running agents (amends "Left sidebar = navigation only. Agents do NOT live here", 2026-08-14). The rows are pane-level, keyed by paneId, and a click brings the pane back into the layout and jumps to it. The pane-action cluster gains a fifth button (archive glyph) between browser and zoom, 116px → 142px | Owner amendment. A stashed pane's row IS a navigation affordance — click = jump, the same verb the agent rows already carry — so it does not reintroduce agent state on that edge; it reintroduces a destination. The alternative (Fleet-only) fails the case the feature exists for: the pane just vanished from the layout, and the list that explains where it went has to be the one already in the user's eye. The status dot stays FILLED and undimmed — dimming is the convention for dead, and this pane's entire claim is that it is alive; a hollow ring drawn with box-shadow vanishes under forced-colors, taking the row's only status signal with it. Stash is signalled by the archive glyph, the list position and the label instead. The action verb rides title/aria + :focus-visible, never a hover swap of the status text: swapping it would hide the proof of life at the moment the user looks for it, and leave keyboard users with no verb at all |
| 2026-08-24 | A pane below 222px collapses the five-button action cluster into one `⋮` (31px) that opens the same actions as a vertical menu; the ⋮ persists however narrow the pane gets (the tab strip scrolls, so identity survives it, and the menu holds the ways out — zoom, stash). Right-clicking a pane header opens the same menu at ANY width (rename inputs keep their native edit menu); only the Settings toggle removes pane actions. The threshold derives from the cluster constants, never restated | Owner call (⋮ menu chosen over shrinking the cluster or dropping it). The drop-outright fallback removed stash and zoom exactly when a crowded layout needs them most, and "browser tab in THIS pane" had no other entry point at all — the palette's Open Browser force-splits a new pane, worsening the crowding it was asked to relieve. The sub-222px band is reachable, not theoretical: a 1536px screen with the deck open leaves ~996px of grid, so five columns land at ~199px. The menu reuses placePopover and the ContextMenu body-portal pattern (#957) — one popover language, nothing new — and hands focus back on close so the keyboard path is round-trip |
| 2026-08-29 | Future prompt scheduling lives in the workspace-spanning agent toolbar as a quiet clock action, not in Command Deck schedules. Creation and delivery require a daemon-owned, canonically identified agent; local fallback fails closed. The popover includes other-session rows, and explicit pane close prunes its schedules | The target and execution contract are per-session: one immutable PTY plus one verified agent family. The daemon alone owns canonical process identity and serialized stdin, so it can accept idle readiness while guarding recent/concurrent human input and make each occurrence at-most-once. Command Deck schedules start new workspace-orchestrator turns and carry different autonomy semantics; sharing their surface would make blast radius ambiguous, while a focused-only list would strand unavailable schedules |
| 2026-08-30 | Scheduled prompts bind to a daemon-minted session incarnation in addition to PTY id and agent family. A replacement session permanently pauses the row with a danger dot and “session changed — recreate”; only Delete remains, because Resume cannot make a stale target valid | Short PTY ids are convenient addresses, not permanent identities. Recovery and supervised replay preserve the logical incarnation, while a genuinely new session receives a full UUID. Making replacement terminal and visible closes accidental id-reuse retargeting without adding modal confirmation or noisy chrome |
| 2026-09-05 | One status-dot vocabulary, derived from the task ledger status by a single shared helper: amber = working/running or review_requested (the brain owes a move) · gray = working but idle · red = needs input · green = completed/clean only · muted = failed/cancelled. Green never means "open" | The design audit found the same task green in the sidebar (open = green), gray in the deck panel (worker idle) and green again on the workspace card (git clean). Three surfaces, three meanings for one dot; the reader cannot tell "done" from "waiting" |
| 2026-09-05 | The sidebar's TASKS list is gone; it becomes a one-line summary (`TASKS · N open · M need you`, click = deck task panel) and renders nothing at zero. Per-task rows, their status dots and the task-channel jump live in the deck task panel only (capped at 5 rows + `N more`, expansion remembered) | Restores "left sidebar = navigation only" (2026-07-11): the list repeated the deck panel and the task workspace cards, so twelve tasks were drawn three times and the sidebar stopped being a map. The 2026-08-24 stash-row amendment stands (a stashed pane is a destination); a task row was a status readout, which is the deck's job |
| 2026-09-05 | Attention grammar applied to approvals: the dialog and the Fleet inbox are the two renditions; the deck header countdown renders only while the Fleet inbox is not on screen. Titlebar vitals follow the no-dead-gauges rule: the memory chip appears above a threshold, the clock is off by default | One pending approval was drawn three times (dialog, deck header badge, Fleet row); `553MB 09:22` sat in the titlebar as a permanent gauge |
| 2026-09-05 | Inter is bundled after all (400/500/600, OFL), reversing the earlier "not bundled → system-ui" shortcut in globals.css; inline code in the brain transcript is mono on `--text-sub`, never accent; the Mode chip is text + dot at rest, no tinted fill | The audit measured the UI in `system-ui` (the "gave up on typography" signal) and counted amber spent on code spans and a permanent red-tinted pill — the one-lit-instrument thesis fails when prose and a mode label glow |
