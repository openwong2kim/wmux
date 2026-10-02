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

## Proposal — Neutral glass look (2026-10-03, owner-directed, pending final approval)

> **Status: proposal.** The owner chose this look and authorised it to replace
> the conflicting rules below (amber grammar, machined bevel, type scale,
> 36px module). It takes effect when the owner approves this revision; no
> renderer code changes with it. Where a current rule is replaced, the
> rule is named. **Icons are not part of this change:** wmux keeps its own
> icon set (`src/renderer/components/icons.tsx`).

The look: a dark, mostly colourless window whose sidebar (and optionally the
body) is translucent on macOS. Greys are told apart by how much of the text
colour is mixed in, not by borders. Controls are small filled rounded
rectangles with no outline. Lists are soft rounded cards with two lines of
small muted metadata. One cool blue accent marks state (running, selected
count, focus), amber marks approval, green marks done, and the primary
button is solid white. Terminals stay the hero.

Every value in this section is adapted from MonoCode unless it names a wmux
source. Adapted from MonoCode (hardbeat920/monocode@6bd432ca,
src/styles/index.css, src/app/shell/Sidebar.tsx, src/app/shell/TitleBar.tsx,
src/features/sessions/ui/Composer.tsx, src/features/sessions/ui/ModelPicker.tsx,
src/features/sessions/ui/AccessPicker.tsx, src/features/sessions/ui/AgentTranscript.tsx,
src/features/settings/ui/SettingsView.tsx, src/features/settings/model/appearance.ts,
src/shared/ui/Popover.tsx, src/shared/ui/Modal.tsx, src/shared/ui/SecondaryButton.tsx,
src-tauri/src/macos.rs), MIT License, Copyright (c) 2026 Nick

### G1. Colour tokens

Two lightness numbers on a zero-saturation hue define a theme; everything
else is the content colour mixed into transparent over the base.

| Token | Dark | Light |
|---|---|---|
| `--theme-hue` / `--theme-saturation` | `240` / `0%` | same |
| `--background-base` | `hsl(240 0% 9%)` = `#171717` | `hsl(240 0% 97%)` = `#F7F7F7` |
| `--content` | `hsl(240 0% 92%)` = `#EBEBEB` | `hsl(240 0% 18%)` = `#2E2E2E` |
| `--stroke` (separators) | content 7% | content 7% |
| `--selection-subtle / --selection / -strong / -hover / -emphasis` | 8 / 10 / 12 / 15 / 20% | 5 / 6 / 7 / 10 / 14% |
| `--accent` | `hsl(211 92% 62%)` | same |
| `--link` | `#7DD3FC` | `hsl(211 92% 40%)` |
| sidebar fill (opaque) | `color-mix(base 90%, black)` | base |

Text emphasis is opacity of `--content`, used in these steps only: 100
(titles, body) · 80 (idle card text) · 70 (hovered secondary) · 50
(labels, inactive tabs, chevrons) · 45 (metadata) · 40 (footer, placeholder)
· 35 (timestamps). Hairlines around controls are content 10% (20% while
focused); structural separators are `--stroke`.

Status and diff colours (Tailwind palette values):

| Meaning | Dark | Light |
|---|---|---|
| running / busy (spinner, "Working…", count badges, focus ring) | `--accent` | `--accent` |
| needs approval / needs you | `#FBBF24` (amber-400) | `#B45309` |
| done / added lines / untracked | `#34D399` (emerald-400) | `#059669` |
| error / removed lines | `#F87171` (red-400) | `#DC2626` |
| modified file mark | amber | amber |
| idle / draft | content 45% / 55% | same |

**Replaces** the Color section's amber/steel two-accent grammar: amber is no
longer "alive" (running is blue) and steel `#6E9BC4` is retired (focus and
links use `--accent` / `--link`). The 5±2 warm-points budget becomes a
general rule: colour appears only on state marks, diff counts and the count
badge; surfaces, controls and selection are always neutral. The "no washes"
rule stays, with one change: a card that needs approval gets a content-20%
fill and a dashed content-30% border instead of the red wash (red is
reserved for errors). Terminal content keeps its own ANSI palette.

