# Design System — wmux ("Bridge" redesign, 2026-07-11)

> SSOT for all visual/UI decisions. Read this before making any visual change.
> Token *values* live in `src/renderer/themes.ts`; this file defines the roles,
> rules, and layout contracts those tokens serve.
> Current layout and attention rules verified against the working tree on 2026-09-22.
> Dated decisions below retain history; the current contracts take precedence.

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
│ 264px     │  largest area; focused pane =    │ control      │
│ navigation│  steel tab-strip underline)      │ 248–320px    │
│ + spaces  │                                  │ ┌ tabs ────┐ │
│ (mantle)  │                                  │ │text tabs │ │
│           │                                  │ ├ selected ┤ │
│           │                                  │ │ tab view │ │
│           │ [agent bar — overlay, on hover]  │ └ busy bar ┘ │
└───────────┴──────────────────────────────────┴──────────────┘
     (deck collapsed → that column is gone; reopen from the titlebar)
```

- **Left sidebar = glance board** (owner decision 2026-09-25, replacing
  "navigation only"). Global shortcuts at the top, in order: Search, Remote,
  Fleet; workspace rows under their own heading and add action; settings at
  the foot. Collapsing keeps the shortcuts as named icon buttons. The list
  answers "what wants me, and where" at a glance: rows sort by attention by
  default, each row shows its status mark, agents and a "changed since you
  last looked" dot, and a click jumps. **Fleet stays the triage surface** —
  search, filters, bulk verbs, the output preview and the per-row detail live
  there, not in the sidebar. Both read ONE classification
  (`fleetAttentionClass`: needs you · finished · running · unconfirmed · idle),
  which Fleet folds into its three sections, so a pane cannot read differently
  in the two places. Conversations remain in their owning panels.
- **Tools dock = opposite the workspace sidebar**, 248–320px wide, with
  labeled Agent, Git and Channels tabs. Git includes Review; Agent holds the
  orchestrator conversation. Remote lives in the sidebar. Fleet opens over
  the dock as a separate overlay without changing terminal dimensions.
  The titlebar's labeled panel toggle opens and closes the dock.
- **Collapsed tools-panel signal:** show one warm `--accent` dot when there
  are unread channel messages or dirty workspaces; hide it when the dock is
  open or both counts are zero. This is an attention cue, not an error or a
  task-status dot. Do not sum those different counts. The icon and dot are
  decorative under an `aria-hidden="true"` wrapper; the button's accessible
  name includes the attention message, and `aria-expanded` conveys open state.
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
    The collapsed tools-panel unread/dirty dot follows this attention rule;
    it does not use danger red. Decorative descendants may inherit
    `aria-hidden="true"` from their wrapper; repeat the signal in the
    control's accessible name rather than exposing the dot itself.
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
  stack never falls through to `system-ui`. The one exception is the dialog
  title, which uses the existing 16px display step (`--text-display-size`).
  Inside dialogs and popovers, labels are sentence case and muted (11–13px);
  the 10px uppercase tracked label belongs to chrome only.
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
- Radii: **chrome 5/6/7; surfaces 8/12/14.** Chrome (titlebar, tab strip,
  sidebar rows and their controls): 5px buttons/controls · 6px inputs · 7px
  cards/panels, never larger. Surfaces (dialogs, popovers, the grouped
  containers and inputs inside them): 8px buttons · 10–12px grouped
  containers and inputs · 14px dialog and popover panels. Full-round for
  status dots, count badges, chips and segmented pills.
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
- **gpui-style control surfacing (2026-07-15), chrome only** (dialogs and
  popovers follow the quiet rules in Dialogs & forms): two physical treatments only.
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
- Status mark vocabulary (2026-09-24) — shape first, colour second, one shared
  helper (`AGENT_STATUS_ICON.mark`): running = filled amber dot · needs input =
  red ring (with the row wash) · error = red ✕ drawn as SVG · complete = green
  check · unconfirmed = hollow amber ring · idle = no mark. Selection is never
  painted as a status: an active-but-idle workspace has no dot.

### Dialogs & forms

Build every modal, popover and settings row from `src/renderer/components/ui/`
(`Dialog`, `Button`, `Field`, `Switch`, `Checkbox`, `Select`,
`SegmentedControl`, `Badge`, `Input`, `MediaPreview`) rather than hand-rolled
inline styles. Surfaces are **quiet** (owner, 2026-09-24): neutral fills,
1px low-contrast hairlines, one soft floating shadow on the panel only, no
top inset highlight and no raised bevel. The machined raised/recessed look
stays on chrome.

- **Dialog anatomy:** backdrop `--backdrop-modal` at `--z-dialog`; panel
  `--bg-base`, 1px hairline, 14px radius, one soft shadow; 24px padding and
  12–16px between groups. Header = 16px/600 title + optional 13px `--text-sub`
  description + a 32px close ×. Body scrolls; Footer is a right-aligned
  action row with no divider. Focus is trapped while it is inside the panel,
  comes back if a re-render drops it, and returns to the opener on close.
  Escape closes the top-most dialog only, never mid-IME, and never reaches
  what is underneath.
- **One primary per surface.** At most one solid warm (`--accent`) button per
  dialog state, chosen by what unblocks the user first. It sits last in the
  footer, or — when a listed status needs an action — in that row's notice
  action. Every other action is secondary (flat: subtle neutral fill + hairline,
  or a hairline outline), ghost (dismiss / skip) or destructive (red tint;
  solid red only for a final confirm). A disabled or in-flight action is never
  the primary, and the emphasis does not jump to the next step while one runs;
  a state with nothing to do has none. Steel is only for focus rings and links.
- **Grouped rows:** a list is ONE rounded container (12px, hairline) with
  inner hairline dividers, not a boxed card per row. Each row is icon +
  13px label + optional 11px muted secondary line.
- **Notice row:** icon · title + one-line description · vertical hairline ·
  action on the right. Use it where a status needs an action (hooks not
  installed → Install hooks), inside a group or on its own.
- **Popover:** the same quiet panel (14px, hairline, soft shadow) anchored to
  its trigger. Sections stack inside it: a muted sentence-case header with an
  optional trailing action (e.g. `+`), icon + label rows beneath, and a
  hairline between sections. Icon-only toggles on a surface show "on" as a
  faint filled chip, not a colour.
- **Field row:** 13px/500 label + 11px `--text-sub` description on the left,
  control on the right (`inline`) or underneath (`stacked`, for text inputs).
  The row wires the label (`htmlFor`, adopting a control's own id, or
  `aria-labelledby` for groups) and `aria-describedby` into its control.
- **Controls:** switches and checkboxes are neutral — a dim track / hairline
  box when off, a light track with a dark knob / light box with a dark check
  when on; never warm. Segmented controls are a full-round track with the
  active pill filled neutral. Selects and inputs in surfaces use a subtle
  neutral fill, 10px radius and the steel focus ring. Badges are full-round
  and neutral by default; success / warning / danger tint the text and
  hairline only. There is no action-coloured badge; `warning` uses the
  theme's warning hue (amber in the amber theme, by the Color rule above).
- **Type:** Inter inside surfaces. Mono only for machine evidence —
  commands, paths, error codes (`ui-code`) — never for a whole dialog. Status
  marks are icons (`IconCheck`, `IconWarning`), not text glyphs.
- **Media:** a feature explained in a dialog or the tour may show a short muted
  loop (`MediaPreview`, WebM ≤ ~6 s, ≤ 500 KB) in a fixed 16:10 frame,
  labelled for assistive tech; under `prefers-reduced-motion` it shows the
  still poster and never plays. The clip must show what the copy next to it
  says; when no clip does, the step is text only.

### Settings

Settings is a full-screen surface under the titlebar (`.ui-surface`), built
from the Dialogs & forms primitives plus `Settings/SettingsLayout.tsx`
(`SettingsSection`, `SettingRow`, `SettingNote`).

- **Information architecture** (owner-reviewed, 2026-09-24). Tabs, in nav
  order: General (language, updates, startup, tutorial, first-run setup,
  reset) · Appearance (theme, interface, sidebar, panes, terminal text, agent
  toolbar) · Terminal (shell, input, rendering and memory, scrollback) ·
  Keyboard (shortcuts, prefix mode, custom keybindings) · Notifications. Group
  **Agents**: Claude Code (setup card, plugin signal health, usage meter, MCP
  registration) · Accounts · Orchestrator · Roles & fan-out (role bindings,
  A2A, fan-out approval and worker permissions) · Browser. Group
  **Connections**: Remote & phone (paired devices, quick commands; the live
  serve toggle stays in the sidebar Remote popover) · LAN. Then About. Each
  tab answers one question; a setting lives on exactly one tab and the search
  catalog (`settings/catalog.ts`) names that tab. Retired tab ids resolve
  through `resolveSettingsTab` instead of breaking a deep link.
- **Nav:** 13px icon + label rows; group headings muted sentence case (the
  app group and About are unheaded); the selected row is the sidebar's active
  row — neutral surface + a steel edge. No mono, no uppercase tracking.
- **Page:** one centered column (720px max); the tab's name as a 16px/600
  Inter title; sections 28px apart. A section is a muted sentence-case heading
  over ONE rounded container of rows with hairline dividers — never a card per
  row. A lead group whose only row names itself carries no heading.
- **Row:** label + one-line muted description on the left, control on the
  right. Copy that overflows its line collapses to one line with a Learn more
  disclosure (measured, not guessed). A status that needs an action is a
  notice row (hooks missing → Install); status words are Badges (neutral or
  success), never amber mono.
- **Controls:** Switch, Select, SegmentedControl, Input, Checkbox, Button,
  Badge from `ui/`. At most one primary per tab, on the action that unblocks
  the user (a staged update's Install, the first missing integration, starting
  a LAN pairing); a destructive flow is red tint, solid red only on its final
  confirm. Theme and cursor cards stay visual, on 10px radii and hairlines,
  selected by a neutral outline + check.
- **Escape** closes a dialog opened from Settings before Settings itself.

## Motion

- Minimal-functional. Spinners and blink-cursor are the only perpetual motion.
  Exception (owner, 2026-09-24): the preview clips in the welcome dialog and
  the onboarding tour loop while they are on screen — they are content shown
  on request, not chrome — and they never play under reduced motion.
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
| 2026-09-21 | Refine the outer shell first: Orca-inspired global sidebar shortcuts, 13px navigation and pane labels, quieter neutral selections, and an inset terminal frame. Workspace menu descriptions use 11px text. Existing terminal content stays in place; assistant-ui chat is a later phase | Improves readability and navigation while preserving the terminal-first workspace and existing actions |
| 2026-09-21 | Replace the titlebar's ambiguous double-chevron with a 28px-high tools-panel icon + 13px label, explicit open state, and a mirrored panel-side icon. Settings lives in the full/compact sidebar, including its onboarding target. Preserve Minimal/Standard visibility recipes and saved individual preferences | Makes the top-right control explain its target and removes duplicate settings. Minimal remains a supported contributor-requested workflow, with settings always reachable to restore Standard |
| 2026-09-23 | Fleet becomes a three-section attention board (Needs you / Running / collapsed Idle) with a one-line detail, elapsed time, a changed-since-last-look dot and row verbs; section and detail come from one pure selector | Twelve identical idle cards with no last activity answered nothing. Fleet is triage — what needs me, what is moving, what has gone quiet and for how long — and the sidebar stays the map |
| 2026-09-24 | Dialogs and forms get shared primitives (Dialog, Field, Switch, Checkbox, Select, SegmentedControl, Badge; Button sizes and a destructive alias) and a "Dialogs & forms" rule set; the welcome dialog and the onboarding tour are the first adopters, with short preview clips. The settings gear becomes a cog | The outer chrome had the Bridge design but every modal still used the old UI: monospace prose, green borders, several amber buttons per dialog and a steel-filled Next. Shared primitives make the grammar the default, and a clip shows what a feature does where text alone did not |
| 2026-09-24 | Owner: quiet surfaces for dialogs and forms. Surface radii 8/12/14 (chrome keeps 5/6/7), flat secondary buttons, neutral switches and checkboxes, sentence-case muted labels, grouped rows in one container, the notice row, the popover section model, 16px dialog titles, one soft shadow and no bevels | The first pass carried the chrome's machined look into dialogs, and they read heavy and busy. The owner chose a quieter, almost colourless surface where the single warm primary is the only colour, lists read as one calm group, and a status that needs an action carries it on the same row |
| 2026-09-24 | Settings reorganised into one-question tabs (Claude Code, Accounts, Orchestrator, Roles & fan-out, Remote & phone split out of the old Accounts/Agents tabs; the agent toolbar moves to Appearance, first-run setup to General) and rebuilt on the quiet-surface primitives: one container per section, Field rows, Learn more for long copy, a language Select without flags, an Inter header and no footer | The Accounts and Agents tabs each held four or five unrelated things and the categories did not sort; every tab mixed card-per-row boxes, mono headings, uppercase labels and bright input borders. One question per tab makes a setting findable by where it belongs, and one row grammar makes every tab read the same |
| 2026-09-24 | Sidebar redesign (#1481): the roster lives in the sidebar with a drawn identity monogram per agent kind; status is told by shape (dot / ring / ✕ / check / hollow ring / none) and an idle active workspace is no longer green; collapsed rows summarise agents by glyph and status; fan-out tasks nest under their owner with a rollup, provenance tooltip, a link back to the owner and a close-finished action; a Recent activity order; the sidebar is 264px and resizable 220–400px | With several agents per workspace and fan-outs creating a workspace per task, the flat list could not say which agent was which, whether "green" meant done or merely selected, or which workspace a task came from and who asked for it. Shape survives colour-blindness and forced-colors; nesting keeps a fan-out's tasks next to the work that spawned them; the width was the first thing the new row content needed |
| 2026-09-25 | Sidebar agent monograms removed (owner: the one-letter frame read as cheap and repeated the same C on every row): Claude is unmarked, other agents are named in muted text, the collapsed summary counts per status group | Identity only matters as the exception; the default agent carrying a mark on every row was noise |
| 2026-09-25 | The sidebar becomes a glance board: Attention is the default order (needs you → finished → running → unconfirmed → idle, newest first, pins keep their slot, new workspaces hold the top, re-sorts wait for a 3 s settle or the pointer leaving); rows carry a --text-main "changed since you last looked" dot; the sidebar and Fleet read one attention classification | Owner call: with the roster in every row, the sidebar already was where the eye goes, and making it navigation only sent the user to Fleet for the one question the list could answer itself. Fleet keeps what a list of rows cannot hold — search, filters, bulk verbs, previews. Rows that jump while the pointer is on them destroy aim, so the order is applied only when nobody is reaching for a row |

### Desktop conversation view

Each local terminal surface can switch between Terminal and Chat without replacing
its PTY. Terminal remains the default and the fallback for approvals and unsupported
agents. The chat presentation adapts assistant-ui's official MIT-licensed Thread
registry component: a 44rem conversation column, plain assistant replies, muted
rounded user messages, a rounded composer with an arrow send button, and a sticky
viewport footer with a scroll-to-latest control. Theme colors come from wmux.
Avoid repeating speaker labels and timestamps on every message. Keep the same
Chat / Terminal switch accessible in Minimal mode.

The desktop adapter currently reads Claude Code transcript events and sends to the
verified live Claude session. Updates follow recorded events, not a separate model
connection. Tool bodies and code blocks load on expansion; approvals stay in
Terminal. Drafts survive view switches within the same conversation. Attachments,
regeneration, message editing and voice controls are hidden until supported.

### Sidebar rows (2026-09-24)

- **Width:** 264px by default, resizable 220–400px from the inner edge (a 10px
  seam, `role="separator"`, arrow keys when focused), persisted, double-click
  resets. While dragging only a 1px steel guide follows the pointer; the width
  is committed on release, so terminals refit once rather than on every move.
  The titlebar's left segment follows the width. The compact rail stays 48px.
- **Workspace row:** status mark · name (13px) · collapsed summary · needs-you
  label · hover actions. The collapsed summary is one status mark and a count per
  non-idle status group, most urgent first (the total alone when all are idle);
  it stays visible at rest. The git line uses the branch and worktree icons;
  no text glyphs that can render as emoji (⎇ ⊕ ⚠ ✓ ✗).
- **Agent row:** status mark · title · agent kind (non-Claude only) · muted trailer (live
  activity while running, else the pane coordinate) · elapsed time since the
  last activity, right-aligned (10px like the rest of the roster row, muted,
  tabular). A pending question
  keeps its own red second line. Stashed rows keep their status word (their
  proof of life, 2026-08-24).
- **Agent kind:** no identity glyph. Claude is the default and gets no mark;
  any other agent names itself in muted 10px text after the title (its display
  name, e.g. `Codex CLI`, truncating before the title does), and only when the
  row has its own title — otherwise the title slot already is the agent name.
  The trailer no longer repeats the vendor. Shells get nothing.
  The name stays in the tooltip and accessible name. Never a vendor logo or
  favicon (trademarks; written permission required).
- **Fan-out nesting:** a task workspace renders under the workspace that fanned
  it out, indented on a hairline guide, with a fold chevron. A group is open
  while its owner is active or one of its tasks needs you, otherwise folded; a
  user toggle is remembered, and a group always opens while one of its own
  tasks is the active workspace. A task row carries no "Needs you" word (its
  wash and red ring stay; the rollup names the count) and shows its shortcut
  hint only on hover — the indent leaves the name no width to spare. The owner's rollup line reads `N tasks · M need
  you` and draws nothing at zero; "need you" is red only while the group is
  folded (unfolded, the task row is the evidence). Its ⋮ menu holds `Close
  finished tasks (N)`: finished means every agent pane in the task reports
  complete (idle never counts); the confirm lists the tasks by name, each is
  re-checked right before its close, and the close is the task close path — a
  task with uncommitted or unpushed work is kept and the reason is said. The
  collapsed-row summary draws a running agent neutral, so a workspace spends
  one amber point, not two. Detached tasks are ordinary
  top-level rows; tasks whose owner is gone collect under "From closed
  workspace". The `wtask: ` prefix is dropped on screen only. Nesting trusts the task
  record and the fan-out lineage stamp, never the name. Task rows are not
  reorder sources or targets and carry no Ctrl+N hint.
- **Provenance:** a task row carries a muted fan-out glyph whose tooltip reads
  `Fanned out by <owner> · <you (GUI) | orchestrator | calling pane> · <time>`.
  Inside a task workspace the titlebar's workspace name is followed by a muted
  `↰ <owner>` link (steel on hover) that jumps to the owner.
- **Order:** Attention (default), Manual, or Recent activity — Settings ›
  Appearance › Sidebar. Attention: needs you → finished (a turn that ended and
  was not looked at) → running → unconfirmed → idle; within a class the most
  recent event first. Plain `waiting` with no question is idle here, as in
  Fleet, and draws no "Needs you" wash or label. A fan-out owner scores as its
  most urgent nested task, so a task that needs you lifts its group. A pinned
  workspace (row menu › Pin position, offered in Attention only; a muted pin
  glyph) keeps its rank among the top-level workspaces above it in the stored
  order — nested tasks take no slot. A workspace created in the last three
  minutes holds the top. Rows never move under the pointer or keyboard focus:
  a re-sort applies after the list has been quiet for 3 s (at most 10 s after
  the first pending change), or at once when the pointer or focus leaves;
  adds and removals land immediately. The non-manual orders are display-only:
  drag-to-reorder pauses, and the `^N` shortcut hints are hidden because
  Ctrl+N follows the stored order. Sessions that never chose an order move to
  Attention once, with a notice offering to keep the manual order; an explicit
  choice is kept.
- **Changed since you last looked:** a 6px `--text-main` dot (never amber —
  Fleet's rule) after the name, on the workspace row and on the agent row,
  when an agent tab's status or pending question changed (any number of
  times, round trips included) since its workspace was last on screen and it
  now needs you or has finished. Tracked per agent tab, not per pane. On
  screen means the active workspace, plus the multiview grid only while the
  active workspace is in it, and no local workspace while a remote mirror is
  showing. It clears as soon as the workspace is on screen.

### Sidebar shortcuts and Agent dock refinement (2026-09-21)

Sidebar shortcuts appear in order: Search, Remote, Fleet. Search opens the
command palette. Remote opens the existing browser/phone pairing controls;
Agent, Git and Channels remain in the tools panel. The compact sidebar
uses the same destinations with accessible names.

The Agent conversation uses a rounded, readable composer. Mode and New session
remain visible; Loop and Schedules are grouped under an Automation disclosure.
Keep approval countdowns visible. Show recovery once while its notice is present,
and restore the recovery shortcut after dismissal. Briefing headlines may wrap
instead of being clipped between a label and a pane link.

### Fleet overlay (2026-09-21)

Fleet opens over the tools dock, at up to 720px wide, without adding a flex
column or changing terminal dimensions. Mirror its anchoring when the sidebar
moves right. Keep the covered tools dock mounted and inert so drafts survive
and keyboard focus cannot enter covered controls. Fleet stays non-modal: visible
workspace areas remain usable; close, Escape and selecting an agent retain their
existing behavior. Fleet is an attention board (andon), not a map: one
single-column list in three sections — Needs you, Running, Idle — decided by one
pure selector (`groupFleetPanes`) that other consumers reuse. Needs you holds
input requests, errors, stopped supervision, unconfirmed (no report for 30m+)
panes and finished turns until the pane is focused; waiting without a question
is Idle. Section headers are quiet 11px uppercase text and are not drawn when
their section is empty (no dead gauges). Idle collapses to one `Idle N · oldest
2d` row that is itself a roving option; when nothing needs you, one plain line
says so above it. Each row: status dot + label, task/project name (user labels
and mission titles before terminal titles), a one-line detail (the question,
the agent's last message, or its tool activity) and elapsed time since the
newest activity/output/turn stamp. Status colours are the sidebar's dot
vocabulary (red = needs you/error, amber = running, hollow amber ring =
unconfirmed); no yellow. A needs-you row whose status changed since Fleet was
last closed gets a 6px `--text-main` dot, never amber. Row verbs (Jump,
Message, Stash, Label, Close) live behind a hover/focus ⋮ using the pane
actions menu, with m / s / l / Backspace on a focused row; Close confirms with
Cancel as the default; remote rows offer Jump only. Icons come from
`icons.tsx`, never emoji; the status cross, the supervision ⟳ chip and the ⋮
trigger keep the glyphs the sidebar and pane header already use. Search and status filters narrow the
sections without stealing input focus; selection stays attached to pane
identity across reordering. Raw terminal output belongs in an opt-in preview of
the selected pane, never in every row. Use 13px row titles, 12px detail and
11px metadata; at narrow widths the detail stacks under the title and the
overlay width stays 720px.

### Channel task records (2026-09-22)

The Channels tab groups linked mission records before shared discussions. Use
Orca-style quiet navigation rows: 13px task titles, 11px secondary context,
neutral selected surfaces and a steel selection edge. Keep original channel
identity separate from the display title.

Task details lead with a 19px title, neutral open/closed/detached state, mono
branch and a steel workspace link. Latest activity is a message excerpt, not
completion evidence. Discussion unfolds below as a flat timeline; long reports
use a native disclosure. Keep author identity and delivery outcomes available.

Reuse the MIT assistant-ui Thread composer styles already adapted in
`components/Channels/LICENSE.assistant-ui`, with a compact 12px radius
and 13px input for the 248–320px dock. Preserve the channel-specific delivery and
mention implementation. Warm send action, cool navigation, theme tokens only.
