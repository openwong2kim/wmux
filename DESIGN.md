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
│ workspaces│  amber top edge; tab strip       │ ~326px       │
│ ONLY      │  with amber underline)           │ ┌ tabs ────┐ │
│ (mantle)  │                                  │ │Orch|Chan │ │
│           │                                  │ ├ Fleet ───┤ │
│           │                                  │ ├ Orch ────┤ │
│           │  [agent toolbar, text-first]     │ └ busy bar ┘ │
└───────────┴──────────────────────────────────┴──────────────┘
```

- **Left sidebar = navigation only** (workspaces). Agents do NOT live here.
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
- The terminal grid always gets the largest area. Any new surface must justify
  itself against "does this shrink the hero?"

## Color

- **Approach:** restrained. Warm graphite neutrals + ONE amber. Values are the
  `amber` theme tokens in `themes.ts` (`bgBase #151517 · bgMantle #19191C ·
  bgSurface #202024 · textMain #EFEEEC · textSub #A5A29C · textMuted #66645F ·
  accent #E8A33D · success #8FBF7F · danger #D96C6C`).
- **Amber grammar — amber means "alive + focus", nothing else:**
  running dots, spinners, terminal cursor, focused-pane top edge, active-tab
  underline, and the footer model name. Budget: **5±2 amber meaning-points per
  screen** (dots of the same class count as one system).
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
  13px body · 14px titles. Tabular figures for counters.
- **Hierarchy from typography, not decoration.** Speaker labels differ by
  weight/color (You = muted 600, Orchestrator = main 700), not by accent color.

## Spacing & Geometry

- **36px chrome module.** Every horizontal chrome row — titlebar, sidebar
  header/footer, pane tab strip, deck tabs, agent toolbar — is exactly 36px
  (`h-9`) so hairlines across the three columns land on the same y. A new
  chrome row must justify deviating from the module.
- Base unit 4px. Density: compact-leaning (rows 26–30px).
- Radii: **4px buttons · 7px cards/panels**. Never larger on chrome. Full-round
  only for status dots.
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
- Toolbar buttons are text-first, boxless until hover. AI-directed actions
  (fan-out, broadcast) are neutral at rest, accent on hover.
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