### G2. Typography

- **Font:** the platform UI font — `system-ui, -apple-system,
  BlinkMacSystemFont, "Segoe UI", Roboto, …` — and `ui-monospace,
  SFMono-Regular, Menlo, Monaco, Consolas, …` for code. **Replaces** the
  bundled Inter.
- **Scale:** 10 · 11 · 12 · 13 · 14px, plus 20px for dialog titles.
  11px = metadata, chip labels, footers' secondary text; 12px = tabs,
  buttons, segmented labels, mono paths; 13px = card titles (600), menu
  titles, pane titles; 14px (`text-sm`, line height ~1.7) = chat prose,
  composer input and the message footer. **Replaces** the four-step scale and
  its lint rule (12px becomes legal).
- Uppercase tracked labels (12px/600, +0.06em, content 70%) are used for
  group headers in lists (workspace name, "CHANGES"), nowhere else.
- Tabular figures for counts, durations and diff stats.

### G3. Geometry

- **Chrome module 40px** (`h-10`): titlebar, sidebar tab header, pane
  headers, dock header. **Replaces** the 36px module. macOS traffic lights
  are vertically centred in 40px.
- Controls 24–28px tall (`h-6`, `h-6.5`, `h-7`), icon 12/14/16px,
  gaps 4–10px, horizontal padding 6–10px.
- **Radii:** 5px segment inside a track · **6px** (`rounded-md`) buttons,
  chips, cards, tabs, inputs · **8px** (`rounded-lg`) composer, user
  bubble, diff and file cards, menu items · **12px** (`rounded-xl`)
  popovers · **16px** (`rounded-2xl`) dialogs · full round for count badges,
  dots and a one-line chat bubble. **Replaces** "chrome 5/6/7; surfaces
  8/12/14".
- **Elevation:** no bevels or inset highlights (**replaces** the gpui-style
  raised/recessed surfacing). Popovers `shadow-xl`, dialogs `shadow-2xl`;
  in light mode the composer floats on `0 6px 24px content 9%, 0 2px 6px
  content 6%`. Dark mode composer has no shadow.
- Sidebar 260px by default (resizable as today).

### G4. Window glass (vibrancy)

- **Dark mode only.** Light mode is always opaque.
- **Sidebar glass:** the sidebar and the titlebar strip above it paint
  `hsl(hue sat lightness / 0.85)` (user-adjustable opacity) over the
  native backdrop. **Body glass** (optional setting): the main area paints
  base at the same opacity. Terminal canvases always paint an opaque
  background.
- **Popover glass:** a `backdrop-filter: blur(24px)` layer behind the panel
  with a content-2% tint in dark, opaque base in light.
- **Switching order:** turning glass on makes the window transparent first,
  then adds the page class; turning it off removes the page class, waits
  one feedback transition (120ms), then makes the window opaque — neither
  side shows through the gap. The page fades with `color-mix(base 0%,
  transparent)`, never the `transparent` keyword (which interpolates
  through black).
- **Electron, macOS:** `vibrancy: 'under-window'` (or `'sidebar'`),
  `visualEffectState: 'active'`, transparent `backgroundColor`
  (`#00000000`); toggle with `setVibrancy()` after first paint. The first
  frame paints the base colour on the page so there is still no white
  flash (**amends** Window Chrome: `backgroundColor` matches `bgBase` only
  while glass is off). A private window-server blur radius is not used.
- **Electron, Windows 11 22H2+:** `backgroundMaterial: 'acrylic'` is the
  analogue, behind a spike that proves it with `titleBarOverlay` and the
  WebGL terminal. Linux stays opaque.

### G5. Buttons and chips

- **Primary:** solid white, black label (`hover` white 90%, disabled white
  30% / black 40%); light mode is solid content on base. Used for send,
  Stop, Commit and each surface's one primary action. **Replaces** "Primary
  action = solid warm fill".
- **Secondary:** `rounded-md`, 1px content 10% border, `px-2.5 py-1`, 12px,
  content 70%, hover content 10% fill. Destructive: red-400 text, red-400/40
  border and red-400/10 fill on hover.
- **Chip (composer pickers: model, effort, speed, permission):** 26px tall,
  `rounded-md`, `px-1.5`, gap 4px, **no border**, fill `--selection`, hover
  `--selection-hover`; open = same fill + chevron rotated 180°. Label 11px
  content; a secondary value 11px content 50%; leading icon 14px; chevron
  12px content 50%. Max width 160px (permission 208px, small selects
  112px). An off toggle chip (e.g. Fast) shows content 50%. A full-access
  permission tints only its icon amber.
- **Icon button:** 26px square, `rounded-md`; active `--selection-emphasis`,
  inactive `--selection` + content 50% glyph.

### G6. Composer

Container `rounded-lg`, 1px content 10% border (20% when focused), fill
content 3% with a light backdrop blur; outer padding 6px, no top. Inside:
a mono 12px context line (folder · path · branch icon · branch, content
50%), the 14px input (line height 22px, max 160px), then the toolbar
(`gap-1 px-2 pb-2`: `+` icon button, chips, send at the far right). The
toolbar scrolls horizontally; under 220px the permission chip drops to its
icon. A pending-changes strip (`N Files · Undo All · Keep All · Review`)
can sit directly on top of the composer, sharing its border, with Review as
a filled secondary.

### G7. Card rows (sessions, agents, fan-out tasks, Fleet rows)

- Card `rounded-md`, `px-2.5 py-2` (compact `py-1.5`), 1px transparent
  border, 2px between cards, **no dividers**.
- Line 1 (11px): agent kind/model in content 50%; status right-aligned,
  tabular — running = accent spinner + "Working…", approval = amber,
  done = emerald check, otherwise elapsed time in content 45%.
- Line 2: title 13px/600, one line, `mt-1`.
- Line 3 (11px, `mt-1`): branch icon 12px + branch in content 45%;
  right side diff stats (emerald `+N`, red `−M`, mono) or PR in accent.
- States: idle content 80% with hover content 5% · active `--selection` ·
  needs approval content 20% + dashed content 30% border · draft dashed
  content 25% border. Hover-only actions (archive, ⋮) are 20px
  `rounded-md` ghosts.
- Group header above a workspace's cards: 36px, `--selection-subtle`
  fill, icon + uppercase 12px tracked name + a right-aligned 11px pill
  (`N agents · +949 −10`).
- **Coexists with** the glance-board rules (attention order, pin, nesting,
  changed-since-looked dot): those stay; this changes how a row looks.

### G8. Tabs and segmented controls

- **Sidebar header tabs:** two equal halves across the 40px header, 13px;
  active = content + `--selection-subtle` fill + a 2px content underline;
  inactive content 50%.
- **Titlebar workspace tabs:** two lines — 12px title over an 11px content
  45% subtitle (the active agent's task) — separated by `--stroke`; active
  tab `--selection-subtle`.
- **Segmented control:** track `rounded-md`, 1px content 10% border,
  `p-0.5`, `gap-0.5`, 12px; segment `rounded-[5px] px-2.5 py-1`, active
  `--selection` + content, inactive content 50% (hover content). A floating
  variant adds content 10% fill and blur. **Replaces** the full-round
  segmented pill.
- Pane header: 40px, drag grip (content 35%), 13px title, close `×` on the
  right. Focus is shown by the accent focus ring, not a coloured underline.

### G9. Chat transcript and message footer

- Assistant prose: no bubble, 14px, `px-4 pt-3`.
- User message: `px-3 py-2`, content 10% fill, 1px content 10% border,
  `rounded-lg`; in the narrow chat layout it is `w-fit`, max 36rem,
  full-round when one line and `rounded-xl` when it wraps. Its actions
  (time, copy) appear below it on hover/focus, fading in over 120ms.
- **Footer (turn receipt), always visible:** `gap-2.5 px-4 pt-1 pb-3`, 14px,
  content 40%: check icon · `<model> worked for 4m 3s` · a 3px content-25%
  dot · clock time in content 35% · copy button (`p-1 rounded-md`, content
  40%, hover content 8% fill and content 70%).
- Collapsed tool calls read `+N previous tool calls` with a chevron, content
  40%. Inline diffs are `rounded-lg` cards with a mono header and red/emerald
  line fills.

### G10. Popovers, menus, dialogs, motion

- Popover `rounded-xl`, 1px content 10% border, `shadow-xl`, glass layer;
  opens in 170ms from `scale(.94)` and an 8px lift. Menu item `rounded-lg
  px-2 py-2`: 13px title + 11px content 45% description.
- Dialog `rounded-2xl`, 1px content 7% border, `shadow-2xl`, base at 55%
  over glass; backdrop black 40%; title 20px/500. **Replaces** the 14px
  dialog panel and 16px title in Dialogs & forms (the one-primary rule and
  focus handling stay).
- Motion tokens: feedback 120ms, reorder 160ms, tab close 200ms;
  ease-out `cubic-bezier(0.22, 1, 0.36, 1)`. Reduced motion disables them.

### What stays

Terminal-first identity and the layout contract (sidebar · terminal grid ·
tools dock), the glance-board and Fleet rules, the two-rendition attention
rule, status marks told by shape, tool calls as flat mono lines, the
terminal's own ANSI palette, and wmux's own icons.

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
  A2A, fan-out approval and worker permissions) · Browser · Computer use
  (opt-in switch, helper status, stop key, what is asked and what is never
  allowed). Group
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
| 2026-09-25 | Fleet gains a Ready to review section (finished, still-open fan-out tasks: title, owner, branch, change summary, PR, time since finished; Open diff / PR / Jump / Close) between Needs you and Running, and the owner's rollup adds `K to review`, both from one selector | After a fan-out every finished task had to be opened one by one to see what it produced. A section, not a tab, keeps Fleet one list; the sidebar link and the section read the same predicate, and nothing is drawn at zero |
| 2026-09-25 | The sidebar becomes a glance board: Attention is the default order (needs you → finished → running → unconfirmed → idle, newest first, pins keep their slot, new workspaces hold the top, re-sorts wait for a 3 s settle or the pointer leaving); rows carry a --text-main "changed since you last looked" dot; the sidebar and Fleet read one attention classification | Owner call: with the roster in every row, the sidebar already was where the eye goes, and making it navigation only sent the user to Fleet for the one question the list could answer itself. Fleet keeps what a list of rows cannot hold — search, filters, bulk verbs, previews. Rows that jump while the pointer is on them destroy aim, so the order is applied only when nobody is reaching for a row |
| 2026-09-26 | Pin means pinned to top (supersedes "a pin keeps its slot in the Attention order", 2026-09-25): offered in every sort order, the pinned group leads the list and the rail in its own order and never re-sorts; only the rows below it sort and settle. The group is the head of the stored order, so Ctrl+N, rail numbers and the phone's `order` follow it. Drag reorders inside the group in every order; in Manual a drop beside a pinned row pins, beside an unpinned row unpins. Saved pins load as pinned-to-top | Owner call: a pin that only held a slot did nothing in Manual and still let the row sit mid-list, so it answered "keep this where I put it" but not "keep this where I can see it". Keeping the group in the stored order instead of beside it means every surface already defined on that order — shortcuts, rail, phone — agrees without a second ordering. The slot rule is dropped rather than kept alongside: with the group at the top, a slot in the middle of a sorted list has no remaining use |
| 2026-09-25 | Agent mention picker (⌘⇧2 / F2): the command-palette panel with a second footer row — a message field and one Send button that is the primary (warm) only while a message and a target are both there, otherwise secondary — and a one-line status slot under it that swaps the key hints for the send result (sent in `--text-main`, stored in `--text-sub`, refused in `--accent-red`). Rows are pane-level: status mark, agent name, muted tab title, workspace, mono coordinate; no agent logos. Sidebar roster rows get a hover/focus `@` that does the picker's Enter without the picker. Drag-and-drop stays | Addressing another agent by dragging a card pasted a whole markdown block and needed the mouse. A palette keeps one list and one grammar; the send result belongs next to the field that caused it, not in a toast that vanishes while the user reads it |
| 2026-09-27 | Owner decision: the sidebar's Fleet shortcut carries the Fleet board's live counts as small trailing 11px text — `needs you N · running M`, each part hidden at zero, nothing at all when both are zero. Only the needs-you count is warm (`--accent`, one meaning-point); running is `--text-muted`; no chip or fill. The compact rail has no room for numbers, so it reuses its existing 5px warm dot, shown only while something needs you. The label always keeps its width: on a narrow sidebar running drops out first and needs you shrinks to its bare number (at the 220px minimum only the number shows). The accessible name (and the rail tooltip) is built from the same visible strings, so it contains what is shown: `Fleet, needs you 2, running 3`. The numbers are the lengths of the board's own Needs you and Running sections (`selectFleetBoard`), so finished and unconfirmed rows count as needs you, exactly as on the board | The shortcut is the Fleet destination's own rollup, not a third rendition of any one event: a row's red wash stays the evidence, the footer chip stays its own (narrower) count, and this says where to go. Counting the board's sections instead of re-deriving status means the shortcut and the board can never disagree. Running stays neutral so a busy fleet does not spend the amber budget on work that needs nothing |
| 2026-09-27 | Owner decision: fan-out tasks nest under the pane that requested them, not in one block under the workspace — `Workspace › roster pane row (fold chevron + ⑂ count) › tasks`, plus one trailing `From closed pane` group for tasks whose requesting pane is gone or unknown (GUI, orchestrator, legacy stamps); the workspace-level `From closed workspace` group stays. Fold state, rollup and Close finished move to the pane; the task row's `by …` line and the roster's `N requested` count are removed; Fleet keeps its requester text. No new amber: the count is muted, needs-you is red only while folded | With two agent panes fanning out, one block under the workspace plus a `by …` line on every task made the eye join rows to panes by reading. The tree says it by position, costs no extra line per task, and Fleet — which has no tree — is the one place the text is still needed |
| 2026-09-27 | Owner decision: attached remote workspaces join the one workspace list instead of a bordered section under it. In Attention they sort with the local rows by their most urgent agent pane on the same scale (a stale mirror counts as idle, its status is frozen); in Manual and Recent they follow the local rows in attach order. Never pinned, dragged or given a Ctrl+N hint. The host line leads with a muted server glyph (no new amber), a mirror whose agent needs you carries the local row's needs-you wash, red dot and label, a stale row is dimmed, and the header count and workspace search include remote rows | One glance board: a remote agent that needs you was invisible below every local row. The glyph says "another machine" without a host header, and dimming is already the convention for not live |
| 2026-10-01 | Owner decision: Settings gains a **Computer use** tab, last in the Agents group after Browser. It holds the opt-in switch (off by default; its description states that screenshots and window text go to the agent's model provider), the native helper's status as a Badge (success when ready, neutral otherwise — never amber), the global stop key as `ui-code`, and two read-only rows saying what is asked per app and what is never allowed. No primary button on the tab | Letting agents drive other apps is its own question — it is not about the agent browser, and folding it into Browser would bury a new security boundary under unrelated rows. The state lives in its own `~/.wmux/computer-use.json` (main-owned, not the daemon's `config.json`) because the MCP server reads it too |
| 2026-10-03 | **Proposed (owner-directed, pending final approval):** neutral glass look — zero-saturation tokens with a content-mix fill ladder, one blue state accent (running/focus), amber = approval, emerald = done, solid white primary, borderless 26px chips, 6/8/12/16px radii, card rows with two muted metadata lines, 40px chrome module, platform UI font with a 10–14px scale, dark-only window glass, always-visible turn footer. Replaces the amber/steel grammar, the bevel surfacing, Inter, the four-step scale and the 36px module; wmux icons are kept. See "Proposal — Neutral glass look" | Owner call after reviewing a first, more conservative draft: adopt the reference look nearly as-is rather than blending it with the existing grammar. Colour carries state only, so the screen reads calm and every coloured mark means something; translucency and fills instead of outlines give the modern finish |

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
Terminal. Drafts survive view switches within the same conversation. Regeneration,
message editing and voice controls are hidden until supported.

Chat feedback (2026-09-25, owner-approved): a file dropped or pasted into Chat
view becomes a composer chip (thumbnail, name, × or Backspace removes it) and the
sent message shows the picture; a refused file says why in one line. While a turn
runs, a neutral Stop button (never amber; Esc in an empty composer, never during
IME composition) reads Stopping…, then Stopped or "kept running". A message sent
mid-turn to Claude shows as Queued until it runs. The thread anchors to the bottom:
no empty reply row or reserved gap under the latest prompt.

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
  it out, and inside it under the roster row of the pane that requested it
  (2026-09-27): `Workspace › pane row › tasks`, indented on a hairline guide.
  The pane row itself carries the group's fold chevron and a muted mono
  `⑂ N` count; folded with a task that needs you it reads `⑂ M/N` with M in
  red (the only rendition while folded). Its ⋮ (revealed on hover or focus,
  like the row's `@`, named for its pane) holds `Show K finished tasks
  waiting for review` and `Close finished tasks (N)`. A pane with no tasks
  renders as before; an open pane whose agent ended keeps a muted row (no
  status mark) while it has tasks. Tasks are matched to the owner pane that
  holds the origin's surface now — a stashed pane included — else, for an
  origin without a surface, to its pane; never by pty id. Tasks with no such
  pane — the requesting tab closed, the GUI or the orchestrator asked, or the
  stamp predates origins — collect in one trailing `From closed pane` group
  under the owner, with the rollup line below. Folding the roster folds its
  pane groups, so a task that needs you must still show: the roster holds
  open while one of its tasks is the active workspace, re-opens each time
  one more starts needing you (and does not fold when its owner moves to the
  background then), stays open while the workspace is being renamed, and its
  collapsed summary adds a muted `⑂ N` — `⑂ M/N` with M red when M of them
  need you (said in its accessible name too). Fold state is kept per owner
  and pane and dropped when the pane or owner closes; the old per-owner key
  is carried over once. Nested task rows use their own hover group, so
  hovering the owner reveals none of their chrome. Pane rows keep layout
  order; a task that needs you lifts its owner in the Attention order. A group is open
  while its owner is active or one of its tasks needs you, otherwise folded; a
  user toggle is remembered, and a group always opens while one of its own
  tasks is the active workspace. A task row carries no "Needs you" word (its
  wash and red ring stay; the rollup names the count) and shows its shortcut
  hint only on hover — the indent leaves the name no width to spare. A rollup line (the "From closed pane" and "From closed workspace" groups) reads `N tasks · M need
  you` and draws nothing at zero; `· K to review` follows when K > 0 — a
  muted link (steel on hover) that opens Fleet with its first Ready to review
  row selected; "need you" is red only while the group is
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
  In the sidebar the tree itself says who asked (the task sits under the
  requesting pane), so a task row carries no requester line and a roster row
  no `N requested` count (both from #1575, removed 2026-09-27); an audit-log
  pty id is never matched against today's layout. Fleet, which has no tree,
  names the requester on a task's
  row in every section, on an 11px muted line of its own under the meta
  line: `by <coordinate · pane name> · <workspace>`, workspace last so it
  truncates first. A closed requester keeps the same coordinate-first order.
  Inside a task workspace the titlebar's workspace name is followed by a muted
  `↰ <owner>` link (steel on hover) that jumps to the owner.
- **Order:** Attention (default), Manual, or Recent activity — Settings ›
  Appearance › Sidebar. Attention: needs you → finished (a turn that ended and
  was not looked at) → running → unconfirmed → idle; within a class the most
  recent event first. Plain `waiting` with no question is idle here, as in
  Fleet, and draws no "Needs you" wash or label. A fan-out owner scores as its
  most urgent nested task, so a task that needs you lifts its group. A
  workspace created in the last three minutes holds the top of the unpinned
  rows. Rows never move under the pointer or keyboard focus: a re-sort
  applies after the list has been quiet for 3 s (at most 10 s after the first
  pending change), or at once when the pointer or focus leaves; adds and
  removals land immediately. The non-manual orders are display-only:
  drag-to-reorder pauses, and the `^N` shortcut hints are hidden because
  Ctrl+N follows the stored order — except in the pinned group, below.
  Sessions that never chose an order move to
  Attention once, with a notice offering to keep the manual order; an explicit
  choice is kept.
- **Pinned to top:** row menu › Pin to top / Unpin, in every order (not on a
  nested task row). Nesting wins: a nested task cannot be pinned, and a pinned
  workspace that becomes one leaves the group. Pinned workspaces lead the list and the rail in every
  order, in the order the user gave them, and never re-sort; only the rows
  below follow the chosen order. A pinned row carries a muted pin glyph
  (`--text-muted`, never amber) and no group header or divider — the glyph
  and the position are the signal. The group is the head of the stored order,
  so `^N`, the rail numbers and the phone's `order` all read pinned-first, and
  pinned rows show their `^N` hint in every order. Pin, unpin and reorders
  inside the group apply at once (they are the user's own act, not a
  re-sort). Drag reorders inside the group in every order; in Manual a drop
  takes the target row's pin state, so dropping beside a pinned row pins and
  beside an unpinned row unpins. Pinning lands the row at the end of the
  group; unpinning at the top of the rest.
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
workspace areas remain usable. Selecting an agent closes Fleet by default. The
header’s session-only “Keep open after jump” option retains Fleet and its filters
for agent and review-task jumps while handing input focus to the destination.
Closing later never restores the pre-jump pane. Close, Ctrl+Shift+A and Escape
inside Fleet still dismiss it; Open diff and browser-help Jump always close it.
Fleet is an attention board (andon), not a map: one
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

**Ready to review (2026-09-25).** Between Needs you and Running, a fourth
section lists fan-out TASKS, not panes: one row per task whose record is open
and not detached and whose every agent pane reports complete (the sidebar's
close-finished rule; idle never counts). It is a section, not a tab: Fleet is
one roving list, and a finished task belongs in the same glance as what needs
you and what is still moving. The shared selector (`selectReviewQueue`) also
feeds the sidebar's `N to review`, so the two counts cannot disagree. Row:
green check + "Finished", task title, owner workspace · branch (mono), files
changed and +/− lines from a counts-only read (nothing drawn until it lands;
"Changes unavailable" if it fails — never a partial total),
`PR #N · state` when the metadata poll has one (or "PR linked" from the task
record) and time since the agents finished. Row click / Enter / d = Open diff
(the task diff surface); ⋮ also holds Open PR or Create PR (p), Jump to task
(j) and Close task (Backspace). Create PR and Close confirm inline with Cancel
first and focused; Close is the task close path and keeps a dirty or unpushed
task with the reason. One close or PR runs per task at a time; the row says
"Closing…" / "Creating PR…" meanwhile. The section shows under All and Complete filters and in
search (title, owner, branch); it is not drawn when empty. It is the second
rendition of a finished task (the pane rows in Needs you are the first), so it
gets no filter chip, tab count or footer badge.

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
