# Design System — wmux

> SSOT for all visual/UI decisions. Read this before making any visual change.
> Token *values* live in `src/renderer/themes.ts` (`UI_THEME_TOKENS`,
> `THEME_STYLES`) and are generated into `src/renderer/styles/globals.css`
> (locked by `themeParity.test.ts` and `themeStyles.test.ts`); this file
> defines the roles, rules and layout contracts those tokens serve.
> Current contracts verified against the working tree on 2026-10-03.
> The sections before the Decisions Log are the current contract. Dated
> sections after it keep history; where they disagree with the contract
> (a colour name, a width, an overlay), the contract wins.
> Adapted token values and style recipes carry their source attribution in
> the code headers and in `THIRD_PARTY_NOTICES`.

## Product Context

- **What this is:** a terminal multiplexer for AI coders on Windows, macOS and
  Linux. It runs many terminal-based coding agents (Claude Code, Codex, …) in
  parallel, with an orchestrator brain, channels, schedules, remote pairing
  and reboot-surviving supervision.
- **Who it's for:** developers running fleets of CLI agents who need to steer,
  supervise and inspect them without losing raw-terminal ground truth.
- **Identity (owner, 2026-07-11):** **terminal-first.** Real terminals are the
  protagonist; chrome recedes and frames them. wmux is not a chat-first or a
  dashboard-first app — Fleet, Schedules and Remote are pages you visit and
  leave, and the terminals are where you come back to.

## Design Thesis

**"A quiet frame around live terminals."** The window is a dark (or paper)
frame holding one rounded sheet. Inside, surfaces are told apart by tone,
not by lines; each element draws at most one boundary; colour appears only
where it carries state. A theme changes the face, the hue and a handful of
shape knobs — never the layout or the grammar.

## Themes and token roles

Five built-in looks ship (owner decision 2026-10-03). **Tint is the default**
for a session that never chose a theme; a saved choice is always kept.

| Theme | Polarity | Accent | UI face | Chip radius | Selection | Active tab | Glass |
|---|---|---|---|---|---|---|---|
| Tint | dark, faint violet | `#9B8CFF` | Geist | 7px | fill (text 9%) | fill | yes |
| Zinc | dark, neutral | `#FAFAFA` | Geist | 6px | fill + 1px ring | fill | yes |
| Graphite | dark, cool | `#4C8DFF` | IBM Plex Sans | full round | fill (`#1B2433`) | fill + 2px accent underline | yes |
| Paper | light | `#5B5BD6` | Figtree | 7px | fill (`#E4E4EA`) | fill | yes |
| Amber Line | dark, warm | `#E8A33D` | Geist | 6px | 2px accent left bar | fill + 2px accent underline | yes |

Two neutral themes ship beside them, Mono and Mono Light (zero-saturation
greys, one blue accent). The other themes (Amber, Catppuccin, Stars &
Stripes, Red Dynasty, Nightowl, Gruvbox Dark Hard, Void, Monochrome, Hinomaru,
Taegeuk) and
Custom stay selectable with their own colours and take the `:root` knob
defaults; the frame, sheet, type, dialog and icon rules below apply to every
theme.
Geist, IBM Plex Sans and Figtree are bundled (`src/renderer/assets/fonts`,
SIL OFL 1.1, listed in `THIRD_PARTY_NOTICES`) so a look never falls back to
another face.

**Colour tokens** (one set per theme, `UI_THEME_TOKENS`):

| Token | CSS | Role |
|---|---|---|
| `bgBase` | `--bg-base` | the sheet: panes, pages |
| `bgMantle` | `--bg-mantle` | the sidebar column inside the sheet |
| `bgSurface` | `--bg-surface` | the look's fill for raised controls |
| `textMain` / `textSub` / `textMuted` | `--text-main` / `--text-sub` / `--text-muted` | titles and body · secondary lines · metadata, idle, disabled |
| `accent` | `--accent` (`--accent-cursor`, `--accent-blue`) | selection marks, focus, links, the running column |
| `success` / `danger` / `warning` | `--accent-green` / `--accent-red` / `--accent-yellow` | done, added lines · errors, removed lines · caution |
| `ATTENTION_COLORS` (fill / text / ink) | `--attention` / `--attention-text` / `--attention-ink` | needs you, everywhere: the attention orange, tuned per look |

**Fill ladder** (theme-independent, `globals.css`): fills, hovers, selection
and hairlines are the theme's text colour mixed into transparent, so every
theme (and a custom one) gets the same grammar.

| Token | Dark | Light | Used for |
|---|---|---|---|
| `--stroke` | text 5% | text 5% | structural hairlines and seams |
| `--line` / `--line-strong` | 10% / 20% | same | control hairlines / focused control hairlines |
| `--hover-fill` | 5% | 5% | hover on rows, rail items, icon buttons |
| `--selection-subtle` | 8% | 5% | Fleet cards at rest, header bands |
| `--selection` | 10% | 6% | the selected row, tab, rail item, chip |
| `--selection-hover` / `-emphasis` | 15% / 20% | 10% / 14% | hovered chip / pressed or active icon button; muted text on the hover fill draws as `--text-subtle`, on the emphasis fill as `--text-sub` |

**Style knobs** (`THEME_STYLES` → CSS variables on the theme's block; a knob
left unset emits nothing and the `:root` default applies): `--font-ui`,
`--chip-radius`, `--selection` and `--select-ring` (fill, fill + ring, or
left bar), `--group-case` / `--group-track` (sidebar group labels),
`--tab-underline` (0 or 2px), `--theme-glass`, `--stroke`, `--primary-fill`
/ `--primary-ink` (the solid primary button), `--title-weight`, `--frame-bg`
and `--sheet-edge`. A new knob is added to `ThemeStyle`, emitted by
`themeStyleCssVars`, and read by exactly one CSS rule per consumer.

**Terminal content owns its palette.** Each look has its own opaque
terminal palette (`BUILTIN_XTERM_PALETTE`); diffs are green and errors red
in the terminal whatever the chrome accent. A theme that borrows another
theme's palette with a visibly different background (Stars & Stripes, Red
Dynasty, Nightowl) keeps its ANSI
colours but puts the terminal on its own `--bg-base`, so the terminal never
reads as a second, differently tinted panel.

## Window: frame and sheet

```
┌ frame ─ titlebar 40px ───────────────────────────────────────────────┐
│ [lights][wmux      ◧]            (drag region)          [vitals][tree]│
├──┬───────────────────────────────────────────────────────────────────┤
│  │╭ sheet ────────────────────────────────────────────────────────╮ │
│r │ sidebar   │ pane tab strip                                      │ │
│a │ 264px     ├─────────────────────────────────────────────────────┤ │
│i │ (mantle)  │  terminal grid (THE HERO)                           │ │
│l │           │                                                     │ │
│48│           │  [agent bar — overlay, on approach]                 │ │
│  │╰───────────────────────────────────────────────────────────────────┤
└──┴── sheet flush with round window corners (8px in square ones) ─────┘
```

- **Frame:** the titlebar row and the 48px rail, painted `--frame-bg` — a
  step darker than the sheet in the dark looks, a soft grey in Paper. Where
  the window has rounded corners — macOS, and Windows 11 (build 22000 and
  later) — the sheet has no margin: it meets the window's edges, its own
  rounded corners kept. Square-cornered windows — Windows 10, Linux, and a
  Windows build that could not be read — keep an 8px margin
  (`--sheet-inset`) on the sides away from the rail and the bottom, so no
  frame notch shows in a square window corner. `data-window-corners` on
  `<html>` carries the decision (`shared/windowCorners.ts`).
- **Sheet:** one rounded panel (`--sheet-radius` 12px) flush under the
  titlebar, holding the sidebar and the panes (and the file tree column
  when it is shown). Nothing docks opposite the sidebar (the Bots page's
  right split — a worker's terminal or a thread beside the chat — is part of
  that page's body, not a dock). It is set
  off by a 1px `--sheet-edge` hairline and a faint `--sheet-shadow`, nothing
  else. Inside, the sidebar keeps its mantle tone; the pane column rounds
  off where it meets the sidebar (`--sheet-radius` on its two inner
  corners) with a 1px `--sheet-edge` hairline along the curve, and that
  line is the one seam. With the sidebar hidden the pane column drops both,
  leaving the sheet's own edge as the only boundary.
- **Native fullscreen** (any platform): the sheet drops its margins and
  radius. The rail stays.
- **Maximized on Windows** (whose maximized windows have square corners): the
  sheet drops its margins and the corners on the screen's edges are square.
  The one corner beside the rail and the titlebar meets the frame, not the
  screen, so it keeps `--sheet-radius`, with the hairline and the faint
  shadow along the top and the rail side, as in a windowed window (mirrored
  when the sidebar is docked right). Every rail page and the Workspaces page
  show the same corner: the sheet clips them all.
- **Terminal geometry is untouched** by the frame: margin changes, a sidebar
  collapse, maximize and fullscreen each refit the terminals once, never per
  frame.
- **Window glass (macOS on every theme, Windows 11 on every theme that stays legible, `--theme-glass: 1`):**
  on macOS the window gets the `sidebar` vibrancy material behind a
  transparent background; on Windows 11 22H2 and later (build 22621+) it gets
  the acrylic backdrop the same way. The
  renderer sets the app's appearance from the theme (a dark theme, the dark
  material; a light theme, the light one — app-wide, so native menus and the
  in-app browser's `prefers-color-scheme` follow the theme), and `data-glass`
  on `<html>` is set once the two agree. The frame then paints
  `--glass-frame` of `--frame-bg` over the material and the sheet adds
  `--glass-sheet` of the mantle under the sidebar; the panes and every
  terminal stay opaque, so the hero never changes with the wallpaper. The
  sheet's edge is then an ink of the text colour (10%), not the opaque
  `--sheet-edge`: over a translucent frame an opaque hairline reads lighter
  than the frame on a dark or tinted backdrop and vanishes on a light one,
  while the ink keeps the same step over any backdrop. The
  user picks Off, Soft (default) or Clear in Settings › Appearance ›
  Interface. Coverage of the sidebar, frame and sheet stacked: dark themes
  about 29% Soft / 14% Clear; strongly hued themes (Stars & Stripes, Red
  Dynasty, Catppuccin) about 64% / 43% so their colour survives the grey
  material; light themes, whose material is milkier, about 14% / 3%.
  Windows derives its numbers at runtime from each theme's tokens
  (`utils/glassCoverage.ts`), because there the text must stay legible over
  whatever is behind the window. The frame and the sidebar are composited
  over the worst backdrop (pure white behind a dark theme, pure black behind
  a light one), modelling the acrylic as fully see-through: real acrylic
  blurs and tints, so this is a conservative bound, not a measurement. The
  frame coverage rises in 1% steps from the level's floor (dark 30% Soft /
  12% Clear, light 55% / 35%; the sheet stays at 6% / 5% dark, 10% / 8%
  light) to the smallest value where `--text-main`, `--text-sub2` and
  `--text-sub` keep 4.5:1 and `--text-subtle` and `--text-muted` 3:1 against
  both the frame and the sidebar. The
  range stops at 90% (`GLASS_MAX_COVERAGE`), above which the glass no longer
  reads as glass: a theme where any of the five tiers still misses its floor
  at 90% is opaque on Windows as if glass were Off (material none, a
  solid caption strip), while the setting keeps the user's level. Glass
  draws a theme's own text tiers and row fills on both platforms, exactly as
  macOS does: no platform rule restates a text colour, and Windows has no
  glass-only lift. Nothing is pinned per theme, so a token change moves a
  theme in or out of glass on its own. Where the legibility minimum sits above both floors, Soft and Clear
  get the same frame coverage. The level the window last showed is saved
  (`windowGlassEffective`, beside the user's level), so main starts a theme
  that blocks glass opaque instead of showing acrylic until the renderer
  loads. On
  Windows the level switches the material at
  runtime: Off sets the material to none, the opaque frame background and
  a solid `titleBarOverlay` strip; Soft or Clear sets acrylic, a transparent
  background and a transparent strip (a solid one would sit as a band behind
  the caption buttons). Mica is not offered: it reads almost opaque. Windows
  10, Windows 11 before 22H2 and Linux are opaque; on those Windows builds
  the setting reads Off, disabled, with the reason. The page fades through
  `color-mix(… 0%, transparent)`, never the `transparent` keyword (which
  interpolates through black). `data-glass` carries the material's
  appearance (`dark` or `light`), which is how the light tuning applies to
  any light theme, custom ones included. With glass Off the app returns to
  the system appearance, and glass is only installed once the saved theme
  and level are loaded, so a launch never flips the appearance twice.
- `BrowserWindow.backgroundColor` and the page's pre-theme paint follow the
  saved theme's polarity, and the opaque Windows window is shown once it has
  painted, so the first frame is never the system's blank colour or the
  other polarity; no native menu bar is visible
  (`autoHideMenuBar`; accelerators keep working).

## Titlebar

40px (`TITLEBAR_HEIGHT`, shared with main's `titleBarOverlay`). The whole
bar is a drag region; each interactive child opts out with `no-drag`.

- **Left:** a segment tinted `--bg-mantle` and width-matched to the rail
  and sidebar below it, so the top-left reads as one panel: on macOS an 80px
  reserve for the traffic lights (centred in the 40px row, dropped in native
  fullscreen), then, left to right, the `wmux` wordmark and the **sidebar
  toggle** (on Windows and Linux the wordmark is at the far left). The
  wordmark starts `BRAND_INSET` (12px) past the reserve whether the sidebar
  is open or collapsed, so the brand never moves when the sidebar toggles.
  The toggle sits right after the wordmark, 8px from it, whether the
  sidebar is open or collapsed (collapsed, the segment takes their width
  instead of the rail's 48px; the look paints it transparent). It is a 28px square with a 16px panel icon (the
  bar drawn on the sidebar's side), the left-hand pair of the file tree
  toggle at the bar's other end. **Both titlebar panel toggles are bare icons:** no
  fill at rest and none when on — the icon and `aria-pressed` /
  `aria-expanded` carry the state —
  only the `--hover-fill` on hover and the focus ring. The sidebar toggle's
  name stays "Show sidebar" with the state in `aria-pressed`; the tooltip
  names the action and Ctrl+Shift+B.
- **No New workspace in the titlebar, ever.** The sidebar's `Workspaces N +`
  header carries it while the sidebar is open, and the rail's own `+` while
  it is collapsed, docked left or right.
- **Page title: one home at a time.** While the sidebar is open the
  highlighted row already names the workspace, so the titlebar shows
  neither the workspace's name, its task link nor its branch. With the
  sidebar collapsed they return right of the segment: the name, the task
  link and the branch (the shortcut to Git). On a rail page (Bots, Git,
  Fleet, Schedules, Remote, Plugins) the title is the page's name, with no branch,
  whatever the sidebar does. Settings follows the Workspaces rule.
- **Centre: the drag region.** Nothing sits between the left segment and the
  right cluster; the whole gap drags the window. The command palette has no
  titlebar entry: ⌘K (Ctrl+K on Windows and Linux) opens it, and the rail's
  More menu lists it so it stays discoverable.
- **Right:** Fleet vitals as appearing chips (`N running`, `N need you`; only
  when nonzero, and dropped while Fleet is the page), the account usage when
  it matters. The file tree toggle is not here: it is the agent bar's Files
  button (see File tree column). There is no room or bot panel toggle: bot
  conversations live on the Bots page.
  Settings is not here: it lives in the rail's More menu (and ⌘,).
- **Windows:** the native window controls sit at the right edge in the
  `titleBarOverlay` strip, drawn in the colour the frame actually paints
  (`overlayColors()`, one helper for every sender); the titlebar icons
  sit left of them inside the area the titlebar already reserves. Nothing
  anchored to the window's right edge starts above the titlebar: the OS
  draws that strip over any z-index, so the notification drawer hangs from
  `TITLEBAR_HEIGHT` on every platform.
- **Linux:** the native window frame stays, with its own title bar and
  controls above the 40px titlebar (a frameless window would lose drag and
  resize with nothing to replace them).
- The bottom divider, when drawn, is an inset hairline so the 40px content
  box stays exact.

## Rail and pages

The 48px icon rail on the frame is a **page switcher**. One `appRoute` in
the UI store owns the current page; every entry point — shortcuts, palette
commands, sidebar links, toast and notification jumps, schedule deep links —
navigates through it.

- **Pages, in order:** Workspaces (home: the sidebar and the panes)
  · Bots · Fleet · Schedules · Remote · Git · Plugins. Bots is listed only while the
  bots are on (Settings › Bots); off, its shortcut and palette command open
  Settings › Bots instead. Connectors have no rail item of their own: they
  are a row on the Plugins page, and the `connectors` route (deep links,
  commands) opens Plugins with that row selected — one redirect in the route
  layer, not a second page. A UI plugin's rail page (any whose trust is not
  denied) follows the built-in ones under a short `--line` hairline, with the
  glyph its catalog entry names (a package for a bundle the catalog did not
  install, even one placed by hand under a catalog id). Settings is a page too,
  opened from the rail's More menu or ⌘,.
- **The rail's foot** holds one `⋯` **More** button (named "More",
  `aria-haspopup="menu"`). Its menu, beside the rail and level with the
  button: Command palette (with ⌘K), Settings (with ⌘,), Keyboard shortcuts
  (Settings › Shortcuts),
  Check for updates (opens Settings › General, where the check reports, and
  starts it), then the version line as muted text. It is the pane actions
  menu's body (arrows, Enter, Escape, focus back on the button). The sidebar
  toggle is in the titlebar, so the foot carries no chevron.
- **Rail item:** a 19px icon on a 40px square. The current page is a soft
  `--selection` square (plus the look's `--select-ring`) marked
  `aria-current="page"`; hover is
  `--hover-fill`; Bots', Fleet's and Remote's needs-you counts are small
  number badges on the icon's corner. Every button is named, and the arrow keys move between
  them.
- **A page fills the whole sheet** (every rail page and Settings; with no
  dock there is nothing to leave in view beside it). The
  Workspaces page stays mounted at full size and **inert** under every page, so no terminal is resized or unmounted
  and PTYs, scrollback, the WebGL atlas and IME state survive the round trip.
  Showing a page drops focus left in the panes, and the focus self-heal runs
  only on Workspaces, so keys typed on a page never reach a hidden PTY.
  Coming back hands input focus to the active pane. A jump to a pane (Fleet,
  notifications, toasts, schedules) or a workspace switch returns to
  Workspaces.
- **Collapsing the sidebar** hides only the in-sheet sidebar; the rail stays
  (also in fullscreen) and carries the workspace list as its compact form,
  so the collapsed sidebar and the rail are one column. A toggle eases the
  sidebar's width over 190ms (ease-out; instant under
  `prefers-reduced-motion`); the titlebar segment does not animate. Terminal fits
  are held for the whole transition and released on the column's own
  `width` `transitionend` (or a fallback timer), so each pane's PTY is
  resized exactly once per toggle. Dragging the sidebar's edge never
  animates.
- The command palette and the notification panel float over any page
  without navigating. The web mirror keeps its own sidebar.

### PC switcher

Another computer is a **scope** of the Workspaces page, not a page and not a
column: the sidebar title switches it. With **0 web-paired computers** the
title is the plain "Workspaces" and nothing else changes (single-PC users see
no difference). A2A-only peers stay on the Remote page.

- **Title:** "Workspaces ▾" while this computer is selected, "Workspaces ·
  office-mac ▾" while a paired computer is; the host name keeps its own case.
  The list below is that computer's workspaces (opened as shadow
  workspaces), and the count is that list's. Its rows ARE the local row
  component (WorkspaceItem and its pane rows) reading a read-only projection
  of that computer: the host's order and 1..n numbering, status mark,
  needs-you card, idle label, branch line, and the
  expandable pane rows ("✳ Claude Code · w1-1") — filled only from what the
  host sends. Inside the host's own list its pane rows carry no "@host"
  origin mark. What the host does not send (unread, the done dot, the
  question text, git sync counts, stashed panes) and every local-only action
  (menu, rename, drag, drop, archive) are absent, never faked.
- **Dropdown** (the pane menu's look): this computer first, then each
  web-paired computer as a monogram row with its state on a second line —
  Online, Offline · last seen 14:02, Not checked yet, needs repair, or not a
  secure connection — and its needs-you count. The selected computer is the
  checked row. Under a divider, one "<name> settings ›" per computer opens
  Mute / Unmute notifications, Open Remote page and Pair again, with View
  only or Can type and how to revoke underneath. A host added with its
  operator link says so and suggests pairing again with a code; for a host
  paired before the credential kind was recorded, the menu names both ways to
  revoke and promises neither.
  An SSH host whose tunnel needs a person reads "SSH needs you" or, when
  its host key changed, "Identity changed" on the second line instead of a
  state, and the row opens the host check rather than switching to it. The
  last row, "+ Add PC over SSH…", opens the Add PC over SSH dialog.
- **Badge:** one `--attention` number badge beside the title, the sum of
  the needs-you of the computers **not** selected (this computer's Fleet
  count counts while a host is selected). The selected computer has none —
  its rows are the evidence. No amber, no wash.
- **Collapsed sidebar:** with a computer paired, one item at the top of the
  rail's workspace list — the computer glyph for this one, the monogram for
  a host — carrying the same badge and opening the same dropdown beside the
  rail. The rail's workspace avatars follow the selection: a paired
  computer's own workspaces (same avatar look), this computer's again when
  it is selected. A paired computer gets a new-workspace `+`, here and in the
  expanded sidebar's header, only when it granted this desktop workspace
  creation (an SSH-added host that advertises it); the workspace and its
  shell are created on that computer, never as a local stand-in.
- **Keys:** rebindable `Alt+Shift+↑/↓` cycles computers (as `Alt+↑/↓`
  cycles workspaces), `Alt+Shift+Home` returns to this computer; they are
  Settings › Shortcuts rows like any built-in, claimed only while a computer
  is paired and no custom keybinding sits on that chord. Never
  `Ctrl+Alt+digit` (AltGr on Windows). The dropdown walks with the arrows,
  Home and End; Escape in a settings submenu steps back to the list.
- **Shadow panes:** no split, no new pane and no layout snap (the host owns
  the layout); a new browser stays in the ⋮ menu as "Browser (this
  computer)". A host's terminal keeps the user's font size: a grid the pane
  cannot hold scrolls inside it (letterbox), never shrinks to fit.

### Bots

The agent factory's bots, read and talked to like a messenger (owner
decision 2026-10-13). A bot has no pane of its own; its workers are agent
panes in hidden task workspaces, and they are shown here, under their bot,
instead of in the Workspaces sidebar. A bot's worker is listed nowhere
else (owner decision 2026-10-14): not the sidebar (the active workspace
included), not Fleet's board, review queue or counts, not the rail and
status bar badges, `fleet_triage` or the phone's sidebar.

- **Layout (owner decision 2026-10-14, layout A):** the conversation list
  is the Workspaces sidebar's column — 264px on `--bg-mantle`, the
  sidebar's row metrics — and meets the body at one `--stroke` seam (the
  one-boundary rule). The body is the chat on `--bg-base`, then, when one is
  open, a 6px drag handle whose centre line is the one seam, then the
  worker's terminal or a thread (45% / 55% by default). The three column
  headers — the list's, the chat's name-pill row and the panel's — are one
  44px band ending on the same line, with no rule under the chat's. Under an 800px-wide page (an
  ~860px window) it is one column: the list first; choosing a conversation opens the chat over
  it, with a round back button left of the name pill and, for a bot with workers, a round
  workers button (an icon and the count) right of it that opens the bot's worker tree as a
  popover, so a worker is reached without going back to the list.
- **List:** the 16px title with Search, `⋯` (the page menu: Stop all
  bots, when main offers it) and `+` (a menu: Add bot — the Settings add
  form in a dialog; the bot it adds is selected — Add team — the same
  dialog with only the workspace and the repository (Add team, below) — and
  New group chat) as 28px icon buttons, in every state
  of the page; Search opens a filter field under the header (Escape closes
  and clears it). One row per conversation (8px 10px padding, inset 8px): a 32px avatar, the 13px/500 name
  with the newest message's time, and one 12px muted preview line (the
  owner's own as "You: …", a group's prefixed with who spoke; a bot whose
  newest post is in a group, "In <group>: …"). Every bot is
  a 1:1, and the rest are the **group chats the owner made** (owner
  decision 2026-10-15, the reference messenger's model): no workspace has a
  room by itself, however many bots it has, and no bot ever makes one. A
  1:1 and a group are separate conversations, never mirrors: a 1:1 is its
  own thread of the bot's room — what the owner and the bot say there, and
  the work it starts there — and a group is its own thread too
  (`group:<id>`) with the work started from it; neither shows the other. A
  workspace whose General is no group's shows what its bots say there in
  their 1:1s. Groups and bots follow by latest activity; nothing is pinned
  (the workspace an earlier version made the HQ is a workspace like any
  other). The selected row is the `--selection` pill
  (10px radius), hover `--hover-fill`. A row with unread bot messages
  (this session) carries a neutral count — a 16px `--selection-emphasis`
  pill — and its preview in `--text-sub`; when the row needs the owner the
  orange needs-you count shows instead.
- **Archive (owner decision 2026-10-21):** a deleted bot whose 1:1 holds
  messages is not a row among the live conversations: under them, at the
  list's foot, one muted 11px fold — "Archive", its count and a chevron, no
  fill or rule — holds those 1:1s, folded until toggled (open while
  searching or while one of them is open), in the list's row look with the
  name muted and "(removed)". One opens read-only (no composer or profile);
  under its note sits **Remove from Archive**, a destructive secondary that
  asks in place (InlineConfirm: the chat leaves the list for good, its
  messages stay saved and what it wrote in group chats keeps its name).
  The tombstone stays, marked, so its cards keep its name and face.
- **Workers in the list (owner decision 2026-10-14):** a bot's workers nest
  under its row the way the Sidebar nests a workspace's fan-out tasks: an
  indented row each on a `--stroke` guide under the avatar — the Sidebar's
  status mark (running a muted dot, waiting on the owner the attention
  ring, an error a cross, done a check, a task the owner stopped no mark
  and the neutral word "Cancelled"), the fan-out mark and the task's
  title in 12px, what a worker waiting on input asks in the needs-you text,
  and under it the branch with its `+N −N` diff counts. Live workers come
  first, then ended tasks (done, failed or cancelled) while their workspace is still
  open; a row drops off when its workspace is cleared. A fold toggle — the
  count and a chevron — sits inside the bot row's right edge, under its
  time. **The open conversation is one group** (the Sidebar's selected
  workspace and its tasks): its row and its workers in a single rounded
  `--selection` fill, no border and nothing boxed inside it; its workers are
  unfolded, other bots' folded until toggled. A click shows the worker's
  terminal in the panel beside that bot's chat (selecting the bot); the
  worker shown there reads in the title weight beside its state mark — no
  second fill. The panel never opens by itself — a new row with its running
  dot is the signal. A worker row carries one dot, its state mark: the git
  line shows the diff counts, not its clean dot. A group row lists none
  (each worker sits under its bot once).
- **Group chats (owner decision 2026-10-15):** the owner makes them — `+` ›
  New group chat opens a dialog: the workspace (those with bots), a name
  and a checkbox per bot of that workspace, with one muted line saying a
  group's bots are that workspace's only (they share it and its
  repository); a workspace with fewer than two bots says so and Create stays off,
  as it does with no name or fewer than two bots ticked. The group made
  opens. A group's name pill opens the same dialog to rename it, change its
  bots, or Delete group (asked in place: its messages stay saved, the row
  goes). A group with nothing said yet reads "Write the first message:
  every bot here answers and introduces itself.", or, in a group with a
  coordinator, "Write the first message: it goes to <lead>, who leads this
  group and hands the work on." Nobody greets first in a
  group and no "joined" line is drawn: each bot the owner's first message
  reaches introduces itself in its answer (its wake asks it to; no canned
  card), and a bot's greeting stays in its 1:1. A room the owner had
  written in before group chats became a group named after its workspace,
  with that workspace's bots, reading on in General; a room the owner never
  wrote in is just no longer listed.
  In a group chat a bot woken by the owner's message or another bot's
  mention may react instead of speaking, and one that stays silent leaves
  an acknowledgement (shared/botGroupProtocol.ts). These sit under the card
  they answer as one row of 20px chips: one chip per emoji and kind (a
  picked reaction and an acknowledgement of the same emoji are two chips),
  with `--selection` fill, 11px `--text-sub` text, and a tabular count when
  more than one bot left that chip. The chip's label names who reacted ("Lead reacted ❤️")
  or, for acknowledgements, who saw it ("Verifier saw this"). The emoji are
  the bots' content, like an emoji in a message, so the no-emoji rule for
  chrome does not apply. No colour, and nothing to click: a reaction is
  read, not answered.
- **Avatars (owner decision 2026-10-16, the Mochi crew; replaces the
  2026-10-14 shapes):** a bot's avatar is the picture the owner set for it —
  the picture always wins — else its **Mochi character**, one of eight
  (Loaf, Nova, Plume, Wink, Momo, Pip, Koa, Nub; "Mochi Orb Crew v2", drawn
  by Grok). The character is the bot's **identity colour slot**: slot *i* of
  `BOT_IDENTITY_HUES` is character *i*, whose body wears that colour, so each
  character keeps its designed colour. The slot is per room, oldest bot
  first, in a fixed spread order (teal, violet, magenta, blue, slate, then
  the rest), so a room's bots never share a character while the eight last
  and its first five read apart; a bot keeps its character while it exists.
  The characters' own colours are the same on light and dark looks; the
  bot's name keeps the identity colour mixed toward `--text-main`. The add
  form's not-yet-made bot is a still, neutral grey mochi (`--text-muted`),
  never an identity. One shared `BotAvatar`, the same character everywhere;
  each instance owns its gradient ids, so repeats and hidden panels never
  share one. **Motion** (the one perpetual avatar motion, owner-approved
  with the art): at rest a character breathes, blinks on its own stagger and
  makes one signature twitch every few seconds; while its bot is running
  (`working`, passed only where it reads as "busy now": the list row and an
  empty 1:1's intro) it hops and twitches quicker. Transform only. At 24px
  and under it only blinks, working or not, so pills and stacks stay still.
  An avatar off screen or in a hidden panel is paused, and
  `prefers-reduced-motion` stops all of it. A room stacks two of its
  bots' avatars and "+N" for the rest (the chat's centred pill shows up to
  three overlapping in a row) — a group chat's, its bots'. A bot's presence dot (the room's presence
  grammar; not reported is a hollow ring) sits on its avatar's corner.
- **Needs you:** the one coloured mark is the attention badge on a bot's
  row: its open questions, its open plan (its newest; an older plan left
  open is superseded) and open proposals, plus its workers waiting on the
  owner — a waiting worker its bot's open question already asks about (the
  question's task) counts once. What a bot asks in a group counts on that
  bot's row too, and while nothing it waits on is in its 1:1 the row leads
  to it: a click opens that group with the newest waiting card's thread
  beside the chat. Group rows carry none (every question has a bot that asked it), and the
  rail badge is the sum of the bot rows — one count, read from one model.
  While the bots are paused nothing on the page can be answered, so
  nothing is counted (rows and rail alike).
- **Chat:** a centred name pill (avatar, name, presence; a group's bot
  count) in the chat's 44px header row, the messages under it with no rule
  between. A group's pill opens its settings (Group chats, above); a bot's
  pill opens
  the bot's profile (template, job — the owner's words, with Edit —
  workspace, repository — with Change, Add bot's folder picker, checked
  as at creation (a refusal says why in one line) — the model it thinks
  on (its own model and effort, as text with a muted Change that opens the
  model combobox of Settings › Agents roles and an effort Select, with
  Cancel and Save; an invalid model id is refused in one red line before
  main is asked, and main checks it again) — what its workers run on — a native Select:
  Default (the presets' engine) or an installed engine that has a worker
  guard, one not installed listed but disabled — its workers' model and
  effort (the same model line, for that engine) — on/off and presence
  (right after Resume, "Resuming…" until the runtime reports, for 10 s at
  most; then as any bot with no turn yet),
  then Today (owner decision 2026-10-16): on top, one muted line naming the
  first thing that keeps the bot from new work — paused by the owner,
  stopped after errors, the usage limit until a time, out of turns until a
  time, out of worker time for today (with its reset), its workers at its
  cap, the factory's workers or agent slots full, its queue full — with a
  secondary Resume while it is parked; under it one muted line per limit in
  tabular figures: turns this hour (only with an hourly cap) and today,
  used and left; worker time used of its cap; worker slots in use of its cap (the cap counts slots held, so a task in
  review whose worker still holds one is named: "2 of 3 · 2 held by tasks in
  review");
  the queue of its cap (only when not empty); a line at its limit in the
  caution yellow. Above those limits (owner decision 2026-10-18), when wmux
  holds a usage reading for it, the account a Claude Code brain runs on
  (its name, or "Default Claude login") and that account's 5-hour and
  weekly limits ("5-hour", "Weekly"), percent used with the reset time;
  below them, once a turn reported one, the engine's cost estimate, "Cost
  ≈ $0.50 today · ≈ $2.25 in all (API-equivalent)", never a charge (a
  subscription is not billed it; the hint says so). Every Today row is one
  two-column grid: labels never wrap and every value starts at the same x,
  its routines, its connections — each library connection that applies to
  it, an every-bot one with a switch that turns it off for this bot alone,
  a picked one with Edit and Remove from this bot, then Add connection and
  Manage (Settings › Bots › Connections); its skills and memory (Skills, Memory, below); then, read-only, what it can do in the owner's words — one phrase per power of
  the shared surface, plus a Coordinator's reads in every workspace, never
  per-bot settings — whom it reports to (You), and its workers now; last,
  Pause — a neutral secondary that parks the bot at once, with no confirm
  (it is undone by Today's Resume, which then shows with "Paused by you"),
  shown while the bot is on and not parked — then
  Stop — the bot's turn and its workers — a
  destructive secondary that asks in place, the solid red only on its
  final confirm, never a window dialog; under it Delete bot, the same
  destructive secondary asking in place, its confirm saying what happens:
  its messages stay, its running workers stop, its routines go) as a popover that fits the chat: on a
  short window it scrolls inside (16px off the chat's foot), so Stop at its
  end stays reachable. A stop's result is a
  toast naming what stopped (counts at zero left out). The pill floats
  centred at the top (a room's shows up to three of its bots' avatars
  overlapping in a row); the narrow layout's back button stays on the left.
  The messages, the rail and the composer sit in one column capped at
  **44rem**, centred; while a side panel is open the column fills the
  chat's width instead.
- **Skills (2026-10-16):** a bot writes its own skills — procedures, not
  facts — and the owner approves each one. In the profile, under its
  connections, a Skills row lists them one line each: the name, then muted
  where it stands ("approved 1.1.0", "waiting for your approval (1.0.0)",
  "approved 1.0.0 · update 1.1.0 waiting for your approval", "archived",
  or after "approved 1.0.0" the muted note that it changed since approval
  and does not load until the bot proposes it again);
  an approved skill's name is in the main text colour, every other one
  muted, and the description is the row's tooltip. An approved skill adds,
  muted, when the bot last read it ("last used 3d ago", or "not used
  yet"); one approved and unused for 30 days carries a neutral **Stale**
  tag (`--selection`, `--chip-radius`, 11px; no colour — it still loads,
  its tooltip says so) and stale ones sort first, longest unused first, so
  the owner can archive them. Each one not archived
  has a muted text button, Archive, which acts at once (a skill is
  proposed again by the bot, never restored by hand); a failure is one red
  line under the list. With none, one muted line says when a bot proposes
  one. There is no Approve in the profile: a proposal is decided on its
  approval card in the chat, the same card as every other approval
  (Approve / Deny, no Always allow — a rule never covers a skill, and the
  owner's typed "ok" does not approve one), titled "Add the skill <name>
  <version>?" or "Update the skill …", its body the bot's one line, what
  Approve and Deny do, then the change as a `diff` code block (removed
  lines `- `, added `+ `), always whole: a proposal whose change would not
  fit the card is refused to the bot, never cut.
- **Memory (2026-10-21):** under Skills, a Memory row shows what the bot
  keeps for its later sessions in two lists: its own notes, and About you
  (the owner's profile, shared by every bot). Each list's muted title
  carries how much of its limit is used ("312 of 2200 characters"); its
  entries are main-text lines, each with a muted Remove that acts at once;
  a list with entries has a muted Clear that asks in place (InlineConfirm,
  the solid red only on its confirm, which says whose sessions start
  without it). An empty list is one muted line; a muted hint under both
  says changes apply from the bot's next session; a failure is one red
  line. There is no Add or Edit: a bot writes its own notes, and a change
  to About you comes as an approval card (its title "Add this to your
  profile?", "Change this in your profile?" or "Remove this from your
  profile?", the exact entry fenced, replace showing Now and Becomes),
  approved on the card only, as a skill is.
- **Recipes (2026-10-21):** Add bot has a Recipe row above "Start from": a
  native Select (None, then the recipes in three groups — sign in with one
  click, an access token, your own OAuth client). A recipe sets the Custom
  template and prefills the job by the chips' rule (it replaces only its
  own prefill); a chip pressed after it clears it. Under it one muted line:
  what it does, which services it reads, "needs your own OAuth client"
  where it does, "macOS and Linux only" on Windows, and that nothing is
  connected by it. It grants nothing. A bot made from one has a Recipe row
  in its profile, above its connections: the recipe's name in the main
  text, then one line per service it needs — the name (main text once
  ready, muted otherwise) and its state as a muted text button (Checking…
  until the library and its sign-in are read, Sign in needed or Token
  needed, Not given to this bot, Tools not picked, Ready to try — "· with a
  key" for a keyed connection — or macOS and Linux only) that opens
  Plugins › Connectors — then, while one has a step left, one muted hint,
  and once one is ready, one muted line saying wmux checks again when a
  worker starts (read-only tools, the command sandbox) and the bot says in
  the chat why if not. No colour: a state is words. No recipe offers a
  schedule while a signed-in task can run only once per bot conversation.
  The first-run panel offers the same form under its repository line, as
  the muted text button "Start from a recipe…".
- **Commands (2026-10-21):** under Memory, only where the bot runs
  commands at all (a Claude SDK bot, the OS sandbox present, a new enough
  Claude Code), a Commands row: first "Let this bot run commands" with a
  Switch (on by default; off, the bot holds none of the command tools) and
  a muted hint; then Recent, main's decisions newest first, 20 at a time
  with a muted Show more: the command or path on a main-text mono line,
  under it one muted line — Allowed, or Refused in the danger red (the
  word only), the time, the tool, where it was decided (a reviewer
  verdict with its risk and rationale) and main's reason. A command that
  needs an owner rule (not on the list, a script, or refused by the
  reviewer; never a built-in or the floor, never a line holding two such
  commands) carries a muted Always allow that adds a rule for exactly that
  command, after one caution-yellow line (every rule: a program not on
  the list may run code from files in the bot's folder), "This lets the
  bot run code from files in its folder, which the bot can change. It
  still runs in the sandbox: no network, and no files outside the bot's
  folder.", with Allow anyway and Cancel. A rule covers only a line that
  is that one command, with no redirect. Main's refusal shows as one red
  line. The reviewer itself is one factory-wide switch in Settings ›
  Bots, "Review unlisted bot commands" (on by default).
  Last, Your rules, one mono line each with a muted Remove that acts at
  once; empty lists are one muted line. No fills, no chips.
- **Messages are bubbles in runs (owner decision 2026-10-14, the reference
  messenger's look; replaces the same day's flat rows):** a bot's messages
  on the left in soft `--selection-subtle` bubbles (18px radius, fill only,
  no border), the owner's on the right in the user bubble's content-10%
  fill. A **run** — one author's messages, each less than ten minutes after
  the last, nothing between them — shows, in a room, the bot's name in
  12px above its first bubble, and the bot's 28px avatar once, beside its
  last bubble (bottom-left); bubbles of a run sit 4px apart, runs 12px, a
  bubble at most 78% of the column (density, owner decision 2026-10-14). A 1:1
  shows no name for its own bot (the pill names it); another bot speaking
  in it (work its 1:1 started) is named as in a room. The full date and time is the
  bubble's tooltip. A bot's kind word (Verdict, Report; a refusal's red, a
  budget's yellow, a waiting card's needs-you text) and a verdict's word
  sit in 11px muted at the top of its bubble; the title and body read as one
  14px/1.45 `--text-main` text, in full (no Show more) — a question or
  greeting card's body too; the owner's text is
  markdown too. A GitHub pull request or issue link in a message is a
  compact chip — its line mark, `#N` in mono and the title when a thread of
  the room knows it — that opens that thread beside the chat, else the page
  on GitHub. Code blocks have a fill and no border (one boundary), a muted
  language label, a Copy that shows on hover or focus, and a 320px cap that
  scrolls inside. An `html` block carries them on a row above it with a
  compact **Preview / Code** segmented control, Code first (a block is often
  a snippet); Preview draws the page in a sandboxed frame at the same cap,
  on white, with one muted line under it: links are off. **A card that waits on the owner stays a distinct card
  inside its run:** an open question is the room's own question card,
  answered in place; a plan, a proposal, an approval, a key or a login
  request waiting on the owner sits in a 14px-radius card whose only
  boundary is the needs-you hairline, with its answers (one shared
  component: a plan's Approve — the primary — Edit and Decline, a
  proposal's Approve / Decline) under the title. A plan names each
  workspace by its name, never its id ("a workspace" when it is not one
  here). The delivery line ("Sent to Lead", "Queued for Lead") sits under a
  message sent from here; once the bot has taken the message up it stays
  "Sent", whatever turn the bot runs later.
- **Date and time, and new:** a centred 11px muted label with the weekday,
  date and time in the reader's language ("Sun, Oct 11 · 8:37 PM", "10월
  11일 (일) 오후 8:37"; the year only when it is not this one) at each new
  day and after an hour's quiet; the label alone divides, no rule. A chat
  opened again marks what arrived since it was last read to its end with a
  muted "New" label and one `--stroke` hairline; what arrives while the
  chat is in view is read as it lands and gets none. Scrolled up when
  something arrives, a floating "N new" pill (the name pill's look) above
  the composer goes back to the end. The read position is kept for the
  session only.
- **System lines:** a system card — a refusal and its reasons, a gate's
  result, a task's end, an error — is a centred 11px muted line (a
  refusal's kind word red, a budget's yellow) with its body folded to two
  12px lines under Show more; a line with a body reads left as a whole
  (header, body and chip), one alignment per line. Consecutive system cards of one thread merge
  into one line naming the first three and "N events", the red and yellow
  words kept; it opens into the lines themselves. A 1:1 holds the system
  cards of its own thread; from before 1:1
  threads (and, for a lone bot, from the room too) those naming the bot or
  its task, or written in a thread it wrote in. Those of the work a 1:1 or a
  group started — and main's lines about it there, "Finished: …" — are
  steps of its work card (Threads), not lines (owner decision 2026-10-16).
- **Threads (owner decision 2026-10-14):** a thread other than General shows
  in the timeline as its first card (its root) — a system line (a task's
  start) as much as a message — carrying the thread's chip when its name
  says something (a PR's or an issue's reference in mono, `acme/api#12`, or
  a task's title, or for a coordinator's request thread the first line of
  the owner's message that opened it; a bare kind such as "Request" is left
  off a root) and,
  when it has replies, "N replies · last 14:02" under it. The bot's newest
  reply in a thread also shows in the timeline, marked "in thread" with the
  thread's chip, so a finished task's answer is read without opening it. The chip or that line opens the thread in
  a **side panel** beside the chat, and the timeline stays where it was:
  one `--stroke` seam, a 40px header (the thread's name, Close), the root,
  a muted "N replies" line, the replies as runs, and its own composer
  ("Reply in thread") that posts into the thread; its "Approve N pending"
  chip counts the thread's own cards. The other cards of the thread live in
  the panel, except a card that waits on the owner, which also stays in the
  timeline. A card posted where the bot talks with the owner about another
  thread's subject (an approval in General about a PR) carries that
  thread's chip too, and shows in its panel. Inside the panel no row names
  the panel's own thread.
  **Work handed off (owner decision 2026-10-16):** a thread the
  conversation started (a coordinator's request thread, from a 1:1 or a
  group) shows none of that: it is one **work card** at its root's place —
  right after the delegating bot's message announcing it, when there is
  one — inside that bot's run — 14px radius, a `--line` hairline and no
  fill, a bubble's width at most. First, in 11px muted, the delegate's 16px
  avatar, "Handed to <bot>" and "· <state>": a steady 6px muted dot and
  Working (Waiting for review once its task reported), the needs-you dot and
  text while anything in it waits on the owner, a success check and Done,
  Failed in red, a neutral Cancelled. Then the work's name in 14px/500 (the
  title the delegating bot gave it, else the first line of the owner's
  request), the delegate's newest message in 13px `--text-sub` (two
  lines at most), and a foot: the PR or issue chip, "N steps · last 15:12"
  and a ghost Show steps ▾ (24px). It expands in place: a `--stroke`
  hairline, the cards folded into it as one-line steps (time, the actor's
  16px avatar or a system line's grey dot, its owner-facing words, a
  refusal's red word kept), then Open thread and Hide steps ▴ — the one
  toggle while it is open (the foot above keeps the chip and count). Expanded is
  per card, for the session; folded by default. Its waiting cards still
  show in the timeline, and Open thread shows the whole thread.
  **No internal id in the owner's view:**
  a task's, a request's or a routine's id is only in a chip's tooltip; a
  routine card shows its schedule (never the instructions the bot gave
  itself); a refusal shows its plain sentences (never the reason codes); a
  line main wrote names a bot without a role tag ("Wmux Dev", not "Wmux Dev
  (lead)").
- **Working rail (owner decision 2026-10-14):** what is happening now sits
  in one rail right above the composer, never at the end of the history.
  Each bot whose turn runs, on one line: a steady 6px muted dot, "<name>
  working · 0:14" (the elapsed time in tabular figures, ticking each
  second), its queue ("2 queued") when it has one, and **Stop** — a neutral
  secondary that interrupts the turn only (the profile's Stop also ends the
  bot's workers); the outcome is a toast. The workers themselves are rows
  under their bot in the list (above), not here; the rail keeps only the
  tasks the list cannot show — waiting for an agent slot, or done and
  resumable with their pane cleared — one 28px row each with Resume; three
  rows, then "+N more". No spinner or shimmer. With nothing working it is
  not drawn.
- **Worker panel:** a worker row in the list (and a Resume that started,
  or a notification about a bot's worker opened while the page is up)
  shows the worker's terminal in a panel beside the chat, on the Bots page,
  and never switches the active workspace (owner decision 2026-10-14): a
  44px header on one line — the worker's name in 13px/500, "· its state" in
  11px (the needs-you text while it waits), a `⋯` menu (Open in Workspaces,
  and Resume for an ended task that can resume) and Close as 28px icon
  buttons — and the terminal right under it, live and typed into in place.
  The panel only views the worker: the pane's tab strip and its split,
  browser and zoom controls stay on Workspaces. A side panel and the chat
  share the area right of the list across the 6px drag handle on their seam
  (also arrow keys when focused): the panel takes 55% by default, 30–75%,
  never under 320px, the chat never under 360px; the share is kept per
  window. A drag moves a guide and applies the width on release, so the
  terminal is resized once. A bot worker's launch line clears the screen
  before it runs, so the panel starts at the agent's own screen. Under a 720px chat area the panel covers the chat until Close.
  One side panel at a time: a worker's or a thread's.
  A file a bot attached opens in that side panel from its chip (44px header:
  the name, "· its size", Save a copy, Close). An HTML file opens as Preview,
  the same Preview / Code control in the header before Save a copy, the page
  sandboxed on white with the links-off line under it; past the panel's text
  size it is its source only, with no control.
  Another conversation closes it. The worker's terminal has one mount:
  while the panel shows it, Workspaces does not. A worker that also holds a
  browser or an editor stays on Workspaces (their state would not survive
  the move): the panel says so in one muted line, with Open in Workspaces
  (secondary).
- **Empty 1:1:** the bot's 48px face, "Start your chat with <name>", its
  job in one muted line, and three first messages as chips (the composer's
  chip style) that fill the composer (they never send by themselves).
- **Composer:** one rounded pill at the foot (22px radius, a `--line`
  hairline, `--line-strong` while focused): "+" on the left — a menu of
  first messages to put in the box and, in a group, the bots to address —
  a muted picture button beside it (Attach photos: a PNG/JPEG picker), the
  text ("Message <name>"; "Reply in thread" in a thread), the muted
  dictation mic (see Dictation under Component Rules), and the
  round primary send on the right. Photos (owner decision
  2026-10-18) use Chat view's grammar: each staged photo is a chip above
  the pill (thumbnail, name, × or Backspace at the start of the box removes
  it), from the button, a paste or a drop on the page, at most four; a
  refused one says why in the status line; a photo alone may be sent. The
  owner's sent card shows them as thumbnails above its words (none for a
  photo-only message) and a click opens one fitted in a dialog. A 1:1
  message is addressed to that bot alone. A group's message goes to every
  bot of the group (they may answer each other) — or, in a group with a
  coordinator that is on and not paused, to that coordinator (and to any
  bot waiting on the owner's answer in that thread), which hands the work
  on (owner decision 2026-10-21) — unless bots are picked: the **recipients control**
  right above the pill, a 24px chip "To: everyone ▾" ("받는 봇: 모두 ▾";
  "To: <lead> ▾" in a group with a coordinator, without a fill since it is
  the default; "To: <names>" in the `--selection-emphasis` fill once some
  are picked) that opens a checkbox per bot of the group (the "+" menu's
  popover place) with one muted line: none ticked goes to everyone (to the
  lead, in a group with one), and the picks reset after each send. An `@`
  and a group bot's name anywhere in the message ticks that bot too, and an
  `@` naming no bot of the group is plain text (owner decision
  2026-10-15). A reply in a thread the group started goes to the picked
  bots or the whole group. Typing `@` and the start
  of a name lists the group's bots that match in a popover over the box
  (the "+" menu's place and rows, the caret staying in the box): the
  arrows move, Enter, Tab or a click puts `@Name ` in, Escape closes. A bot that
  is off says so under the box and sends nothing. While a bot's approval
  request waits and its card is in the conversation — a group's view, or
  the asking bot's 1:1 — an "Approve N pending" chip sits above the box,
  whatever thread the card is in.
- **Bots off (owner decision 2026-10-15):** the page and its rail item
  exist only while the bots are on. They are turned on in Settings › Bots
  (the "Bots on" switch, whose description says it adds Bots to the
  sidebar); the rail item appears at once and Settings stays open. Turned
  off while the page is open (in Settings, or Turn bots off in the plan
  consent), the page leaves for Workspaces and the item goes. One wording
  for the switch everywhere — "Bots on" in Settings, "Bots are off" and
  "Turn bots on" (ko: 봇 켜기 / 봇이 꺼져 있어요). Should the page still
  meet the bots off for a moment, it is read-only (the composer says why
  and sends nothing) under a notice row on the header band's
  `--selection-subtle` fill: "Bots are off", one muted line, and Turn bots
  on (the primary; it writes the same setting Settings does).
- **Add bot (2026-10-13):** a name is all a bot needs. The form: workspace,
  name (required), picture, "Start from" template chips (the composer's
  chip style; one pressed at most) that prefill the job — a chip replaces
  only its own prefill, never words the owner typed — the job (an optional
  plain textarea) and the repository, always shown as one line — "Works on
  owner/repo" with Change and None (inherited, suggested, or a picked
  folder; None works on no repository), never attached silently. No role
  picker. In Settings › Bots, Add is there whether the bots are on or off;
  while they are off it asks once in place ("Bots are off. Adding <name>
  turns bots on.", Turn bots on and add). A
  disabled Add says why in one muted line (no name, an invalid name, no
  workspace). After Add the new bot's chat opens at once with "Starting
  <name>…" until its greeting arrives. The new bot greets the owner and asks
  what to do, with choices, in its 1:1 (the question main marks as the
  bot's greeting); no group shows it, and no group draws a "joined" line.
  A bot's `job_changed` card carries
  Undo (secondary). **Add team** (`+` › Add team, the form with only the
  workspace and the repository and Add team as its primary, or a ghost
  button beside Cancel in Add bot, while the chosen workspace misses one
  of the team's roles; owner decision 2026-10-21) adds the team's bots that
  workspace does not have yet, at once, to that workspace and repository —
  the lead (a coordinator) first, then research, developer, issues and
  reviewer, named in the owner's language ("Developer 2" when a bot there
  has the name) — with no name field needed. The form says in one line what
  it adds and which roles are already there ("This workspace already has
  the whole team." with Add team off); a toast names them after. Only a lead
  made here greets, in its 1:1, and its chat opens; else the lead it had
  opens. Its tooltip names the five and says the owner talks to the lead. Add
  team makes the bots only, never a group (owner decision 2026-10-15):
  then one notice under the list header, on the `--selection-subtle` fill,
  says the team was added (that line and its × on the first row) and offers
  **Make a group chat with this team** on its own row below
  ("이 팀으로 그룹 채팅 만들기", secondary; × dismisses it), which opens New
  group chat filled in — the workspace's name and the five ticked.
- **First run (owner decision 2026-10-14):** with no bot yet the page is
  one centred panel: "Name your first bot", one muted line (it works in
  <the current workspace>, greets you and asks what to do), a name field
  and Start (the primary). The page is reached with the bots on, so Start
  adds the bot to the current workspace and opens its 1:1, where its
  greeting arrives. When the Claude engine cannot sign in the panel says why in
  one line and offers Log in to Claude (and Check again); Start waits until
  it can. A build that cannot tell never blocks Start. Beside Start, a
  secondary **Add a team (lead + 4 roles)** does the same for the five-bot
  team (no name to type), opens the lead's chat and offers the group chat
  row (Add bot, above).

### Fleet

One attention list with a detail area under it — see "Fleet page" after the
Decisions Log for the full contract.

### Schedules

A 300px list beside a main pane. The list: the title, New schedule, a filter,
then one row per schedule (its name over a muted `next run · schedule` line;
turned-off schedules dimmed). The main pane shows the selected schedule,
the composer, or — with nothing selected — "Schedule a task" and six
development templates (repo briefing, nightly tests, dependency audit, flaky
tests, changelog draft, issue triage) that open the composer filled in.

- **Composer = one prompt box.** The name follows the prompt's first line
  until it is typed over. A row of chips under the box sets the schedule
  (daily, weekdays, weekly or picked days, and a time), the folder (the
  current workspace's by default) and the agent and account, each in a small
  popover. Permission, model, effort, the missed-run window and the response
  limit sit behind More options at their defaults. One primary action
  (Create, Save or Turn on) and Cancel; a problem shows under the part it is
  about.
- **Missed while asleep:** after the computer slept through scheduled runs,
  one notice under the list header on the `--selection-subtle` fill: "N runs
  missed while asleep", a muted line that Run now starts each schedule once,
  then Run now (secondary) and Skip (ghost) on their own row. Either answers
  it; until then the sidebar's Schedules row counts it once as needs you.
- **Detail:** the name, the on/off switch, the next run, Run now and Edit,
  then the run history (status dot, start, duration, result, Open for a live
  run). Dividers are `--stroke` hairlines.
- **Bot routines:** under the schedules, a muted "Bot routines" heading and
  one read-only row per routine a bot keeps for itself (its title over a
  muted `bot · schedule · next run` line; a paused one dimmed, with why). A
  bot sets and pauses them in chat; nothing here edits them. Not drawn when
  there are none. A bot's profile lists its own the same way.

### Remote

One page, Tailnet first, filling the sheet with 28px sides
(14px under a 640px sheet). It is the one place PCs are connected, seen and
removed, whatever carries them (A2A, a workspace share, a LAN PIN);
Settings › LAN keeps only the listener switches. Top to bottom:

- **Header:** the 16px title, then one muted line that sums it up
  (`2 of 3 PCs connected · 1 of 1 phones connected`, or `Nothing connected
  yet`; never orange). On the right, LAN messages (only while some wait) and
  **Connect a PC…** (secondary).
- **This computer — one line** on a `--selection-subtle` band: this PC's
  name, phone access (`off` / this computer only / local network / Tailnet),
  the A2A state (`A2A :45660 listening`, the listener's error, or `A2A off`)
  and a **Details** toggle. While phone access is off, Share & pair sits on
  the line (its popover leads with Pair a phone, which starts sharing and
  shows the QR in the same click. It is offered only once the address will
  be reachable: a usable tailnet ticks HTTPS over Tailscale visibly first,
  never the LAN; otherwise the popover says why, as the wizard's first step
  does. Start stays as a secondary that starts exactly what the boxes show).
  A popover opened there keeps the button on the line until it closes, so
  the QR survives sharing turning on.
  Details unfolds in place: the phone
  address without its token (copy), whether input is allowed, Share & pair,
  the A2A port and the full security code (the certificate fingerprint;
  plain mono values; the code wraps anywhere, copy). Connecting another computer by A2A starts from
  Connect a PC…; as a workspace share it starts from Connect a PC… or from
  Share & pair's **Connect another computer**, which mints the pairing link
  and copies it in one click. Connect a PC's invite tab carries **Also let
  it see this PC's workspaces** (off by default, offered only while Share &
  pair answers over HTTPS): ticked, the copy holds the invite and a
  view-only pairing link on a second line, and the other PC's one paste
  connects both.
- **Tailscale** — inside the same band, under a `--stroke` hairline: four
  checks from one read-only `tailscale status --json`, run when the page
  opens and on **Check again** (never on the 10 s poll): Tailscale
  installed · Running and signed in · This PC on the tailnet · Your other PC or phone
  visible. All passing, the four sit on one line with a green tick each and
  a muted "Ready · N other devices online". Otherwise each gets its own row;
  the first failure says why (Tailscale is off, signed out, waiting for
  approval, no other device online) and carries the ONE button that fixes
  it, and the checks after it are muted "not checked yet". Buttons only
  open: **Download Tailscale** (the official page), **Open Tailscale**
  (brings the app forward; to sign in, with a muted line on what to do
  there), or **How to add it** (unfolds how to sign the other device in to
  the same account). Nothing ever runs `tailscale up` or installs anything.
  The failed mark is the caution yellow warning glyph; the rows stay
  neutral and no orange is spent.
  The same button follows a Tailscale failure elsewhere: Share & pair's
  notice and the phone wizard's first step, and every place a connection
  to another PC starts (Connect a PC, Share & pair's Connect another
  computer, the attach and Pair again dialog), which check Tailscale
  before connecting to a piece whose every address is in the tailnet range.
  An address that is surely Tailscale's (a `*.ts.net` name, or one its
  status lists as a peer) is not tried when the check fails, which is said
  at once. Any other 100.64/10 address (other overlays share the range) is
  tried, and, when Tailscale is installed here, the reason is added only if
  the other PC is not reached. An
  unreadable status, or this PC offline from Tailscale's control server
  (known peers still carry), never holds a connection back.
- **Needs you** — drawn only while something waits, inside an
  `aria-live="polite"` region: ONE block with a 1px `--attention-hairline`
  border over `--selection-subtle` (no wash), rows split by `--stroke`
  hairlines. Rows: a link request (one sentence naming both ends — "DESK
  wants to link its Web/claude with this PC's api / build. Once accepted they
  send each other work and read the results." — its age, that the pane names
  are the other PC's report, the other PC's security code prefix when known,
  same repo or the repo-mismatch warning, the direction; Decline, Accept);
  held remote work (the quoted task, why it is held; Send back, Deliver to
  the pane now — never re-routed on its own; a hold for the Coordinator clears by itself,
  so it is a quiet muted line under the block, not a row and not counted);
  a PC whose security code changed
  (how many links removing it ends; Remove asking twice, Pair again…, which
  opens Connect a PC on Paste when this PC joined that one and on Invite when
  it joined this one). There is no pane picker on a request: the request
  already names this PC's pane. A **pane another PC shared** is its own row
  (2026-10-21): one sentence naming that PC's pane as its report, its age,
  the other PC's security code prefix, its agent and repo, the directions it
  offers and how long it stays open (an hour); Decline, **Accept…**. The row
  has no pane picker either: Accept… opens the link dialog with that PC and
  its pane fixed, this PC's pane picked there (the focused pane first), and
  the directions starting as offered, only narrowable. It counts in the
  Needs you number like a request; its toast offers Review only.
- **One list** (one hairline container, 36px rows on shared columns: icon ·
  13px/500 name · 12px muted meta · status · actions), in groups with a muted
  heading and count:
  - **Other PCs** — every A2A-paired PC (either role), one row per A2A
    hostId and never merged with another transport's record (an A2A PC and
    a LAN peer with the same name are two rows): its address, link
    counts and "Messages to send N", then what this PC allows that PC, one
    slot per permission ("Can see 2 panes here" for a PC that joined this
    one, from its exposure; empty for a PC this PC joined), with one more
    slot kept empty for starting new agents so it lands without reshaping
    the row; the status, and a ⋯ menu named after it
    (Link panes…, Link Moa…, What this PC can see…, Remove; portalled so the
    list's clip never cuts it, Escape on its button closes it first). Removing
    a PC drops both pairings this PC holds for it (the one it joined and the
    one that joined it); there is no one-sided removal. It says when the
    other PC was not told, and which side is left after a partial failure.
    Its live links
    sit nested under it (an elbow, `mine ↔ PC/theirs · direction`, or
    "waiting for PC to accept" with Check; Unlink asks twice). A pane this
    PC shared with it and not yet accepted sits there too (2026-10-21):
    `mine → PC · shared, waiting for PC to accept` with Withdraw, neutral
    (it waits on the other PC, so no hairline and no count). Then the
    workspace shares (remote hosts): Open unfolds that host's workspaces in
    place, each with its own Open; Pair again when its credential was
    refused. No path chip: Tailscale is the default, and the address that
    connected is not known to the renderer, so LAN is never guessed.
  - **Phones** — paired web devices: what each is viewing ("Viewing api /
    build", from the daemon's live streams, named here), whether it may
    type, and a direct Revoke asking twice (no ⋯ menu).
  - **Message links** — LanLink peers, messages only (a revoked one says
    Revoked in its meta). Paired from Connect a PC's LAN tab.
  - Status words are three: Connected, Disconnected (with "Disconnected 3h
    ago" when known), Waiting. A PC known only because it joined this one,
    with no stream since wmux started, is Disconnected with its last-seen
    time, never a standing Waiting. The live dot is neutral, filled only while a
    connection is held. With nothing anywhere, the list gives way to one line
    of explanation and Connect a PC… as the primary.
- **Recent activity:** its own short list (paired, revoked, host added,
  connects seen while the page is open).
- **Connect a PC dialog:** three tabs, and opening it has no side effect. It
  opens on **Invite this PC** only while the A2A listener is already up;
  otherwise on **Paste an invite**, and choosing Invite is what turns the
  listener on (one muted line says so, and the page's line follows at once).
  Invite opens an invite and copies it at once (Copy reads "Copied" for
  1.5 s, is the primary and stays for re-copying), shows the 8-character
  code grouped as ABCD-EFGH under it for reading out (display only: the
  whole invite is what is copied and pasted), lists the addresses the
  other PC tries in order with "Tailscale" beside the tailnet ones, and
  counts down to expiry with Discard code. When a PC redeems the invite, the
  dialog turns into "<PC> joined. Choose what it can see" with the exposure
  checklist, nothing ticked. Paste reads the clipboard only on its Paste
  button and shows it masked; it routes by shape: `wmux-a2a://` joins over
  A2A (then offers Link a pane now), and every remote-host shape — a pairing
  link, a `wmux web` URL with its token, an address and a code — pairs a
  workspace share. Nothing connects before Connect.
  Under Paste, one ghost link, "No invite? Add a PC over SSH…", opens the
  Add PC over SSH dialog for a computer that cannot send an invite.
  **LAN** pairs a message link with a PC on this network by a 6-digit PIN:
  Generate PIN (never on open) shows the PIN in two groups of three, its
  2-minute countdown and this PC's address, and Join takes the other PC's
  address, port and PIN. While LAN messages are off or no network interface
  is picked it says so and opens Settings › LAN. A PIN window the tab opened
  survives switching tabs and is closed when the dialog closes.
- **Link dialog from this page:** picks the PC when there is one, picks the
  other PC's pane when there is one choice or one on the same repo, and
  offers this PC's pane with the focused one preselected.
- **Orange budget:** one event, two marks at most — the Needs you block's
  hairline and the Remote rail item's number badge (link requests + held
  work + PCs whose security code changed, the same count from one store
  slice, cleared while the daemon is away). Link request toasts offer Review
  only: the repo a request names is the other PC's claim. The summary line, headings and activity stay neutral. The page's
  one primary is the first Accept, else (empty page) Connect a PC….
- Ids show only as needed and never in full; tokens and invite codes render
  only inside the dialog that made them.

### Git

Opened from the rail (the branch icon under Remote) or by clicking the
branch text in the titlebar. It is about the **repo**, not its branches:
the whole sheet (see Rail and pages) with 28px sides; the header
is the repo as `owner/repo` at the title size (the folder name without a
GitHub remote), a small GitHub link icon beside it, a muted line with the
open counts ("12 issues · 4 pull requests", "100+" at the read cap), and a
refresh button. Nothing about branches or worktrees sits above the lists.

- **Repo switcher:** the repo name is the switcher, a "Current repository"
  listbox: a filter field, **All repos** on top, every repo of the open
  workspaces grouped by remote (a checkout label when one remote has 2+
  clones; the open counts only when already read), and **Follow active
  workspace** at the bottom. Type to filter, arrows, Enter, Esc; focus
  returns to the name. The default follows the active workspace; a picked
  repo stays, across restarts too, until another is picked or Follow is
  chosen, so switching workspaces never moves the page. A pick whose repo
  has no open workspace left follows the active one with a muted line, and
  comes back when a workspace reopens there. The picked repo's lists,
  worktrees and hand-off owner come from its group.

- **Branch bar:** at the top of the **Worktrees** tab, one line: the active
  workspace's branch in mono, ahead/behind, uncommitted files `+N −M`, the
  PR badge with its CI state, then Diff, Go to terminal and the **ship
  button**. A `--selection-subtle` fill, no border. It trusts the pushed git
  status only when that status is about this very worktree.
- **Ship button:** the one primary on the page. Its label is the branch's
  next step: Commit (a message box; commits every change, new files
  included), Push, Create PR (`gh pr create --fill` with an editable title)
  or Open PR. A caret opens a menu with the other steps that can run now;
  Open PR stays beside it while the next step is something else. A step that
  cannot run is disabled with its reason in a muted line (a merge session,
  a detached HEAD, no upstream, behind the upstream, the default branch).
  Commit needs no upstream; Push and Create PR do. main re-checks each step.
- **Tabs:** text tabs **Issues · Pull requests**, then **Worktrees** as a
  quieter, secondary tab at the end (the active one carries the 2px accent
  bar; a first visit opens on Issues, then the last tab is kept) over a
  hairline. All repos (from the switcher) shows Issues and Pull requests
  as **one flat list** across repos, newest update first, each row ending
  in a small neutral **repo tag** (`--selection`, `--chip-radius`, 11px;
  the full owner/repo in its tooltip). Over it, a row of **repo chips**,
  one per repo with its open count: multi-select, none on means every
  repo, on is `--selection` and off a `--line` hairline. A repo with
  nothing open keeps a dimmed chip without a digit; a repo still reading
  shows a small spinner, a first read held by GitHub's rate limit a
  muted clock, a failed read a red ✕ with the reason in the tooltip.
  A row's tag toggles its repo's chip; a selection in a repo the chips
  leave out is cleared. The flat list is split into **who-acts-next
  sections**, in order **Needs you · Ready to merge · Agents on it ·
  Waiting on others**, newest update first within each. A section header
  is a fold toggle with its name and count; Needs you and Ready to merge
  start open, the other two folded (the fold is kept in the UI store), and
  an empty section is not drawn. Needs you's dot and count are the
  attention orange, the page's one accent; Ready to merge's check is the
  success green as an icon only; everything else is neutral. The turn is
  judged from wmux's own signals: the PR's state (checks, mergeable,
  review, draft), its work link to a pane and that pane's live agent
  status, the signed-in login and the viewer's role on the repo (read
  when the page shows and again on its refresh, never polled; a row takes
  its own host's login and the role of the repo it was read from, the role
  kept per signed-in login). Another author's PR counts as Needs you only
  where the viewer can write; elsewhere it waits on others, and so does an
  unrouted issue not assigned to the owner on a repo known to be
  read-only. With the login unknown, any PR on a repo known to be
  read-only waits too. A host wmux reads no identity on (anything but
  GitHub) has neither, so its items count as the owner's. A PR
  with no CI that is mergeable and needs no review is Ready to merge.
  Under the page title, a muted **summary line** names each non-empty
  section with its count (`Needs you 3 · Ready to merge 2 · Agents on it
  5`); a name opens its section and scrolls to it. The chips filter
  first, so the counts and the summary follow them. A **Flat | By repo**
  segmented control at the toolbar's right brings back the grouped view:
  every open workspace grouped by repo (the active repo first; clones of
  one remote are one group), another repo's group opening on demand and
  reading once. The flat list reads every repo once up front; in both,
  only the active repo's list polls. Worktrees stays grouped by repo, with
  the sections inside each checkout. The branch
  bar shows on Worktrees only when the active workspace is in the shown
  repo.
- **List / detail:** Pull requests and Issues are a split, the list ~30%
  and the detail the rest, each scrolling on its own (the page itself does
  not scroll); stacked on a narrow sheet. A list row is two lines: mono
  `#N` and the title, then a meta line. A PR's meta says **what it needs
  next in words** (CI failing, Conflicts with base, Changes requested, CI
  running, Review requested, Approved, mergeable, Draft …), red only for a
  failing check or a conflict, beside the checks dot, the author and the age.
  An issue's meta has up to three **neutral label chips** (`--selection`,
  11px; GitHub's label colours are not drawn), a comment count and the age.
  The selected row wears `--selection`. Over each list, "Updated Xm ago";
  when a read fails the last list stays under "Could not refresh … Retry";
  on GitHub's rate limit, "GitHub rate limit, retrying at HH:MM". Issues add
  a filter select (All open, Assigned to me, Created by me, With label).
  Issue and PR rows drag as refs (`application/x-wmux-issue` /
  `application/x-wmux-pr`) — see Hand-off below.
- **Detail:** a sticky header (the title at 16px, then `#N`, the repo, the
  state in words and the author; Open on GitHub on the right, with an empty
  slot kept for who acts next) over the body: for a PR its branch, review
  and checks, then the comments; for an issue its labels, assignees, body,
  comments in order and a closed line. The header also carries **Send to
  agent…** (a picker over the live agent panes: the keyboard way to hand
  off) and, for an issue, **Start in a new worktree**. Bodies go through the app's
  text-only markdown: real http(s) links (opened in the browser), read-only
  task boxes, blockquotes and tables. GitHub's HTML is never rendered as
  HTML: comments and scripts vanish, `<details>` becomes a collapsed
  disclosure labelled by its summary, other tags reduce to their text.
  Nothing selected is one quiet line.
- **Worktrees tab:** the new-worktree line and, while one runs, the merge
  session on top, then the worktrees in the flat list's who-acts-next
  grammar, as fold sections in order: **In use** (a workspace on it),
  **Uncommitted changes** (no workspace, changes on disk: work nobody is
  on), **No open PR** (no workspace, a tree known to be clean, a branch,
  and the repo's open PR list the page already holds is complete and has
  none from it; with no list held, or one that may be cut off at its read
  cap, the row stays in No workspace), **Cleanup candidates** (a workspace
  whose PR is merged, with a clean tree and no agent working or asking
  there; or no workspace and prunable; or no workspace, a tree known to be
  clean, and detached, or no commits in 14 days with a held, complete
  open PR list that has none from it),
  captioned as something to check before removing, never as safe to
  delete, and **No workspace** (the rest). The main worktree, a locked one
  and a merge session's are never candidates. The sections are judged from
  what wmux already reads: the worktree list, every worktree's uncommitted
  state (the diff counts where a workspace sits, a status-only count
  elsewhere: local git, once per load, a few reads at a time; a failed
  read is unknown, never clean), the workspaces on each worktree
  with their pushed PR status and live agent status, and the open PR list
  of the header's read or a Pull requests list; the tab reads no PR list
  of its own. All headers stay neutral (no orange: none of these is a
  question waiting on the owner), every section starts open, and under the
  page title a summary line names each non-empty section with its count
  and jumps to it. A row in Uncommitted changes, No open PR or Cleanup
  candidates can be **snoozed** (1 hour, 1 day, 1 week, or until it
  changes): it moves to a folded **Snoozed** group at the end, with
  Unsnooze, until its time passes or its state changes (another section,
  a new commit, a different count of changed files), whichever comes
  first. One row per
  worktree: the branch in mono over the workspaces on it (each a link that
  switches to it) or its folder, the PR, the diff stat (green/red), the
  accent dot only on the active pane's worktree, and Diff / Open / Merge /
  Remove floating over the faded right edge on hover.
- **Remembered:** the picked repo, tab, issue filter, selected item, list
  scroll, the All repos layout, its repo chips and its folded sections (the
  Worktrees tab's too) live in the UI store and
  survive leaving the page; the picked repo, the tab, the layout, the
  chips and the Worktrees snoozes are also kept per viewer across restarts. Anything that lands on a pane (Diff, Open, Go
  to terminal, a workspace link) returns to Workspaces.
- **PR review (detail pane):** under the facts row, in order:
  - **Checks:** a row per check (a green tick for pass, a red mark for fail, a
    muted mark otherwise) with Open on GitHub. A failed GitHub Actions run gets
    Show log, which shows the failed jobs' last 200 lines as plain text in a
    mono block (ANSI stripped, never markup), and Rerun failed jobs, which only
    ever runs on a click. Polled every 30 s only while the page and window
    are shown and the PR is open.
  - **Review:** "Applies to commit abc1234", one text box, and Approve /
    Request changes / Comment as quiet buttons.
  - **Squash and merge:** the one primary. It opens an inline editor with the
    subject "<title> (#n)" and an empty body. While the PR cannot merge, it is
    disabled with the reason in a muted line (checks failing or running,
    conflicts, draft, behind, blocked, not open).
  - **Files:** one row per changed file with its counts; open, it draws the
    hunks with an old/new line gutter. A gutter click opens a line comment
    composer. Review threads sit under their line with a reply box; outdated
    ones are listed under the file.

  The pane pins the head it first showed. When new commits land, a muted
  line "New commits were pushed since you loaded this PR" with [Reload]
  holds every write until Reload pins the new head and reads files, threads
  and checks again. Every write names the pinned head, and main refuses if
  the PR moved ("The PR changed since you loaded it"; drafts are kept).
  Drafts remember their head per field; a line comment written on an older
  head offers Discard or Re-anchor. A closed or merged PR turns the writes
  off with the reason. File-level comments sit at the top of their file. The header slot shows who acts next when a
  work link names the PR: "Next: you · review" or "Next: <agent> · working".
- **Hand-off:** an issue or PR dropped on an agent pane or a sidebar
  workspace row (holding the drag over the rail's Workspaces button for
  half a second opens that page; a held row gets a dashed accent outline)
  opens a small popover at the drop point: "Send issue owner/repo#N to
  <agent> in <workspace>?" (a workspace row asks which of its agents), the sanitized
  title, an optional note, then Start in a new worktree (issues only),
  Cancel and the one primary, Send. Esc or a press outside cancels. Work
  already linked to the item shows "Already in progress in <workspace>"
  with Send anyway. The agent receives a fixed two-line reference (the
  item, its URL, the `gh` command to read it) and the note, never the
  item's own text, through the gated A2A delivery that waits for nobody to
  be typing in the pane and only into a live agent. A send that did not
  land says "Did not send …" with the reason in a few words (someone
  typing, the agent left, no live agent). Only a drag that began on a Git
  page row of the same repo is accepted.
- **Not connected:** signed out for a GitHub remote, the whole page below
  the title is a centred **connect card**: one primary, Connect GitHub, and
  Check again. Connect runs gh's device sign-in in the background and shows
  its one-time code large in a dialog with Copy code & open GitHub; the page
  refreshes itself when gh reports the sign-in (it gives up after 10
  minutes). If gh gives no code, the dialog offers the terminal-tab sign-in
  (`gh auth login --web`, or the command to copy when no tab can show it).
  gh not installed shows the install command for the OS and Check again.
  gh keeps the credential; wmux stores no token.
- **Cost:** pull-only and only while the page is shown. The shown PR or
  issue list polls every 30s while the window is visible.
- **Rail dot:** a red dot on the Git icon while an open workspace's open or
  draft PR fails its checks or conflicts with its base (pushed PR status
  only, never a saved one); the button's name says why. Nothing at zero.

### Plugins

Owner-approved 2026-10-21. A catalog page in the sidebar's shape: a 300px
`--bg-mantle` list column beside one detail, told apart by tone alone.
Opened from the rail's puzzle-piece item, the command palette (Open Plugins,
a rebindable shortcut with no default key) or the `connectors` route.

- **List column:** the 16px title "Plugins", a search field (filters every
  section by name and tagline; Escape clears it), then sections under 11px
  muted headings, in order: **Signature** (catalog entries whose data flag
  `signature` is set — today Office), **Catalog** (the other catalog
  entries — today Agent status), **Installed** (every installed bundle that
  is not in the catalog; drawn only when there is one) and **Connectors**
  (one row, "MCP connectors", that shows the existing Connectors content in
  the detail). A section with nothing in it is not drawn. A row is a 32px
  tile with the entry's glyph (`--selection` fill; a Signature entry's tile
  is the text colour inverted, still neutral), the name at 13px/500 over a
  one-line 12px tagline, and a right-aligned 11px muted state: Not approved,
  On, Off, or nothing while it is only available. The selected row is the
  10px `--selection` pill (plus the look's `--select-ring`); the arrow keys,
  Home and End walk the rows and select as they go. The selection is kept
  while the page is away.
- **Detail:** the name at 16px/500 with a
  neutral Signature badge for a signature entry, a 12px credit line
  (publisher · licence · version; name · version for a bundle installed by
  hand), then the **preview** (owner-approved 2026-10-22): each catalog
  entry ships one real capture of its own rail page in the light theme
  (taken on an isolated instance with fake agents; never a mock-up), a
  webp renderer asset. It sits on the detail background in a reserved
  16:10 box up to 620px wide, with one `--line` hairline and the 10px card
  radius — no fill, shadow or glass — decodes lazily, and its alt text
  names the plugin ("Office plugin preview"). A bundle installed by hand
  has no preview. Then the description, then **What it can do**: one line per declared
  capability with a muted check, its plain-language label and the
  capability in mono, and — when it declares nothing that reaches terminal
  text (`terminal.read`, `pane.search`, `notifications.read`,
  `computer.observe`) — a muted no-entry mark and "No access to terminal
  content".
- **Actions, one primary per state:** available → **Install** + README
  (opens the bundle's README on GitHub); installed but not approved →
  **Review permissions to open** + Uninstall; approved → **Open** + Disable
  + Uninstall; disabled → **Enable** + Uninstall. Installing grants nothing:
  only Review permissions asks main to show the approval dialog. Uninstall
  asks in place (the hint, Cancel focused, then a red Uninstall), and is
  offered only for a bundle the catalog installed; a bundle installed by
  hand offers Disable instead and says its folder is removed by hand. Under
  the actions, one muted note for the state ("Installing grants nothing. It
  stays closed until you review its permissions." and so on). A bundle that
  failed to load is listed as a muted line under the list.
- **Settings › Plugins** keeps a single row, "Plugins moved to their own
  page", with Open; nothing on it installs, approves or removes.
- **Narrow sheet** (under 640px): the list stacks over the detail.

### Settings

A page with the same tabs and rows as before (see "Settings" under
Component rules). Escape closes a dialog opened from Settings before it
leaves the page.

## Sidebar (Workspaces page)

- Opens on a plain **"Workspaces"** title with a muted count and icon
  buttons (new workspace, filter). 264px by default, resizable 220–400px from
  the inner edge.
- **Workspace filter:** the filter button (or Ctrl/Cmd+F) opens a popover —
  the text search on top, then checks for **bookmarks** (Bookmarked only),
  **status** (Needs you, Running,
  Waiting (usage limit), Idle — the sidebar's own classification; Waiting
  applies where the row would otherwise be idle, like its clock mark),
  **kind** (has an agent, terminal only), **agent** (Claude Code, Codex,
  other) and **other** (has a PR, has changes, fan-out tasks only, or hide
  fan-out tasks). Checks in one group widen; groups narrow each other. While
  anything narrows the list the button carries a dot, the header reads
  `4 of 9`, and a row of chips under it removes one check at a time or clears
  them all. Nothing left says "No workspaces match" with Clear filters; a
  selected workspace the filter hides is called out above the list and stays
  selected. Arrow keys move through the popover, Space or Enter toggles,
  Escape closes it. The checks last for the session.
- **Rows:** a 500-weight title over a 13px meta line. The selected workspace
  is one 10px-radius `--selection` pill inset 8px from the edges; its agent
  rows are indented text with no inner box or guide line. Hover is
  `--hover-fill`, and the row actions sit in the row's flow: at the end of the
  git line, where they take the place of the diff counts and the PR badge, at
  the end of the name line on a top-level row with no branch, or on a line of
  their own on a nested task row with no branch. The name never gives up more
  than the actions' width, the roster chip stays, and nothing is faded. The
  actions reveal wherever the card shows its hover fill, and keyboard focus on
  the row reveals the same layout. Hovering a nested task row reveals only
  that row's actions, never its owner's. The list never scrolls sideways.
- **Keyboard:** the rows are a tree (`role="tree"`, each row's line a
  `treeitem`) with one Tab stop — the row the keyboard was last on, else the
  selected row, else the first. ↑ ↓ Home End move between rows in screen
  order (nested task and remote rows included), Enter or Space opens one
  (⌘/Ctrl adds it to the multiview), → opens its agents, ← folds them or
  steps out to the owner row, Shift+F10 opens the row menu. A row's own
  buttons join the Tab order only while the keyboard is on that row. When the
  stop's row leaves (closed, filtered, snoozed, folded away), the stop moves to
  the selected row, else the first visible one, so Tab always enters the list.
  Remote rows answer the same keys (Shift+F10 opens their menu). Focus is the
  app's ring: 2px `--accent`, inside the row, never the
  browser default.
- **Order control:** a sort button in the header, left of the filter, names
  the current order (`Order: Manual`) and opens a three-item menu —
  Attention, Manual, Recent activity — the same setting as Settings ›
  Appearance › Sidebar.
- **Agent not set up** (owner-approved 2026-10-21; shipped in #2535): while neither Claude
  Code nor Codex is ready (installed and signed in), one muted row at the
  sidebar's foot reads "Agent not set up · Set up" and reopens the setup
  wizard. Neutral text with no fill and no attention orange (nothing waits on
  an answer); the caution yellow is on its small glyph only. It is checked
  once after startup and whenever the wizard checks again, never on a timer.
- **Star on GitHub** (owner-approved 2026-10-21): the one place wmux asks for
  a star, in the same slot at the sidebar's foot (bottom left) and the same
  muted row: a small outline star in the text's tone, "Enjoying wmux?", a
  text button **Star on GitHub** and a trailing ghost × ("Not now"). Neutral
  text, no fill, no attention orange, no accent; only its two buttons take
  the hover fill and the focus ring. Below "Agent not set up" in priority:
  it waits until the agent check has run and found an agent ready, so the
  two never show together, and like that row it has no form in the
  collapsed rail. It shows only after real use, all of it local state (no
  telemetry): three days after wmux first ran it, and once 20 new agent
  sessions have started in panes since (counted from the agents' own
  session-start hook: a resume, a restored pane or a bot's worker does not
  count). × doubles the number, counts from zero again and keeps the row
  away for three days. Star uses the user's own signed-in gh (one PUT;
  then "Starred — thank you" for a moment and the row is gone for good);
  without gh, or if that fails, it opens the repository page and is gone
  for good too. Right before its first showing in an app session, a
  signed-in gh is asked once whether wmux is already starred; yes ends it
  unseen. **Settings › About › Links** keeps a permanent "Star wmux on
  GitHub" row with the same action.
- **Bot workers are not listed:** a fan-out task a factory bot dispatched
  (lineage origin `{kind:'bot'}`) is the bot's worker, shown on the Bots
  page only; the sidebar's task groups, the collapsed rail and the Ctrl+N
  digits leave it out — the active one too (2026-10-14: a bot's worker
  opens inside the Bots page) — and the header count never counts it. The
  Tasks line, Fleet and the phone's sidebar do not count bot workers
  either. Human, GUI and orchestrator tasks are
  unchanged.
- The glance-board rules (attention order, pin to top, fan-out nesting, the
  changed-since-you-looked dot) are in "Sidebar rows" after the Decisions
  Log.

## File tree column (Workspaces page)

Nothing docks opposite the sidebar (owner decision 2026-10-14): the bots'
rooms and 1:1s are read and answered on the Bots page only, task status and
fan-out work in Fleet (the sidebar's Tasks line opens Fleet), and Git is a
page on the rail. The one exception is not a dock: on the Bots page, a
worker's terminal or a thread opens in the page's own body, right of the
chat (owner decision 2026-10-14, layout A).

**File tree column.** The one opt-in column on that edge, beside the
panes. The agent bar's
Files button (or ⌘⇧E / Ctrl+Shift+E, or the palette) shows it; open state and
width (200–480px, drag the inner seam) persist. It is Workspaces-page
chrome: a rail page covers it with the panes, and the shortcut or palette
used from a rail page brings Workspaces forward. Its header ends in a close
button, so it can be hidden while the agent bar is off. It lists the focused pane's folder, or
that folder's git repository root when it is inside one. One seam on its
pane side, a 40px header on the pane tab strip's line, 24px rows with a chevron
and a line icon; a selected row is a `--selection` fill. Click opens a file
in an editor tab of the focused pane; drag drops its path into a terminal;
the row menu has Open, Insert path into terminal, Copy path, Copy relative
path, and Open in Finder / File Explorer.
The header's search button opens a name filter field under it (the field
exists only while open, and folds away on Escape or when it loses focus
empty). Typing walks the folders below the root (up to 5,000 entries,
symlinked folders not followed) and shows only the matching files and
folders with the folders leading to them; the matched part of a name is
emphasised by weight, not a wash.

## Pane: terminals and work area

A pane is a terminal column plus, when it needs one, a work area.

```
┌ pane tab strip ───────────────┬ work strip ───────────────────── [◫]┐
│ ⠿ w1-1  Zsh  claude  [cluster]│ Example Domain   app.tsx   diff     │
├───────────────────────────────┼─────────────────────────────────────┤
│ terminal (the hero)           │ browser / editor / preview / diff   │
└───────────────────────────────┴─────────────────────────────────────┘
```

- **Two kinds of surface.** Terminals (local and remote, and the
  placeholders a mirror shows for a slot it cannot draw) keep the pane tab
  strip and draw in the left column. Browser, editor, preview and diff tabs
  are work surfaces and draw in the work area on the right. A pane holding only one
  kind draws it across the whole pane under one strip, as before.
- **One header line.** The work strip sits on the pane header's line, split
  where the body is split: the body's separator continues up through the
  header as the seam between the two strips. Dragging the separator moves
  both. No second header row, and no line of its own between the strips.
- **The work area comes and goes with its tabs.** It appears with the first
  work tab and goes when the last one closes; the terminals refit once each
  time. The pane cluster (split, browser, stash, zoom) stays at the end of
  the terminal strip; while the work area is expanded that strip shrinks to
  its tabs and the cluster folds to its ⋮.
- **Expand (◫).** The work strip's one button hides the terminal column so
  the work area fills the pane; pressed, it reads Show terminal. The
  terminals stay mounted and keep their size (a hidden column is a
  background tab), and the split widths come back unchanged. Picking a
  terminal tab restores the split. Pressed state is `--selection-emphasis`
  (`ui-icon-btn-active`), never colour.
- **Which tab is shown.** Each side shows its own tab: the focused one when
  focus is on that side, otherwise the one it last showed. Focusing a
  terminal never swaps the page beside it.
- **One accent per pane.** The accent bar marks the active tab on whichever
  strip holds the pane's focus; the other strip's active tab keeps the quiet
  bar.
- **Preview tab.** An image or PDF opened from the file tree is a read-only
  preview tab, not an editor tab. Its header is the file name, its path and
  three actions (open in the default app, open the folder, copy the path); its
  footer is the file's facts on the left and one zoom toolbar on the right
  (− / zoom % / + / Fit, plus the page field for a PDF). The wheel scrolls;
  Cmd/Ctrl + wheel zooms around the cursor; there is no click-to-zoom. It
  opens fitted, never above 100% for an image. When the file changes on disk
  the view updates in place, keeps its zoom and position, and never takes the
  focus. A half-written, damaged or deleted file leaves the last good version
  up with one line of `--attention-text` in the footer; that line is state, so
  it is the only colour on the tab. Transparency shows on a checkerboard drawn
  from the theme.
- **HTML preview.** An `.html` file opens rendered in the same preview tab,
  in a sandboxed page that never runs in the app. The footer carries the
  page's one network control, `Offline` until pressed (`Network on`,
  pressed state as above), and a held link: a page never navigates away or
  opens anything on its own; a link it tries to open shows in the footer
  with an Open button. The header adds View source, which opens the file
  as text. A change in the page's folder reloads it in place, keeping the
  scroll and the focus.

## The one-boundary rule

**Each element draws at most one boundary, and adjacent elements share it.**

- One seam per edge: the sidebar and the body share one 1px `--stroke` seam
  from the titlebar down; the pane border lands on the titlebar, sidebar and
  file tree seams instead of beside them; the pane tab strip and the file
  tree header end on the same line.
- A fill **or** a hairline, never both: user bubbles are fills without a
  border; composers are a hairline without a fill; Fleet cards and selected
  rows are fills; the sheet is an edge plus a faint shadow.
- No boxes inside boxes: no inner card around a selected workspace's agents,
  no doubled container in a column, no dividers between toolbar buttons, no
  rule under the chat session header.
- A boundary that only appears on demand stays hidden until then: the
  sidebar's filter field appears from its button and folds away when empty.
- Before adding a line, ask which existing line it duplicates.

## Colour grammar

Colour carries **state only**. Surfaces, controls, selection and hover are
always neutral (the fill ladder).

- **The one exception: bot identity colours** (owner decision 2026-10-14).
  On the Bots page a bot's Mochi character, its name above its run and its
  `@name` mentions wear the bot's own colour, so bots are told apart at a
  glance as in the reference messenger. The identity palette
  (`BOT_IDENTITY_HUES`) holds blues, indigo, violets, purple, magenta, cyan
  and a slate — never red, orange, yellow or green, which keep error,
  needs you, caution and done — and each hue is mixed 72% with the look's
  `--text-main`, so it darkens on light looks and lightens on dark ones
  and reads as text on the page; a Mochi character's body wears its slot's
  hue unmixed (2026-10-16). Identity colour never fills a surface, a row or a control, and never
  marks a state. A removed bot keeps its colour, picture and name on the
  messages it wrote, its name followed by "(removed)".
- **Sidebar and pane marks** — shape first, colour second, one shared helper
  (`AGENT_STATUS_ICON.mark`): running = filled muted dot · needs input =
  `--attention` ring · error = red ✕ (SVG) · complete = muted check ·
  unconfirmed = hollow `--accent` ring · usage-limit hold = muted clock ·
  idle = no mark. Selection is never painted as a status. The collapsed
  rail draws the same marks (`StatusMarkView`), never text glyphs, and names
  each workspace `name, status` for assistive tech.
- **Usage-limit chip and card** (owner handoff 2026-10-22).
  - **The chip.** A pane held at its provider's usage limit shows one chip in its tab strip's flow, never a new row, so the terminal does not shrink: a muted clock, "Limit" and "resets 3:16 PM · 2h 4m", then Resume once the reset has passed, and ×. The clock wears `--accent` only while the pane will resume on its own, since that is when the system acts. Clicking the chip opens the usage-limit card.
  - **The card.** It is a padded popover anchored to the chip and placed with `placePopover`, and it closes on Escape, an outside click or a resize. It opens by itself once per limit, and only for the pane in front. It holds:
    - Resume automatically when it reopens: a switch, on by default.
    - Continue on another account: shown only with 2+ accounts. One ghost button per account, then the opt-in "Always switch automatically" checkbox, which is the vendor's switch-by-quota setting.
    - Continue in another agent: shown only for agents that are installed and signed in. It opens that agent in a new tab of the same pane and types a handoff note without sending it. Under the buttons, the note itself in an 11px mono `--text-sub` block on a `--selection` fill (at most 120px, scrolling), then its length in 11px muted tabular figures. When the held agent's input holds an unsent draft, an "Include the unsent draft" checkbox (off) sits above the note and adds it. The two tabs name each other on their tooltips ("Continued in …" / "Continued from …").
    - Continue on another PC: one ghost button per paired PC that lets this one start an agent there. It is not offered from a pane whose workspace was itself started for someone, nor once the limit has reset. The "Include the unsent draft" checkbox (off) sits under these buttons too when no other agent is offered. A click asks that PC's word again; if it no longer lets this PC start an agent, a warn toast says so and nothing opens. Otherwise the card closes and the Remote page's "Start an agent…" dialog opens with a note for that PC as the prompt. Replies go to the held pane. The wait offered is whole hours that do not pass the reset, at most four. One `wmux-a2a-note` line above the form says that the note leaves this PC, is kept on the other one, and may run there unreviewed, then how many values were masked as secrets and how many paths were left out.
    - In that dialog (and on the Remote page) the prompt is sent only as shown. While a typed value would still be masked, a `wmux-a2a-note` line says how many. Send then puts the masked text in the box and asks for a review, and the next Send sends it.
    - When every account is out, one line with the earliest time one reopens.
  - **Colour.** None beyond the armed clock.
- **Needs you is the attention orange everywhere** — the sidebar ring, hairline,
  labels and counts, the collapsed rail's mark, the rail badge and dot,
  Fleet's Needs you chip, section dot and row word, and the titlebar count —
  so one state never wears two colours (and a white-accent look still reads
  it). One orange hue family (≈21–29°), its own value per look
  (`ATTENTION_COLORS` in `themes.ts`, emitted into each look's block in
  `globals.css`): `--attention` is the vivid fill for marks, dots and
  the badge (≥ 3:1 on the page and sidebar, and on a needs-you row's
  `--selection-subtle` / `--selection-hover` fill); `--attention-text` carries words
  and counts (≥ 4.5:1 on page, sidebar, row fill and frame — on light looks a
  darker orange of the same hue); `--attention-ink` is the badge's digits
  (≥ 4.5:1 on the fill); `--attention-hairline` is the needs-you row's
  border, the fill mixed toward transparent at the lowest per-look
  percentage that still reads at 3:1 on the row's fills and the column
  (`ATTENTION_HAIRLINE_PERCENT`, 54–98%; the one sanctioned mix). Otherwise
  never a color-mix; never the caution yellow
  (`--accent-yellow`, which stays for warnings) and never the error red.
- **Fleet list** — a row's dot takes its status colour, the sidebar's grammar
  (see Fleet page); a ticket's dot takes its ticket state.
- **Diff counts** are green `+N` / red `−M`; red is otherwise reserved for
  errors and destructive actions.
- **The accent** marks selection edges and underlines (per the look's
  knobs), focus rings, links and the running column. It is never an area
  fill; the one solid fill per surface is the
  primary button (`--primary-fill`, white on dark looks, ink on Paper, the
  accent on Graphite and Amber Line).
- **No washes.** A row that needs you is a 1px solid `--attention-hairline`
  border (a quiet attention-orange hairline, not a dash; 2026-10-07) over a
  fill one step below the selection (`--selection-subtle`; `--selection-hover`
  on hover), not a red wash; the 1px transparent border is reserved at rest so
  a row never shifts when it starts asking. Selection wins: a selected row
  that needs you takes the `--selection` fill and a 1px `--accent` ring
  outside the hairline. A nested task row draws no box of its own (no
  hairline, no fill): its mark and its question line say it. The hairline
  means a question or an approval waits on you: an open approval, permission
  or AskUserQuestion dialog, or a turn that ended on a question in its
  closing message (`pendingQuestion`). A turn that finished with no question
  draws no hairline; it shows the done dot until its workspace is viewed. The Attention blink
  pulse (Motion) is a momentary opacity overlay, not a resting wash.
- **Attention renditions:** one event is drawn at most twice (the evidence
  row plus one global count). The titlebar vitals step aside on the Fleet
  page, whose summary line already says them.
- **No dead gauges:** a count, chip or column at zero is not drawn.

## Typography and density

- **Face:** the look's UI face (`--font-ui`: Geist, IBM Plex Sans or
  Figtree; the platform UI font for the earlier themes). **Monospace only
  for code, paths, activity lines and terminals** — a mono line means
  machine evidence, a sans line means someone talking.
- **Chrome base: 13px / 400**, emphasis **500** (`--title-weight`); no
  uppercase or tracked labels in chrome except a look's group labels
  (Graphite's sidebar group heads, via `--group-case` / `--group-track`).
- **Scale:** 11px metadata, chips and footers · 12px Fleet detail and
  secondary controls · 13px rows, tabs, menus, body · 14px chat prose and
  composer input · 16px page and dialog titles (`--text-display-size`);
  Settings has its own calmer scale (see Settings under Component rules).
  Tabular figures for counts, durations and diff stats.
- **Icons** cap at 16px in chrome (19px on the rail); wmux's own icon set
  (`icons.tsx`), never emoji.
- **Density:** the chrome module is **40px** (titlebar, pane header, file
  tree header, resume row, section headers). Sidebar rows are a title over one
  13px meta line; controls are 24–28px tall;
  every interactive element keeps a hit area of at least 24×24px. Base unit
  4px.
- **Radii:** 6px controls (or the look's `--chip-radius` for chips and
  segmented tracks) · 10px cards, selected pills and panels · 12px sheet and
  popovers · 16px dialogs · full round for dots and count badges.
- **Elevation:** three levels only — flat (tone), the sheet's faint shadow,
  and one floating shadow for popovers (`--shadow-popover`) and dialogs
  (`--shadow-modal`). No bevels or inset highlights.

## Selection, hover and active tab

- **Hover** is `--hover-fill` (text 5%) on rows, rail items and icon
  buttons. Accent never appears on hover alone except on links.
- **Selected** is one soft `--selection` fill, drawn the look's way:
  `fill` (Tint, Paper, Graphite), `fill-ring` (Zinc: fill plus a 1px inset
  ring), or `left-bar` (Amber Line: a 2px accent bar on the left edge). One
  selected thing per list; selection is never a status colour.
- **Active tab** (pane tabs, work strip tabs): a square-bottomed cell joined to
  the body and marked by **one straight 2px bar on the strip's line** — the
  accent in the focused pane, a quiet tone elsewhere. Looks with
  `--tab-underline: 2px` draw that bar as the accent underline on every
  active tab. No full-width focus line under the strip; focus shows as a
  stronger strip line. Inactive tabs are 50% text with a hover fill.
- **Pressed / open** controls (a chip whose popover is open, an active icon
  button) use `--selection-emphasis`, never colour.
- **Focus rings** are the accent; keyboard focus is always visible.

## Component Rules

- **Tool calls render as flat mono log lines,** never boxed chips: status
  glyph + tool name + one-line arg summary + right-aligned jump link (muted
  at rest, accent on hover).
- **Every claim is one click from its evidence:** anything referencing a
  pane gets a jump affordance.
- **Buttons:** primary = solid `--primary-fill` / `--primary-ink`, one per
  surface, on the action that unblocks the user first. Secondary = 6px,
  `--line` hairline, 12px label, hover `--hover-fill`. Destructive = red
  text and hairline, solid red only on a final confirm. Icon buttons are
  26–28px squares.
- **Chips** (composer pickers, Schedules composer, model, and, outside
  Moa's panel, the orchestrator mode): 26px, `--chip-radius`, no border, `--selection` fill,
  `--selection-hover` on hover, a chevron that turns when open. AI-directed
  actions (fan-out) stay neutral at rest.
- **Composer:** one box with a `--line` hairline (`--line-strong` focused)
  and no fill; input on top, a toolbar row under it with chips and a solid
  26px send. The chat, channel and orchestrator composers share it. Moa's
  composer sits directly on the panel fill with no footer frame (one field,
  one border, send inside); its key hint shows only while the field is
  focused and empty, or when the field is disabled and the hint says why.
- **User bubble:** a content-10% fill, no border, full round on one line and
  12px when it wraps; queued messages use the same bubble. Assistant prose
  has no bubble. Each recorded turn ends in a muted receipt: check, duration
  (when the transcript carried both times), clock time, copy.
- **Popovers** 12px, `--line` hairline, `--shadow-popover`; menu rows 6px.
- No emoji glyphs in chrome; status marks are icons, not text glyphs.
- **Agent verbs** stay one workspace-spanning bar overlaid on the grid's
  bottom edge and revealed on approach (2026-08-18); it takes no layout row,
  so no PTY is resized when it appears. It holds Files (the file tree
  column's toggle) · Snippets · Rich Input · Schedule, then Multi Task and the
  pin (2026-10-15); a verb that duplicates another home does not get a button.
- **Dictation** (voice to text on this computer; one dictation at a time
  across the app):
  - **Composer mic.** The Chat view and Bots composers carry a muted mic
    icon button just before send, in the composer's own icon-button style.
    One click records; the next stops and transcribes. The text goes into
    the box at the caret (over a selection) for the owner to edit, and is
    never sent by itself. Recording: the button reads pressed
    (`--selection-emphasis`, never colour) with a 6px filled `--accent` dot
    and the elapsed `m:ss` (11px, tabular) beside it; the dot is a live
    state, never the error red. Engine starting or transcribing: a quiet
    spinner in place of the mic, the button disabled. While another input
    dictates, the mic is disabled. Esc cancels a recording wherever focus
    is; nothing is written.
  - **Consent.** The first use opens one dialog (Dialog anatomy) before
    anything is fetched: the size (about 80 MB), the source
    (`huggingface.co · onnx-community/whisper-base` in `ui-code`, and the
    pinned revision), the licence (MIT), where it is kept (this computer,
    wmux's data folder) and that audio stays in memory and is never stored
    or sent, as one grouped-rows container. Not now (ghost) and Download
    (the primary). While it downloads: a neutral 4px progress track
    (`--selection` track, `--text-sub` fill), "N MB of M MB" and Cancel
    (secondary), no primary and no ×. When the model is ready the dialog
    says to press the mic or the shortcut again; no recording starts by
    itself. A refused microphone is a toast that says to allow it for wmux
    in the system's privacy settings; any other failure is a short toast.
  - **Terminal panes** get no header button: the pane cluster keeps its
    five buttons. "Dictate into this pane" is a rebindable shortcut
    (⌘⇧S / Ctrl+Shift+S, a toggle: press to start, press again to stop)
    and a command-palette entry of the same name. The text goes to the
    focused pane as a bracketed paste with no Enter (lines joined with
    spaces when the app has bracketed paste off); a pane in Chat view takes
    it in its composer. While a pane is dictated into, a chip floats in its
    top-right corner: `--bg-surface` fill and the popover shadow, full
    round, 11px — dot, "Dictating 0:05", muted "Esc to cancel"; a spinner
    and "Transcribing…" after. It takes no layout row (the PTY is never
    resized) and lets the pointer through.
- **Chat kind badge and "Show as chat"** (owner decision 2026-10-24):
  - **Kind badge.** The top of each chat view names which chat it is with a
    neutral `Badge` (11px, full round, no colour: the kind is not a state).
    Chat 1, which follows the agent in the terminal, reads "Terminal-linked
    chat" at the right of its progress row (under the status when the pane
    is too narrow, never clipped); chat 2 reads "Chat only" in its
    own top row. Each has a one-line hover explanation. Chat 1's approval
    note is plain: "Waiting for your approval." and an Answer in Terminal
    link that switches the pane to its terminal.
  - **First-start question.** The pane header's Terminal / Chat switch is
    labelled "Show as chat". The first time Claude or Codex runs in a pane,
    a card floats in the terminal's top-right corner (`--bg-surface`, the
    popover shadow, 12px radius, `--line` hairline; no layout row): "Show
    this as a chat?" with Keep terminal (ghost) and Show (the primary). The
    answer is kept per agent and never asked again; Show turns the chat view
    on and switches that pane. A user who already had the chat view setting,
    on or off, is never asked and keeps the value; changing it in Settings
    ends the question for every agent.
- **Continue in chat** (macOS and Linux): a "Continue in chat" link beside
  Open Terminal in chat 1's progress row (a terminal Claude at rest) and on
  chat 2's handed-off notice (its Claude exited). It opens a confirmation
  `Dialog` that names the processes the stop ends ("node (MCP server)") and
  says that one that already left Claude's tree keeps running. No colour.

### Dialogs & forms

Build every modal, popover and settings row from `src/renderer/components/ui/`
(`Dialog`, `Button`, `Field`, `Switch`, `Checkbox`, `Select`,
`SegmentedControl`, `Badge`, `Input`, `MediaPreview`) rather than hand-rolled
inline styles. Surfaces are **quiet**: neutral fills, low-contrast hairlines,
one soft floating shadow on the panel only, no bevel.

- **Dialog anatomy:** backdrop `--backdrop-modal` at `--z-dialog`; panel
  `--bg-base`, 1px hairline, 16px radius, `--shadow-modal`; 24px padding and
  12–16px between groups. Header = the 16px title + optional 13px
  `--text-sub` description + a 32px close ×. Body scrolls; Footer is a
  right-aligned action row with no divider. Focus is trapped while it is
  inside the panel, comes back if a re-render drops it, and returns to the
  opener on close. Escape closes the top-most dialog only, never mid-IME,
  and never reaches what is underneath.
- **One primary per surface.** At most one solid primary per dialog state,
  chosen by what unblocks the user first. It sits last in the footer, or —
  when a listed status needs an action — in that row's notice action. Every
  other action is secondary, ghost (dismiss / skip) or destructive. A
  disabled or in-flight action is never the primary; a state with nothing
  to do has none.
- **Grouped rows:** a list is ONE rounded container (12px, hairline) with
  inner hairline dividers, not a boxed card per row. Each row is icon +
  13px label + optional 11px muted secondary line.
- **Notice row:** icon · title + one-line description · vertical hairline ·
  action on the right, where a status needs an action.
- **Field row:** 13px/500 label + 11px `--text-sub` description on the left,
  control on the right (`inline`) or underneath (`stacked`). The row wires
  the label and `aria-describedby` into its control. Settings overrides this
  recipe on its own page only (below); dialogs keep it everywhere.
- **Controls:** switches and checkboxes are neutral (dim when off, a light
  track with a dark knob when on); segmented controls are a `--chip-radius`
  track with the active segment on `--selection`; inputs use a `--line`
  hairline and the accent focus ring. Badges are neutral by default; success
  / warning / danger tint the text and hairline only.
- **Type:** the look's face inside surfaces. Mono only for machine evidence
  (`ui-code`), never for a whole dialog.
- **Media:** a feature explained in a dialog or the tour may show a short
  muted loop (`MediaPreview`, WebM ≤ ~6 s, ≤ 500 KB) in a fixed 16:10 frame;
  under `prefers-reduced-motion` it shows the still poster and never plays.

### Settings

Settings is a page (the titlebar gear), built from the Dialogs & forms
primitives plus `Settings/SettingsLayout.tsx` (`SettingsSection`,
`SettingRow`, `SettingNote`).

- **Information architecture** (owner-reviewed, 2026-09-24). Tabs, in nav
  order: General · Appearance (theme, interface, sidebar, panes, terminal
  text, agent toolbar) · Terminal · Keyboard · Notifications. Group
  **Agents**: Claude Code · Accounts · Factory · Roles & fan-out ·
  Token usage · Browser · Computer use. Group **Connections**: Plugins (a link to the Plugins page) · Remote & phone · LAN (the LanLink and A2A listener switches, and a link to the Remote page where PCs are paired and removed). Then
  About. Each tab answers one question; a setting lives on exactly one tab
  and the search catalog (`settings/catalog.ts`) names that tab. Retired tab
  ids resolve through `resolveSettingsTab` (Orchestrator, Agents and Moa all
  open Factory, the agent factory's tab).
- **Theme picker:** visual cards whose thumbnails show the look's face,
  chip shape and selection style; selected by a neutral outline + check.
  wmux's own looks (Tint, Zinc, Graphite, Paper, Amber Line) come first;
  every other built-in theme and Custom follow under a "More themes"
  heading in the section-heading style, each group in its usual order, all
  in one radio group and never collapsed.
- **Type scale** (2026-10-15, calmer than the chrome scale). Quietness
  comes from weight and size, not a dimmer colour: descriptions, notes,
  inactive nav labels and every heading below the page title are
  `--text-sub`, the look's secondary-text token, and labels are regular
  weight.
- **Nav:** 14px/400 icon + label rows, 32px tall, 14px `--text-muted` icons,
  `--text-sub` labels; group headings 12px/400 `--text-sub`, sentence case.
  Hover is `--hover-fill`. The selected row follows the look's own
  selection treatment (`--selection` fill plus `--select-ring`) in
  `--text-main`: a selection fill on most looks, and Amber Line keeps its
  2px accent bar.
- **Page:** one centred column (680px max, 32px top padding); the tab's
  name as a 22px/500 title, 24px above the first section; sections 32px
  apart, each a 13px/400 `--text-sub` sentence-case heading over ONE
  rounded container of rows.
- **Row:** a 14px/400 label over a 12px `--text-sub` description line on the
  left, control on the right; rows are 48px minimum with 8px × 14px padding.
  Overflowing copy collapses behind a 12px Learn more. Status words are
  Badges. At most one primary per tab.
- **Controls:** a 30×18 switch (12px knob) with a 36×24 hit area, a select
  at least 140px wide with a 6px radius; buttons keep their shared sizes
  (26px `sm`, 32px `md`). These sizes apply only to the page's own rows,
  never inside a dialog, popover or listbox opened from it.

## Motion

- Minimal-functional. Spinners, the blinking cursor and bot avatars are the
  only perpetual motion; the welcome dialog and onboarding tour clips loop only
  while on screen and never under reduced motion. The one opt-in exception is
  the Attention blink setting's Continuous option (below): the user chose it.
- **Bot avatars** (owner decision 2026-10-16; Bots page, Avatars): a Mochi
  character breathes and blinks at rest and hops while its bot works; it is
  paused off screen, and `prefers-reduced-motion` turns it off.
- **Attention blink** (Settings → Appearance → Sidebar, per user). A sidebar
  row that waits on you (an open dialog, or a turn that ended on a question)
  pulses: Off
  (the hairline only), Once (three soft beats over ~1.5s when the wait starts),
  Once + remind (the default: the same pulse, then again every 30s / 1 min
  (default) / 5 min while it still waits) or Continuous (a slow ~2s pulse
  until answered). A finished turn has its own choice: Dot only (default) or
  Pulse once. The pulse is an opacity-only overlay between the row's fill and
  its content (`--attention` for needs you, `--selection-subtle` for a
  finished turn), so nothing moves; it is a CSS animation class picked from
  state, never a per-row timer. A row whose workspace is active or on screen
  never pulses, the row's own status mark does not breathe while the row can
  pulse (Off means still), and `prefers-reduced-motion` forces Off.
- Tokens: feedback 120ms (`--motion-feedback`), ease-out
  `cubic-bezier(0.22, 1, 0.36, 1)`; transitions only for state changes
  (hover, expand, open). Theme swaps are not animated. Reduced motion
  disables them.

## References

- Token source: `src/renderer/themes.ts`; generated CSS:
  `src/renderer/styles/globals.css`; component rules: `src/renderer/styles/ui.css`.
- Earlier approved artefact: `designs/redesign-20260711-bridge/` (the Amber
  theme's layout).

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-11 | Terminal-first + premium chrome (not chat-first, not dashboard) | Raw-terminal ground truth is the moat; chrome was the gap |
| 2026-07-11 | Custom titlebar 36px, `autoHideMenuBar`, `titleBarOverlay`, no titlebar search | File/Edit strip killed the app feel; center = drag region (a titlebar without one eats every click) |
| 2026-07-11 | Unified mission control (Fleet + Orchestrator + Channels in right pillar; sidebar = workspaces only) | Agents/orchestrator/channels felt disconnected split across edges (owner feedback) |
| 2026-07-11 | Amber kept as focus hue; swappable via single `accent` token | Owner unsure on yellow — de-risked by token architecture + amber diet |
| 2026-07-11 | Amber diet codified (5±2 points, no washes, hover-expansion, diff=green, 2-rendition attention) | v1 mockup overused amber → read as "yellow app", not "one lit instrument" |
| 2026-07-11 | Status footer instrument strip (model·approval·ctx·cwd·running·needs) | Always-visible agent state |
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
| 2026-09-21 | Refine the outer shell first: global sidebar shortcuts, 13px navigation and pane labels, quieter neutral selections, and an inset terminal frame. Workspace menu descriptions use 11px text. Existing terminal content stays in place; assistant-ui chat is a later phase | Improves readability and navigation while preserving the terminal-first workspace and existing actions |
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
| 2026-10-05 | Sidebar critique fixes: rows become a keyboard tree (one Tab stop, arrows, → / ←, row actions only after the row has focus); errors get their own Attention tier between needs you and finished, with an `Error` word; a needs-you row shows its question instead of the branch; the needs fill drops below the selection and a selected needs-you row adds an accent ring; status words and the roster chip move onto the name line; the rail draws the shared marks; a header order button | A sidebar row was reachable only by pointer, a selected needs-you row looked unselected, the row said who was waiting but not on what, and an old error sorted among finished rows. Fleet keeps counting errors under Needs you (#1807), so the sidebar's tier changes order and wording only, not the shared counts |
| 2026-10-06 | Owner decision: needs you is a clear, saturated attention orange instead of the amber/yellow, in every place it appears (sidebar dash, ring, label and counts; rail mark, badge and dot; Fleet chip, section dot and row word; titlebar count). One orange hue family with a value per look (`ATTENTION_COLORS`: fill, text, badge ink); light looks pair a vivid fill with a darker same-hue text. The caution yellow stays for warnings | The amber read as a muddy brown/gold on the light looks, and the deepening color-mix behind the light-look badge made it worse. A per-look orange stays vivid on every look and keeps text and badge digits at 4.5:1 without mixing |
| 2026-09-27 | Owner decision: attached remote workspaces join the one workspace list instead of a bordered section under it. In Attention they sort with the local rows by their most urgent agent pane on the same scale (a stale mirror counts as idle, its status is frozen); in Manual and Recent they follow the local rows in attach order. Never pinned, dragged or given a Ctrl+N hint. The host line leads with a muted server glyph (no new amber), a mirror whose agent needs you carries the local row's needs-you wash, red dot and label, a stale row is dimmed, and the header count and workspace search include remote rows | One glance board: a remote agent that needs you was invisible below every local row. The glyph says "another machine" without a host header, and dimming is already the convention for not live |
| 2026-10-01 | Owner decision: Settings gains a **Computer use** tab, last in the Agents group after Browser. It holds the opt-in switch (off by default; its description states that screenshots and window text go to the agent's model provider), the native helper's status as a Badge (success when ready, neutral otherwise — never amber), the global stop key as `ui-code`, and two read-only rows saying what is asked per app and what is never allowed. No primary button on the tab | Letting agents drive other apps is its own question — it is not about the agent browser, and folding it into Browser would bury a new security boundary under unrelated rows. The state lives in its own `~/.wmux/computer-use.json` (main-owned, not the daemon's `config.json`) because the MCP server reads it too |
| 2026-10-03 | **Proposed (owner-directed, pending final approval):** neutral glass look — zero-saturation tokens with a content-mix fill ladder, one blue state accent (running/focus), amber = approval, emerald = done, solid white primary, borderless 26px chips, 6/8/12/16px radii, card rows with two muted metadata lines, 40px chrome module, platform UI font with a 10–14px scale, dark-only window glass, always-visible turn footer. Replaces the amber/steel grammar, the bevel surfacing, Inter, the four-step scale and the 36px module; wmux icons are kept. See "Proposal — Neutral glass look" | Owner call after reviewing a first, more conservative draft: adopt the reference look nearly as-is rather than blending it with the existing grammar. Colour carries state only, so the screen reads calm and every coloured mark means something; translucency and fills instead of outlines give the modern finish |
| 2026-10-03 | **Shipped: the new look.** Five built-in themes (Tint default, Zinc, Graphite, Paper, Amber Line) with per-theme style knobs; a window frame holding one floating rounded sheet; a 48px icon rail of pages (Workspaces, Fleet, Schedules, Remote); a titlebar with a centred search pill and Settings and tools-panel icons at the right; Fleet as a four-column board, Schedules as a list and one-box composer, Remote as a two-column dashboard; a workspace filter in the sidebar (with a Waiting (usage limit) status); the one-boundary rule; a 13px chrome face with 500 emphasis. Supersedes the proposal row above, the amber/steel grammar, the 5±2 amber budget, the machined bevel, the 36px module and the Fleet overlay | Owner approval of the local build after review in every theme. Pages replace overlays so nothing covers a half-visible terminal; one boundary per element and fills instead of outlines keep dense screens calm; colour carries state only, so every coloured mark still means something |
| 2026-10-03 | Owner decision: Git moves from the tools panel to a collapsible section at the foot of the sidebar; the Git tab's worktrees and the Review list's workspaces become one row per worktree. The deck keeps Orchestrator (and the opt-in Channels). The titlebar toggle's dot no longer counts dirty worktrees. | Git is about the active workspace's repo, so it belongs beside the workspace list; the deck stays the agent's surface. Capping the section at 45% keeps the list usable, and a folded section reads nothing. The dot would have pointed into a panel that no longer shows worktrees. |
| 2026-10-03 | Owner decision (supersedes the same-day sidebar row above): Git is a rail page below Remote, not a sidebar section — the current-branch card, a This repo / All repos scope, then Pull requests and Worktrees. The titlebar branch text opens it; the rail icon carries a red dot for failing checks or a conflicting PR; signing in to GitHub goes through `gh auth login --web`. | A page has the room the sidebar did not, keeps the workspace list whole, and puts every repo in one place. gh owns the credential, so wmux never handles a token. |
| 2026-10-04 | Git page left column = **Pull requests \| Issues** text tabs under one disclosure (choice kept per viewer); issues filter by all / assigned / created / label, open inline, and draw labels as neutral chips | Issues belong next to PRs on the same repo, not on another page; one mounted list keeps the polling cost of #1742. GitHub label colours would be colour without state, so the chips stay neutral |
| 2026-10-04 | Git page v2 (supersedes the row above): a one-line branch bar with one ship button (Commit → Push → Create PR → Open PR), Pull requests · Issues · Worktrees as tabs, PRs and issues as a list/detail split with a sticky detail header, worktrees grouped (in use / no workspace / cleanup candidates), view state in the UI store | The inline accordion buried long bodies and tables in a half-width column; a fixed split gives the detail the room. Worktrees were most of the screen on a busy repo but rarely the task. One primary that names the next step replaces reading four indicators to decide what to do. Cleanup candidates are worded as a check, not a verdict, because a quiet branch can still hold unpushed work |
| 2026-10-04 | Owner decision (Moa, PR E): the right tool panel is always Moa's chat (pinned to the HQ, whatever workspace is active), and Moa's character is the one exception to two chrome rules. **Motion:** the mascot keeps its approved idle squish and blink (and the working / needs-you / done loops) — the only perpetual motion besides spinners and the cursor — and stops under `prefers-reduced-motion` or Moa's own Reduce motion setting. **Size:** the titlebar Moa icon is the mascot at 20px (chrome icons otherwise cap at 16px); at 28px and under only the body and face are drawn. The "needs you" bubble pops under that icon for ~6s (decisions and finished delegations only, one at a time, polite live region, never takes focus), then shrinks to a dot: yellow = a decision waits, grey = an unseen plain reply. While Moa is on, the Moa icon is the panel toggle (DeckToggle hides) | Owner-approved art (Mascot6, Closed) and spec; a character the owner chose to give the main bot a face, kept calm by the reduced-motion switches and the one-bubble rule |
| 2026-10-04 | Git page reads first: Issues is the first tab, the branch bar folds to one thin line by default, issues and PRs drag onto an agent pane or a workspace row to hand them off (a confirm popover with an optional note), and signing in to GitHub is a full-page card with gh's device code shown in-app | Most visits are to read and route work, not to ship; the bar's controls stay one click away. Dropping on the agent you mean is quicker than copying a link, and the popover keeps a stray drop from sending anything. The agent gets a fixed reference to read with gh, never the item's text pasted in. The device code in-app removes the terminal round trip, which is the step most people stall on |
| 2026-10-04 | PR review lives in the Git page's detail pane: checks with failed-run logs and an explicit Rerun failed jobs, review actions, squash merge with an editable subject and an empty body, changed files with line comments and threads, and who acts next from the PR's work link | Reading and routing PRs already happens on this page; leaving for the browser to approve, merge or read a CI failure broke the flow. Every write is pinned to the head commit shown, so a push that lands while you read can never be approved or merged unseen. Logs are untrusted text, shown plain. Rerun is never automatic: a flaky job is a decision, not a retry loop |
| 2026-10-04 | The Git page leads with the repo: `owner/repo` with its open issue and PR counts, then Issues and Pull requests; branches and worktrees (the branch bar, the ship button) move into a secondary Worktrees tab. The Git page sits beside the tools dock instead of covering it, and an issue or PR dropped on the dock goes to Moa | The owner reads the repo's issues and PRs on this page and rarely its branches, so the branch chrome above the lists was noise. Covering the dock hid Moa exactly when work was being routed to it, and the jump from panes-plus-dock to one full-width page read as the window's proportions changing. Measuring the dock instead of reflowing keeps every terminal at its size |
| 2026-10-04 | The repo name in the Git page header is a repo switcher (All repos, each open workspace's repo, Follow active workspace); it replaces the This repo / All repos control. A pick sticks across workspace switches and restarts | The owner asked how to move between repos on the page. A page that jumped whenever the active workspace changed made reading another repo's issues impossible, and one control in the place the eye already reads the repo name beats a second, separate scope control |
| 2026-10-04 | On a rail page the titlebar names the page (Git, Fleet, Schedules, Remote) and hides `+` and the workspace's name and branch; Search & commands stays | Owner feedback: the workspace's title and New workspace read as part of the Git page while they act on the Workspaces page under it. Search & commands is global, so it stays |
| 2026-10-05 | Owner feedback, one PR: the right panel and its toggle exist only while Moa is on; the titlebar never shows New workspace and shows the workspace's name and branch only while the sidebar is collapsed, and drops the search pill (⌘K and the More menu open the palette); the rail drops the Moa `M` entry; the order is `wmux` then a sidebar toggle mirroring the tools-panel toggle, both bare icons with no rest or on fill; Settings leaves the titlebar for a `⋯` More menu at the rail's foot (Settings, Keyboard shortcuts, Check for updates, version), replacing the collapse chevron; the sidebar eases open and closed in 190ms with one PTY refit per pane; every rail page but Settings sits beside the tools dock; Moa's HQ is off the Fleet board, its counts, the titlebar vitals and fleet_triage, and Fleet rows gain Role…; Moa's panel drops its roster and control rows for one header `⋯` menu and scrolls as one column | The open sidebar already shows New workspace and the active workspace, so the titlebar repeated them. The rail's `M` read as a mystery letter and duplicated Moa's panel; the search pill duplicated ⌘K, which the More menu now lists. With Moa off the panel held only an off card and a ledger Fleet already shows. The brand anchors the corner, and a toggle that matches the other end's reads as a pair. Rarely used controls and duplicated sections crowded Moa's panel, clipped its decision cards and repeated the briefing. Moa vanished on Fleet, Schedules and Remote and its button navigated away; Moa is the main bot, not a worker. Refitting per animation frame would thrash every terminal. Removing the roster took away the only GUI for a pane's role, so Fleet rows carry it now |
| 2026-10-05 | A fan-out task's mission channel reads in Fleet, as the selected task's Conversation at the foot beside the preview; Moa's task cards, Waiting on you and the deck ledger link to it. No channel list returns | The Channels tab left with the Moa-only right panel (#1771), and with it the only desktop view of worker reports, instructions and ledger transitions. The foot is already Fleet's selection detail, so the conversation follows the selection without reflowing the columns |
| 2026-10-05 | Chat tool calls fold: consecutive routine calls collapse into one line (`Read 4 files`, `Edited 2 files +5 −1`, `Ran 3 commands`, else `Ran N tool calls`); approvals, questions, failures, notices and replies never fold. Tool rows are quiet: the title is `--text-sub` at rest and `--text-main` on hover or open, the verb is 600 and the object 400, and an inline disclosure chevron points right and turns down (0→90°), like every other disclosure. Diff lines carry a 2px inset bar in `--accent-green`/`--accent-red` at 50% over an 8% fill of the same hue — the only coloured fill, because it is the diff's own state, not a wash. Rows appended after a chat first loads fade in over 150ms (`--motion-ease-out`), never on first load or an earlier page, and not under reduced motion | A long turn buried its reply under one row per call. Folding keeps the reply in view while anything that needs a person stays out of the fold; the 150ms fade is a one-shot state change (a row arriving), not perpetual motion, and the diff fill is how a diff says added and removed |
| 2026-10-05 | Fleet returns to the attention list (one row per agent; Needs you, Ready to review, Running, folded Idle) in today's look, replacing the four-column board. Rows gain a now-doing sentence that outlives the turn (`Last: Edited foo.ts`), terminal output and the task Conversation move to a detail area under the list (selection, Space, Esc), and Moa's delegated work shows as tickets behind a Tickets chip that interrupt only for a pending decision and once with the final report | Columns split one glance into four reads, pushed finished panes away from the sidebar's own Needs you rule, and every card spent lines on chips; the raw glyph line (`✎ foo.ts`) read as code and vanished at turn end, so a finished row said nothing about what it did. A list answers "what needs me, in order" in one scan, the detail area keeps output and conversations one key away without putting terminal text in rows, and delegated work had no place to be followed once Moa handed it off |
| 2026-10-05 | Fleet's Needs you holds decisions only (questions first, then errors, stopped supervision, unconfirmed); finished turns leave it for a folded `Finished N · newest age` row, in Fleet, the rail badge and `fleet_triage` (which gains a `finished` list) alike — this supersedes the 2026-09-27 note that finished rows count as needs you. Moa's final reports sit in their own marked block. The chip, head and badge read one set of arrays; a live region says the count. A Needs you row's detail leads with the question in full and the prompt's choices (or Open approval / Reply / Jump), an error row names its last error line and Check opens the detail on it. One word (Finished), present tense while running, `--text-subtle` for small hint text, a focus ring distinct from selection, the row's side buttons out of the listbox tree (Shift+F10 opens the menu), and the rail badge in needs-you yellow | A design critique found 12 rows in Needs you of which 4 were decisions, three counts that disagreed (11/12/13), a question cut off at narrow widths with `No terminal output available.` beneath it, error rows that only said `Check the terminal`, five words for one finished state, 2.5–3.4:1 hint text, and an indigo badge for an amber state. A finished turn is something to glance at, not something blocking, so it folds like Idle; one set of arrays makes the counts unable to drift |
| 2026-10-05 | Sidebar row hover actions return to the row's flow: they end the git line in place of the diff counts and PR badge, end the name line on a branchless top-level row, or take a line of their own on a branchless nested task; focus reveals them like hover (amends "row actions floating over a faded right edge", 2026-10-03). No fade on the text column; a nested task row's hover never reveals its owner's actions; the workspace list clips horizontal overflow and the sidebar column clips (not scrolls) while it animates | The overlay covered the roster chip, the fade took the branch and diff with the name, and as a descendant rule it faded every nested task row while the owner card was hovered, so a hovered sidebar read as "fleet: ba", "wtas…". A hidden-overflow column is still a scroll container: a focus inside the half-open sidebar scrolled it 148px sideways |
| 2026-10-07 | Owner: blink rows that wait on you; per-user setting; default once + remind every 1 min; finished turns drop the needs-you border for a done dot; reduced motion forces off. Needs you = a question or an approval waits: an open dialog, or a turn that ended on a question (`pendingQuestion`); finished (done dot) = a turn that ended with no question. A plain turn-end `waiting` is never needs you, in the sidebar, the rail, Fleet, the titlebar, the deck briefing and the Tasks dot alike. The Continuous option is the documented exception to "perpetual motion only spinners/cursor" | "Done" and "you must act" looked the same, and a question the agent asks in its closing message is the most common thing waiting on the owner, so it stays flagged. A pulse catches the eye for the rows that wait; the setting lets each user choose how loud, and Continuous is allowed because the user opts in |
| 2026-10-07 | Owner: the needs-you row border goes from dashed to a 1px solid hairline, as quiet as contrast allows: `--attention-hairline` = the look's `--attention` mixed toward transparent at the lowest percentage that keeps 3:1 against `--selection-subtle`, `--selection-hover` and the column behind, measured per look (54–98%; light looks need nearly the full colour). Box shape, radius, the reserved transparent border, the fill and the selected row's accent ring are unchanged; Moa's Waiting on you rows follow | The dash read as busy chrome. One shared percentage could not pass on both dark and light looks, so each look carries its own, pinned by a contrast test |
| 2026-10-07 | Owner: the sidebar's default order is Manual (supersedes the 2026-09-25 Attention default); in Attention a new workspace lands last instead of holding the top; the Ctrl+N number is always shown, left of the name, in `--text-muted`, in every order | Rows that move on their own when an agent starts working cost the user the order they built. Ctrl+N already follows the stored order in every mode, so showing its number everywhere tells the truth about the key even when a sorted list makes the numbers read out of sequence. The number is a key label, not a state, so it stays neutral |
| 2026-10-08 | Owner: Fleet can show its rows as a four-column board again (Running / Needs you / Finished / Idle), as an opt-in layout beside the default list; filters, search, tickets and the detail area are shared, and the old board's folding, dense mode, idle peek and 1–4 keys do not return | Some operators read a fleet by column at a glance; one setting gives them that without bringing back a second set of data, counts or verbs |
| 2026-10-07 | The Ctrl+N number past eight workspaces: 1–8 on the first eight stored rows, 9 on the last, none between (amends the same-day "always shown" row) | Ctrl+9 jumps to the last workspace, not the ninth, so a 9 on the ninth row named a row the key never opens |
| 2026-10-09 | Owner decision: on the Git page, All repos shows Issues and Pull requests as one flat list across repos (newest update first) with a neutral repo tag on each row, and a row of repo chips (counts, multi-select, kept per viewer) as the filter; a row's tag toggles its chip. Today's grouped view stays behind a Flat \| By repo toggle. A repo with nothing open keeps a dimmed chip without a digit (an exception to No dead gauges, so a repo never vanishes from the filter); loading and failed reads show on the chip | Repos stacked in one column do not scale to many projects: the owner scrolled one long column hunting for repo headings. A repo becomes a filter, not the first level of the layout |
| 2026-10-09 | Owner decision: the flat All repos list is split into who-acts-next sections (Needs you · Ready to merge · Agents on it · Waiting on others) with a clickable count summary under the title, judged from wmux's own signals: PR state, the work link to a pane and that pane's live agent status, and the viewer's role per repo. Another author's PR, or an unrouted issue not assigned to the owner, is Needs you only where the viewer can write; a PR with no CI that is mergeable and needs no review is Ready to merge. Settled is deferred | Agents open PRs under the owner's GitHub account, so GitHub's author and review-request fields cannot say whose turn it is. Settled would always be empty because the lists read open items only. An upstream repo the owner does not maintain must not flood Needs you |
| 2026-10-10 | Owner decision (PC rail): the frame is one 48px rail plus a conditional 48px computer column left of it, hidden with 0 web-paired hosts. Amends the one-rail frame | A computer is a scope and a page is a destination; folding computers into the page rail collides with the collapsed sidebar's workspace list, and single-PC users must see no change |
| 2026-10-10 | Owner decision (PC rail, same day): no computer column. The frame is one rail again; the sidebar title is the PC switcher ("Workspaces · <PC> ▾", a dropdown with each computer's state, needs-you count and settings), one badge beside it sums the unselected computers' needs-you, and the collapsed sidebar gets one switcher item. Supersedes the row above | A 48px column took width from every window for a scope most sessions never change; the title already names what the list shows |
| 2026-10-10 | Owner direction (#1987 PR3): the Worktrees tab takes the who-acts-next grammar — In use · Uncommitted changes · No open PR · Cleanup candidates (a merged PR counts) · No workspace — with a summary line, plus snooze (1 hour / 1 day / 1 week / until it changes; any change of state ends it early) kept per viewer. Headers stay neutral; the PR knowledge is only what the page already read, so a repo whose list is not held shows no No open PR | Three groups said where a workspace sat but not what each worktree wanted. Uncommitted work nobody is on, unshipped branches and merged leftovers are the three things a worktree asks of the owner; snooze lets a known one stop asking without deleting it. Reading every repo's PR list for this tab would cost gh calls the page otherwise never makes |
| 2026-10-11 | Owner decision: bring back the file tree as an opt-in column opposite the sidebar, independent of Moa, between the panes and the dock, with its own bare titlebar toggle before Moa's. Amends "the dock opposite the sidebar is Moa's" and "Moa's icon, the right panel's only toggle" | #1440 dropped the toggle with the old right panel, which left the tree mounted but unreachable. A file tree answers "what is in this project" without leaving the terminals, a different job from Moa's conversation, so it gets its own column rather than a dock tab; placing it inside the dock edge keeps rail pages covering it with the panes |
| 2026-10-12 | Owner decision (5.0, agent factory): Moa's panel, its titlebar button, Settings › Moa and the Turn on Moa menu item are gone; the dock opposite the sidebar is always the room dock, with its Room toggle in the titlebar, and says so when the factory is off. The workspace an earlier version made Moa's HQ is an ordinary workspace again: listed, numbered and closable. Amends the rail's More menu, Tools panel, sidebar rows and Settings rows above | The factory's bots replace Moa's brain, so a dock that only existed while Moa ran would leave the dock slot empty for everyone. A hidden workspace nobody can close is a trap once nothing manages it |
| 2026-10-13 | Owner decision (approved layout change): the bots get their own rail page, **Bots** (봇; first named Company the same day), right below Workspaces — Workspaces · Bots · Fleet · Schedules · Remote · Git — laid out like a messenger: a conversation list (each workspace room a group, each bot a 1:1; HQ pinned first, the rest by latest activity) beside the selected conversation as a chat, with a needs-you number badge on the rail item that is the sum of the page's bot rows. Bot fan-out workers leave the Workspaces sidebar (task groups, header count, collapsed rail, Ctrl+N) for their bot's conversation; Fleet still lists them. Bots covers the whole sheet, room dock included (amends "every rail page leaves the dock in view"). Bot avatars are the owner's picture for the bot, else an initials tile on a token colour picked by the bot's id (owner, same day: mascot-style faces read as a copy of the reference app). One grammar exception, owner-approved: the owner's messages are right-aligned bubbles in the user bubble's neutral content-10% fill rather than the reference's accent fill (the accent is never an area fill) | A live dogfood showed bot workers landing in the owner's sidebar under the HQ workspace as "From closed pane" rows: they read as the owner's own work, duplicated what the room shows, and the hidden task workspaces inflated the Workspaces count. The owner reads and answers bots in a messenger every day, so the page takes that structure and interaction; DESIGN.md's tokens, type and one-boundary rule still apply. With the conversation as the page, the dock beside it would show the same room twice |
| 2026-10-13 | Owner decision: a pane is a terminal column plus a work area. Browser, editor and diff tabs leave the pane strip for a work strip on the same header line, split where the body is, with one expand toggle (#2140, #2151) | A pane that held a terminal and a browser split them, but an editor or diff tab covered both as a full-pane overlay, so one pane drew three different ways. One rule for every non-terminal tab keeps the terminal in view beside it; the shared line spends no header height and continues the body's one seam |
| 2026-10-14 | Images and PDFs from the file tree open in a read-only preview tab in the work area, which follows the file on disk (#2150) | The editor read every file as text, so an image showed as garbage and anything over 1 MB as nothing. Agents regenerate plots and reports while you watch, and the competing viewers we checked lose the reader's zoom and page, or show stale or torn files, on exactly that rewrite; so the update keeps the position and only ever swaps in a complete file |
| 2026-10-14 | HTML files from the file tree open rendered in the preview tab, offline by default (owner decision) | Agents produce coverage reports, charts and built docs as HTML, and reading them as source misses the point. A page from a cloned repo is untrusted code that can read the files beside it, so it runs in its own sandboxed partition with the network off until the person turns it on for that tab, and nothing it links to opens without a click |
| 2026-10-14 | Owner decision: the room dock goes — the dock opposite the sidebar, its titlebar Room toggle and the HQ room in it. The right side returns to what it held before the room dock replaced Moa's panel: nothing (Moa's panel existed only while Moa was on, 2026-10-05, and Moa is gone), with the file tree as the only opt-in column on that edge and its toggle the titlebar's last icon. Every rail page, Bots included, fills the whole sheet. Bot rooms and 1:1s are read and answered on the Bots page only. Amends the frame, Titlebar › Right, Rail and pages, the Tools panel (now File tree column) and the 2026-10-12/2026-10-13 rows | The dock showed the same rooms as the Bots page, so the owner met every conversation twice and the Bots page had to cover the dock to avoid a second copy. One place for bot conversations, and the panes keep the dock's 248–320px |
| 2026-10-14 | Owner decision: a bot worker's terminal opens in a worker panel beside its bot's chat on the Bots page — Open and Resume no longer jump to Workspaces or change the active workspace (its "N working" header line of the same day went to the working rail, below) | Bot workers are hidden from the Workspaces sidebar, so a jump landed on a workspace the owner could not find again; reading or answering a worker belongs next to the bot that started it. |
| 2026-10-14 | Owner decision (layout A of the mock, plus grouping): the Bots list is the Workspaces sidebar's column (264px, `--bg-mantle`, its row metrics) at one seam; the body is chat · 6px drag handle on the one seam · worker terminal or thread, 45/55 by default; the list header, the chat's pill row and the panel header are one 44px band with no rule under the chat's; the open bot is one group — its row and its worker tree in a single rounded `--selection` fill, nothing boxed inside, the shown worker in the title weight — while other bots' trees fold until toggled, the toggle inside the row's right edge. The right split is part of the Bots page body, an explicit exception to "nothing docks opposite the sidebar" | A list wider than the sidebar and headers at three heights read as three different apps; the Sidebar already says "this workspace and its tasks" with one fill, and the same grammar here says "this bot and its workers" |
| 2026-10-14 | Owner decision: bot workers are listed like Sidebar tasks inside the Bots list (under their bot: status mark, fan-out mark and title, branch and diff counts, a fold toggle with the count), and a click opens the terminal in the right-side panel; the panel never opens by itself. The working rail keeps the turn lines (and only the tasks the list cannot show); the worker panel's header is one line with a `⋯` menu and no pane chrome under it; a draggable seam shares the width (panel 55% by default); bubbles 4px apart in a run and 12px between runs, 78% wide, 14px/1.45 text; the 44rem column cap only applies without a side panel. Replaces the same day's Open buttons in the rail and the two-line panel header | The rail's Open buttons and the panel's tab strip and split icons spent the space the terminal needed; the Sidebar's task tree already answers "which workers, in what state" at a glance, next to the bot that started them |
| 2026-10-14 | Owner decision (Bots chat redesign; the reference messenger's bubbles and per-bot identity colours): messages are the reference messenger's bubbles in runs (this replaces the same day's flat-rows decision, made before the owner saw the reference's own window) — bots on the left in soft fills with the name above a run and the avatar once beside its last bubble, the owner on the right, runs of one author within ten minutes — with date and time separators, PR and issue links as chips, a centred room pill with its bots' avatars, a one-pill composer with "+", and per-bot identity colours — each bot's own colour (never a state colour) and shape on its avatar mark with a small face, its name above its runs and its `@name` mentions, the one exception to "colour carries state only" — merged system lines, a session "New" label and "N new" pill, a 44rem column, markdown for the owner's text and code blocks with one boundary, a language label, Copy and a 320px cap; a card that waits on the owner stays a distinct card inside its run (the needs-you hairline). Live work moves to a working rail above the composer ("<bot> working · 0:14", its queue, a neutral turn-only Stop, then worker and task rows with Open and Resume), replacing the worker bubbles at the end of the history and the header's "N working" line. A thread shows as its root with "N replies · last 14:02" and opens in a side panel with its own composer instead of narrowing the whole conversation. List rows gain a neutral unread count (this session); needs you still wins | The earlier bubbles spent lines on meta (a kind line, a footer time on every bubble) and split one reply into two colours; the reference messenger keeps bubbles but puts the name and the face once per run and the time between runs. Live work at the foot of the scroll pushed the latest reply away and said nothing about the bot's own turn. Narrowing the view to a thread hid everything else while answering it. The reference messenger's flat rows, rail and threads read faster, and DESIGN's tokens, colour grammar and one-boundary rule still apply |
| 2026-10-14 | Owner decision (Bots onboarding and registration): the empty Bots page is one centred "Name your first bot" panel whose Start turns the bots on, adds the bot to the current workspace and opens its 1:1 (Log in to Claude when the engine cannot sign in); `+` and Add work while the bots are off, after one inline confirm; the add form always shows its repository line with Change and None, a disabled Add says why, and a new bot's chat opens at once with "Starting <name>…"; one wording, Bots on / Bots are off / Turn bots on; no HQ pinning anywhere; a bot's worker is listed only on the Bots page (sidebar, active one included, Fleet, review queue, counts, `fleet_triage`, the phone). Supersedes the 2026-10-13 first-run card and pinned HQ room, and the note that Fleet lists bot workers | Registration was hard: Add hid while the bots were off, the repository attached silently, and a new bot vanished for seconds. A pre-made HQ and Moa bot appeared that the owner never made. Bot workers in the sidebar and Fleet read as the owner's own work and duplicated the Bots page |
| 2026-10-14 | Add PC over SSH has two entry points: a last "+ Add PC over SSH…" row in the PC switcher dropdown and a ghost "No invite? Add a PC over SSH…" link under Connect a PC's Paste tab. An SSH host that needs a person shows "SSH needs you" / "Identity changed" in its switcher row, which opens the host check (owner decision) | A server or VPS has no desktop to send an invite from; the entry belongs where computers are already chosen and where pairing starts, without a new page or rail item |
| 2026-10-14 | Owner decision: + creates a workspace on a granted remote PC. With a paired computer selected, the sidebar header and the collapsed rail show `+` only when that host advertises workspace-create-grant and this desktop holds the grant (added over SSH); it opens a shell there and the new workspace in its list. Hosts without the grant keep no `+`. Amends the collapsed sidebar's "no new-workspace button" | The smoke showed a server added over SSH could only get a first workspace through a local pane's right-click "— remote". The grant already lets this desktop create there, and a `+` that made a local workspace instead would misstate which computer the work runs on |
| 2026-10-15 | Orchestrator decision (team workflow track): in a room with an enabled coordinator, an owner message that names no bot goes to the coordinator alone, and the composer's muted line says "To <lead>"; Add team in the add form makes the five-bot team (lead first) in one action, a ghost button with no new chrome | The owner talks to the team's lead, who decides who works on each request; a room-wide wake of every bot would start five parallel answers to one request |
| 2026-10-15 | Owner decision (bot connections): MCP servers for bots' workers live in one library, Settings › Bots › Connections (one row each: name, purpose, who gets it, Key missing in the needs-you text, on/off, Edit, Remove asked in place), scoped to every bot by default or to the bots picked; a bot's profile lists the ones that apply to it with a per-bot off switch for every-bot ones. Amends the profile's item list only | Grok-Bot-style connectors without a per-bot settings page: defined once, the owner sees every connection in one place, and a bot's profile answers what its workers can reach |
| 2026-10-15 | Owner decision (dogfood of 4.5.0): in a room, an `@Name` of one of its bots anywhere in the message addresses that bot (with any chips picked), and typing `@` suggests the room's bots. Amends the Composer's "an `@name` inside a sentence is plain text" | The owner typed `@대장` in the workspace room and the message did not reach that bot: a mention that works only at the very start of the message reads as broken |
| 2026-10-15 | Owner decision (dogfood of 4.5.0, recommended option): a bot's 1:1 and its workspace room are separate conversations. The 1:1 is its own thread of the room (`dm:<botId>`): the owner's messages there, the bot's answers, its greeting and the work it starts there (a coordinator's request thread); the room never shows them, and a bot's room posts never show in its 1:1. The room is listed once the workspace has two or more bots; a lone bot has only its 1:1, which also keeps what it says in the room. Cards from before 1:1 threads keep the old 1:1 filter. Amends List and System lines | The 1:1 was a filter of the room, so the coordinator's greeting showed in both and every 1:1 message showed in the room: the owner read them as mirrors, and a room appeared for a single bot on its own |
| 2026-10-15 | Owner decision (modelled on the reference messenger the owner uses): group chats are the owner's. No workspace has a room by itself and no bot makes one; `+` › New group chat takes a name and two or more bots of one workspace (they share its repository and room), and a group's pill renames it, changes its bots or deletes it (its messages stay saved). A group lives in its own thread (`group:<id>`) with the work started from it. A group message goes to every bot in it unless bots are picked in the recipients control above the composer ("To: everyone ▾", a checkbox per bot; a typed `@Name` ticks its bot; the picks reset after each send); the coordinator-only routing of an untagged room message is gone. Nobody greets first in a group and no "joined" line is drawn: a bot new to the group introduces itself in its first answer. Add team makes the bots only, then offers Make a group chat with this team. A room the owner had written in became a group named after its workspace, reading on in General. Amends List, Avatars, Needs you, Chat, Composer, Add bot and First run, and the same day's 1:1-and-room row; supersedes the same day's coordinator-only routing and its "To <lead>" line | The owner asked how they would even know who the coordinator is: a hidden rule that sent untagged room messages to one bot read as the room ignoring the rest, and a room that appeared on its own for every team was not a conversation the owner had chosen |
| 2026-10-15 | Owner decision: the Bots rail item is listed only while the bots are on; they are turned on in Settings › Bots, whose switch description says so, and the item appears at once without leaving Settings. Turning them off while the Bots page is open returns to Workspaces; the Toggle Bots shortcut and the palette's Open Bots open Settings › Bots while they are off. The first-run panel is reached only with the bots on. Amends Rail and pages, Bots off, Add bot and First run | A Bots item on the rail from the first launch advertised a feature the owner had not chosen, and opened a page that could do nothing until the bots were on. Settings stays open after the switch because Settings › Bots has its own add form and the plan and connection settings the owner may be setting up |
| 2026-10-15 | Owner decision: settings type and spacing were too large and loud. Settings gets its own calmer scale: regular-weight 14px row labels over quiet 12px descriptions, a 22px/500 page title, 12px nav group labels and 13px section headings in `--text-sub`, the selected nav row in the look's own selection treatment instead of a fixed accent edge, hover on `--hover-fill`, a 30×18 switch with a 24px-tall hit area, a narrower 6px select and a 680px column. Scoped to the Settings page's own rows; the shared Field recipe, dialogs, popovers and listboxes are unchanged | Bold 13px labels over 11px descriptions made every row shout at the same volume, and a fixed accent edge on the nav added a second mark for one selection. Weight and size carry the hierarchy now, with the secondary colour kept at body contrast, so a long settings page reads calmly |
| 2026-10-15 | Owner decision: the agent bar drops Attach, Broadcast and New chat, and its Files button now toggles the file tree column (its own path-picker popover is gone); the titlebar's file tree icon is removed | The owner barely used them, and each duplicated a better home: dropping a file on a terminal or the tree's Insert path covers Attach, Multi Task covers fan-out work without pasting into plain shells, typing `/clear` covers New chat, and two file browsers (a popover and the column) plus two toggles for one column was one too many |
| 2026-10-15 | Owner decision (dogfood): window glass on every theme, in either appearance, with an Off / Soft / Clear setting; the sheet loses its right and bottom margins and the pane column rounds off against the sidebar with a hairline; borrowed terminal palettes sit on their theme's own base. Amends Themes, Frame, Sheet and Window glass | Glass only on a dark Mac read as a missing feature for anyone on a light one, and a fixed 85% frame was barely translucent. The 8px margins spent space on a frame the eye did not need, while the sidebar and panes met with no visible edge. A navy or red theme over a borrowed grey terminal looked like two different apps |
| 2026-10-16 | Owner decision: a bot without a picture is its Mochi character ("Mochi Orb Crew v2", drawn by Grok), the one of its identity colour slot, replacing the four shapes with a face. The characters move: idle breath, blink and one signature twitch; a quicker hop while the bot runs; blink only at 24px and under; paused off screen; still under reduced motion. Amends Avatars and the Motion rule's "only perpetual motion" | The owner picked the crew from a design contest ("go ahead as it is"); a character tells bots apart better than a coloured shape, and its motion says which bot is busy without a word |
| 2026-10-16 | Owner decision: per-bot models. A bot's profile picks the model and effort it thinks on and its workers' model and effort, each a text value with a muted Change (model combobox + effort Select, Cancel and Save), between the repository and on/off lines; Settings › Bots' list rows and the group dialog's bot rows add one muted, truncated note of what is set (e.g. "haiku (latest) · workers opus (latest)"), nothing when both are on the defaults. New Coordinator, Issue and Researcher bots think on a fast model, new Developer and Reviewer bots' workers on the strongest; existing bots keep theirs. Amends the profile's item list only | The owner could not choose models per bot; a one-line note keeps the list scannable without a column, and the profile stays a list of lines with no new control style |
| 2026-10-16 | Owner decision: a bot's profile shows Today — each of its limits (turns per hour and day, worker time, running workers, the queue) with what is used of it, and one line on top naming the first that stops it, in a fixed order | A bot has four separate limits plus a queue cap, and the owner could not tell which stopped it: the reviewer had 26 turns left but no worker time and a full queue, and looked simply stuck. The limits stay as they are; they are made visible |
| 2026-10-18 | Owner decision: photos in Bots messages, from the desktop composer and the phone. A muted picture button beside "+", staged chips and sent thumbnails in Chat view's 2026-09-25 grammar, the full photo in a dialog; no new colour or control style | The owner sends screenshots and photos to bots from the phone; the bot sees the photo itself in its turn, and the desktop draws what was sent the way Chat view already does |
| 2026-10-20 | Owner decision: window glass on Windows 11 (acrylic). Windows 11 22H2+ gets the acrylic backdrop under the same Off / Soft / Clear setting, switched at runtime, with its own coverage numbers (light looks paint more so acrylic does not read grey) and a transparent caption-button strip; Windows 10, older Windows 11 builds and Linux stay opaque, and the setting says why there. Amends Window glass | A live prototype on Windows 11 showed acrylic blurring the desktop much like macOS vibrancy, staying on while unfocused, with clean caption buttons over a transparent strip; Mica read almost opaque. |
| 2026-10-21 | Owner decision: Windows glass keeps text legible over any backdrop. On Windows the frame and sheet coverage is derived from each theme's tokens so the secondary text keeps 4.5:1 and the muted text 3:1 (primary 4.5:1) in both the frame and the sidebar over a pure white (dark theme) or pure black (light theme) backdrop seen fully through the acrylic; a theme that cannot within 90% coverage is opaque on Windows. macOS keeps its fixed numbers. Amends Window glass | Measured on Windows 11 build 26200 with a white window behind wmux: the dark Tint sidebar composited to #666668 and the secondary text dropped to about 2.3:1, so the owner could not read the sidebar or titlebar. The fixed numbers assumed dark acrylic stays deep, which it does not over a light backdrop |
| 2026-10-21 | Owner decision: a pane is linked across PCs by one share from the PC that accepts connections. On the receiving PC the share is a Needs you row of its own (no pane picker on the row; Accept… opens the link dialog with the other PC's pane fixed), counted with link requests, neutral apart from the one attention hairline and badge | Pairing, ticking the pane, a request from the other PC and an accept there took two machine switches; a share is the sharing PC's consent, and the receiver's Accept is its own. The dialog keeps "no pane picker on a request" for the row |
| 2026-10-21 | The share starts from the pane's menu: **Share this pane with <PC>…** (or **with another PC…** when several joined this one), shown only while a PC has joined. Its dialog names what that PC will see (the pane, its agent, repo and folder), two direction boxes ticked by default, one muted line on what happens next, and Share as the one primary; a reason it cannot share (older wmux, not connected, already linked, already shared with Withdraw) is a muted line, never a colour. When the other PC accepts, a toast says so and the link row names its pane; Unlink hides the pane again unless it was shown before the share or the list was saved since | One action on the sharing PC replaces ticking the pane in Panes to show and accepting a request. The checklist stays for showing panes without a share, with a hint pointing at the menu |
| 2026-10-21 | Owner decision: Plugins is a rail page (after Git) with a puzzle-piece glyph — a mantle catalog list (Signature, Catalog, Installed, Connectors) beside one detail with the permission list and one primary per state; Signature is a catalog data flag (Office today). Connectors lose their rail item and become the page's Connectors row; the `connectors` route redirects there. Settings › Plugins keeps only a link. Plugin rail items get their catalog glyph instead of the Workspaces one | One home for everything that extends wmux; the signature plugin is seen first; the rail drops an item |
| 2026-10-21 | Owner decision: a muted "Agent not set up · Set up" row at the sidebar's foot while no agent is ready (shipped in #2535) | The user who chose Later in the setup wizard keeps one quiet way back to it |
| 2026-10-21 | A bot's HTML file and an `html` block in the Bots chat get **Preview / Code** (a compact segmented control), not the preview tab's View source | The preview tab is a page opened to be read, so the source is a detour behind one button. Here the two views are peers in one place: a page opens as Preview, a chat block as Code, and one control switches either way |
| 2026-10-21 | Owner decision: Windows keeps the sheet's frame-side corner rounded. Maximized, the corner beside the rail and the titlebar keeps `--sheet-radius` with the hairline on the top and rail side; only the corners on the screen's edges are square. Under window glass the sheet's edge is a 10% text ink, not the opaque `--sheet-edge` | Maximized Windows rail pages showed a right angle where macOS and the terminal view show a curve, and the rail met the sidebar with no hairline. Over translucent acrylic the opaque hairline read lighter than the frame on tinted backdrops and vanished on light ones (measured on Windows 11, Paper) |
| 2026-10-21 | Owner decision: every theme's muted text (`--text-muted`, `--text-subtle`) reads at ≥3:1 and secondary text (`--text-sub`, `--text-sub2`) at ≥4.5:1 on its own surfaces: the sheet, the sidebar column, the frame and rail, and the row hover over the sheet and the column. Paper, Mono, Mono Light, Amber, Catppuccin, Monochrome, Stars & Stripes, Red Dynasty, Nightowl and Void were lifted by HSL lightness only, the least that clears every surface; their hue and saturation stay. Where a hand-pinned `--text-subtle` would have sunk below the lifted muted, it now derives from muted and sub like every other theme (Catppuccin takes Overlay2). `themeTextContrast.test.ts` pins the floors | Muted text on ten built-in themes fell under 3:1 even on the theme's own opaque sidebar (Void 1.66, Catppuccin 2.60), so labels, counts and metadata were hard to read |
| 2026-10-21 | Orchestrator decision (owner direction, recommended option): in a room or group chat with an enabled coordinator, an owner message that names no bot goes to that coordinator alone, which hands the work on; a message that picks bots goes to exactly those, and a room or group without a coordinator still reaches every bot. The recipients chip reads "To: <lead> ▾" (no fill: it is the default) and its muted line and the empty group's line name the lead. Amends Group chats and Composer; reverses, for a group with a coordinator, the 2026-10-15 group chat row's "the coordinator-only routing of an untagged room message is gone" | Woken together, every bot answered one message (four answers, some saying they had nothing to add), the coordinator restated what the others had just posted, and the work it promised to report never came back to it because it had not dispatched it. The chip names the lead, so the owner can see who gets the message, which was the reason the earlier routing was dropped |
| 2026-10-21 | Owner decision: a muted "Enjoying wmux? · Star on GitHub ×" row at the sidebar's foot, below "Agent not set up" in priority, plus a permanent Star row in Settings › About. It shows three days after first run and after 20 new agent sessions; each "Not now" doubles that number, restarts the count and adds a three-day cooldown (modelled on Orca and Superset). The star is one click through the user's own gh, else the repository page; no telemetry | Stars are how other developers find wmux, but a prompt that nags costs more than it earns. Asking only after real use, backing off on every no, and never asking again once starred keeps it to a few asks per user; gh makes the yes a single click without a new sign-in, and the counting stays on the machine |
| 2026-10-22 | Owner decision: Windows glass gives muted text a glass-only value. On Paper, Amber, Catppuccin, Monochrome, Stars & Stripes, Red Dynasty, Gruvbox Dark Hard and Void, `--text-muted` under `html[data-glass][data-platform="win32"]` is the opaque token moved by lightness only, the least step that passes the coverage gate; the gate judges that value, and the worst-backdrop model is unchanged. macOS and glass Off keep the opaque token. Mono, Mono Light and Nightowl stay opaque on Windows (their `--text-sub` misses 4.5:1 at the cap) | After the opaque contrast lift, eleven themes were still opaque on Windows because muted text sized for the opaque sidebar missed 3:1 over the worst backdrop even at 90% coverage |
| 2026-10-22 | Orchestrator decision (owner direction, recommended option): the selected row (`--selection`) joins the surfaces of the 2026-10-21 contrast floors, so muted text reads at ≥3:1 and secondary text at ≥4.5:1 on it over the sheet and the column. Paper, Mono, Mono Light, Amber, Catppuccin, Monochrome, Stars & Stripes, Red Dynasty, Nightowl, Gruvbox Dark Hard and Void were lifted again by HSL lightness only, the least that clears it (at most 4.5%); Nightowl's and Stars & Stripes' pinned `--text-sub2` moved with them so sub2 stays above subtle. The `--selection-hover` fill (a selected Fleet card, a hovered needs-you row, a hovered chip or button) draws muted text as `--text-subtle` instead, which reads at ≥3:1 there; the global tiers are not lifted for it. The stronger `--selection-emphasis` fill (an open chip, a pressed or active button) draws muted text as `--text-sub`, since subtle falls under 3:1 there on Mono, Amber, Nightowl and Gruvbox Dark Hard. The Windows glass-only muted values were re-derived from the new tokens by the same least-step rule: Amber, Catppuccin and Gruvbox Dark Hard no longer need one, and Mono now passes the Windows glass gate with its opaque tokens. Amends the 2026-10-21 contrast row and the 2026-10-22 glass row | Selected rows were never measured: on Gruvbox the selected row's muted text read 2.61:1, and on ten themes the largest selection mix that passed was the 5% hover fill itself, so lowering `--selection` alone would have merged selection into hover. Holding the 15% fill to the same floor needed lifts up to 8% and pushed muted into subtle on Amber and Gruvbox |
| 2026-10-22 | Owner decision: Windows glass draws muted and secondary text exactly as macOS glass does, from each theme's own tokens with the same hover, selected and emphasis fills; the glass-only muted values of 2026-10-22 are withdrawn. Windows keeps its derived coverage (2026-10-21), so a theme whose own text misses the gate at the 90% cap is opaque on Windows: Paper, Mono Light, Monochrome, Stars & Stripes, Red Dynasty, Nightowl and Void. Amends Window glass | Asked to make Windows glass match macOS. The extended check showed that any fill under a row (even the 5% hover) pulls the glass-only muted back under 3:1, so the lift only moved the problem; and macOS's fixed numbers on Windows would bring back the illegible sidebar over a white window that the 2026-10-21 decision fixed. Same text everywhere, with Windows opaque where it cannot stay legible, was the owner's choice |
| 2026-10-22 | Owner decision: the Remote page is the one place PCs are connected. Connect a PC gains a LAN tab (the LanLink PIN pairing, moved from Settings); Settings › LAN keeps the LanLink and A2A listener switches plus a link to the Remote page, and its A2A invite, join and PC lists are gone. PC rows stay keyed by the A2A hostId and never merge across transports; each says what this PC allows that PC, with a slot kept empty for starting new agents. The A2A invite stays 8 characters, shown grouped as ABCD-EFGH for reading out while the whole invite stays what is copied; a PC known only as a joiner reads Disconnected with its last-seen time | Connecting a PC lived in three Settings sections and on the Remote page at once, so it was unclear where to start or where a PC went. One page, one dialog keeps every way in together; the security limits (the 10-minute invite, attempts and backoff, the 2-minute PIN and its 5 failures) are unchanged, so the code length is too |
| 2026-10-23 | Owner decision: voice dictation. A mic button in the Chat view and Bots composers (the text goes in the box, never sent), a one-time consent before the speech model is downloaded, and, for terminal panes, a rebindable "Dictate into this pane" shortcut and palette entry with an in-pane corner chip instead of a header button. Amends the Bots composer's "No microphone" | The owner dictates prompts instead of typing them. The pane cluster is fixed at five buttons, so the pane gets a key and a palette entry; a toggle rather than hold-to-talk because a held chord through a long sentence is awkward and keyup on chords is unreliable |
| 2026-10-23 | Owner handoff: Tailscale easy connect. The Remote page's This computer band gains the four-check Tailscale checklist (installed, signed in, this PC on the tailnet, the other device visible), each failure with exactly one button that only opens the download page or the Tailscale app, or unfolds how to sign the other device in. A connection over the tailnet checks Tailscale first and fails at once with the reason and that button. A PC connection in use (an A2A PC with an active link, an attached workspace share) that drops gets one warning toast once the drop outlasts its grace (A2A 16 s, the first four redials; workspace share two failed polls in a row), naming Tailscale only when the connection's own address is surely Tailscale's (a `*.ts.net` name or a peer its status lists), and the toast goes away when it reconnects; phones are out. A silent A2A drop is seen after 40 s with nothing from the other end, on both sides of the pair (the side that was joined ends a stream whose joiner stopped pinging), so it is reported by 56 s | Getting two machines onto the tailnet was a sequence of unexplained timeouts. One glance says which step is missing and one click opens the place to fix it, while signing in and connecting stay the person's own act. The grace keeps a reconnect blip silent |
| 2026-10-24 | Owner decision (chat view G2/G5): each chat view carries a neutral kind badge, "Terminal-linked chat" (chat 1) or "Chat only" (chat 2), with a hover line; chat 1's approval note reads "Waiting for your approval. Answer in Terminal". The Terminal / Chat switch is labelled "Show as chat", and the first Claude or Codex start in a pane asks once per agent "Show this as a chat?" (Show / Keep terminal); users who already set the chat view are never asked | Two chats looked alike and the approval note read like an error. Asking once, at the moment an agent first runs, finds the chat view for new users without changing anything for people who already chose |

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
- **Workspace row:** status mark · name (13px) · collapsed summary · status
  word, all on the name line, so the line under it has the row's full width.
  The status word is `Needs you` (attention orange) or `Error` (red); it never steps
  aside for the hover actions. The collapsed summary is one status mark and a
  count per non-idle status group, most urgent first (the total alone when all
  are idle); it stays visible at rest — except on a row whose only agent is
  idle, where the chevron waits for hover or focus and draws no `1`. A
  needs-you row's second line is the agent's question (one line, plain text,
  full text in the tooltip and the row's accessible name) instead of the git
  line, with the actions at its end. On a narrow git line the branch keeps at
  least ~5 characters: the `+N −M` counts give way first (they stay in the
  tooltip), then the sync badge; the PR badge always stays. The git line uses the branch and worktree icons;
  no text glyphs that can render as emoji (⎇ ⊕ ⚠ ✓ ✗).
- **Agent row:** status mark · title · agent kind (non-Claude only) · muted trailer (live
  activity while running, else the pane coordinate) · muted subagent count
  while the agent has any running (`2 subagents`; nothing at 0) · elapsed time since the
  last activity, right-aligned (11px like the rest of the roster row, muted,
  tabular — the 11px metadata floor). A pending question
  keeps its own attention-orange second line. Stashed rows keep their status word (their
  proof of life, 2026-08-24).
- **Agent kind:** no identity glyph. Claude is the default and gets no mark;
  any other agent names itself in muted 11px text after the title (its display
  name, e.g. `Codex CLI`, truncating before the title does), and only when the
  row has its own title that is not the agent itself — a `Codex` title beside
  `Codex CLI` would say it twice, and the title slot already is the agent.
  The trailer no longer repeats the vendor. Shells get nothing.
  The name stays in the tooltip and accessible name. Never a vendor logo or
  favicon (trademarks; written permission required).
- **Fan-out nesting:** a task workspace renders under the workspace that fanned
  it out, and inside it under the roster row of the pane that requested it
  (2026-09-27): `Workspace › pane row › tasks`, indented on a hairline guide.
  The pane row itself carries the group's fold chevron and a muted mono
  `⑂ N` count; folded with a task that needs you it reads `⑂ M/N` with M in
  attention orange (the only rendition while folded). Its ⋮ (revealed on hover or focus,
  like the row's `@`, named for its pane) holds `Show K finished tasks
  waiting for review` and `Close finished tasks (N)`. A pane with no tasks
  renders as before; an open pane whose agent ended keeps a muted row (no
  status mark) while it has tasks. Tasks are matched to the owner pane that
  holds the origin's surface now — a stashed pane included — else, for an
  origin without a surface, to its pane; never by pty id. Tasks with no such
  pane — the requesting tab closed, the GUI or the orchestrator asked, or the
  stamp predates origins — collect in one trailing group under the owner,
  with the rollup line below. Its name says who asked: `Started from the app`
  (the GUI), `Started by the orchestrator`, `From closed pane` (a pane origin,
  or none recorded), or `Other tasks` for a mix. Folding the roster folds its
  pane groups, so a task that needs you must still show: the roster holds
  open while one of its tasks is the active workspace, re-opens each time
  one more starts needing you (and does not fold when its owner moves to the
  background then), stays open while the workspace is being renamed, and its
  collapsed summary adds a muted `⑂ N` — `⑂ M/N` with M orange when M of them
  need you (said in its accessible name too). Fold state is kept per owner
  and pane and dropped when the pane or owner closes; the old per-owner key
  is carried over once. Nested task rows use their own hover group, so
  hovering the owner reveals none of their chrome. Pane rows keep layout
  order; a task that needs you lifts its owner in the Attention order. A group is open
  while its owner is active or one of its tasks needs you, otherwise folded; a
  user toggle is remembered, and a group always opens while one of its own
  tasks is the active workspace. A task row carries no "Needs you" word and
  no box (its orange ring and question line stay; the rollup names the count) and shows its shortcut
  hint only on hover — the indent leaves the name no width to spare. A rollup line (the "From closed pane" and "From closed workspace" groups) reads `N tasks · M need
  you` and draws nothing at zero; `· K to review` follows when K > 0 — a
  muted link (steel on hover) that opens Fleet with its first Ready to review
  row selected; "need you" is orange only while the group is
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
- **Order:** Manual (default), Attention, or Recent activity — the header's
  order button or Settings › Appearance › Sidebar. Attention: needs you →
  error (a failed turn: its own tier, so an old error never sinks below a
  fresh finish; Fleet still lists it under Needs you and counts it there) →
  finished (a turn that ended and was not looked at) → running → unconfirmed
  → idle; within a class the most
  recent event first. Plain `waiting` with no question is idle here, as in
  Fleet, and draws no "Needs you" wash or label. A fan-out owner scores as its
  most urgent nested task, so a task that needs you lifts its group. A
  workspace created in the last three minutes holds the last slot of the
  unpinned rows, so a new row lands at the end of the list. Rows never move under the pointer or keyboard focus: a re-sort
  applies after the list has been quiet for 3 s (at most 10 s after the first
  pending change), or at once when the pointer or focus leaves; adds and
  removals land immediately. The non-manual orders are display-only:
  drag-to-reorder pauses. Every row (not a nested task or a Snoozed/Settled
  row) shows the number its Ctrl+N jumps to, left of its name,
  in `--text-muted` and in every order; Ctrl+N follows the stored order, so in
  a sorted order the numbers can read out of sequence. Ctrl+9 is the last
  workspace (browser tabs), so the first eight stored rows show 1–8, the last
  shows 9, and the rows between show none. Sessions that never
  chose an order use Manual; an explicit choice is kept.
- **Pinned to top:** row menu › Pin to top / Unpin, in every order (not on a
  nested task row). Nesting wins: a nested task cannot be pinned, and a pinned
  workspace that becomes one leaves the group. Pinned workspaces lead the list and the rail in every
  order, in the order the user gave them, and never re-sort; only the rows
  below follow the chosen order. A pinned row carries a muted pin glyph
  (`--text-muted`, never amber) and no group header or divider — the glyph
  and the position are the signal. The group is the head of the stored order,
  so the Ctrl+N numbers, the rail numbers and the phone's `order` all read
  pinned-first. Pin, unpin and reorders
  inside the group apply at once (they are the user's own act, not a
  re-sort). Drag reorders inside the group in every order; in Manual a drop
  takes the target row's pin state, so dropping beside a pinned row pins and
  beside an unpinned row unpins. Pinning lands the row at the end of the
  group; unpinning at the top of the rest.
- **Bookmarked:** row menu › Bookmark / Remove bookmark (or the palette's
  "Toggle bookmark for this workspace"), on any row. A bookmark
  never moves a row — order is the pin's job — and only feeds the filter's
  Bookmarked only check, where a bookmarked owner keeps its nested fan-out
  tasks. A bookmarked row carries a muted ribbon glyph after the pin's place
  (`--text-muted`, never a colour: a bookmark is the user's mark, not a
  state). Ctrl+N and drag keep the stored order while the check is on, as
  under every filter; a selected row it hides is called out like any filter.
  With nothing bookmarked the empty list says how to bookmark. Bookmarks
  persist with the session; the check, like every filter check, lasts for
  the session.
- **Changed since you last looked:** a 6px `--text-main` dot (never amber —
  Fleet's rule) after the name, on the workspace row and on the agent row,
  when an agent tab's status or pending question changed (any number of
  times, round trips included) since its workspace was last on screen and it
  now needs you or has finished. Tracked per agent tab, not per pane. On
  screen means the active workspace, plus the multiview grid only while the
  active workspace is in it, and no local workspace while a remote mirror is
  showing. It clears as soon as the workspace is on screen. On a turn that
  finished with no question it is the row's done dot (`data-sidebar-done`);
  that row draws no needs-you hairline (2026-10-07).

### Sidebar shortcuts and Agent dock refinement (2026-09-21)

Sidebar shortcuts appear in order: Search, Remote, Fleet. Search opens the
command palette. Remote opens the existing browser/phone pairing controls;
Agent, Git and Channels remain in the tools panel. The compact sidebar
uses the same destinations with accessible names.

The 2026-10-05 rules for Moa's panel and the Agent conversation's composer
rows went with them in 5.0 (Decisions Log, 2026-10-12), and the room dock
that replaced them went on 2026-10-14: nothing docks opposite the sidebar.

### Fleet page (2026-10-05 list; a rail page since 2026-10-03)

Fleet is a rail page, not an overlay: it fills the sheet while the Workspaces
page stays mounted, full size and inert underneath. It is an attention list
(andon), not a map: one row per agent, in sections read from the sidebar's
own classification (`fleetAttentionClass`), so a pane cannot read
differently in the two places, and in the order `fleet_triage` returns.

- **Sections:** Needs you (decisions only: input requests first, then
  errors, stopped supervision and unconfirmed panes, plus tickets waiting on
  a decision) · Final reports (Moa tickets whose final report is unread, a
  marked block of their own) · Ready to review (finished fan-out tasks, one
  row per task) · Finished (turns that ended and have not been looked at),
  folded to one `Finished N · newest age` row that expands · Running · Idle,
  folded to one `Idle N · oldest age` row that expands. A finished turn wants
  a look, not a decision, so it never sits in Needs you. A section head is
  sentence-case 12px text with a status dot and its count; an empty section
  is not drawn. Plain shells sit only in Idle and never keep the empty state
  from showing.
- **One count:** the Needs you chip and the Needs you head read the same
  two arrays (pane rows and decision tickets); the rail badge and the titlebar's `N need you` count the
  same pane rows (`selectFleetSectionCounts`) and leave tickets out, which
  the rail's tooltip says — so the titlebar and the rail badge always agree,
  and match the chip whenever no ticket waits on a decision. A polite live region announces the count when it
  changes, never when Fleet opens.
- **Row:** status (dot and word), the title (an open ticket's title when the
  pane holds one, else the task or pane name), workspace · agent · role ·
  stash, the now-doing line, elapsed time under it and one verb (Respond,
  See result, Check, Open). One word for a finished turn — Finished — in
  the chip, the fold and the row's status. A row is a fill on hover
  (`--hover-fill`) and selection (`--selection`), never a box or a rule;
  keyboard focus is a 2px `--accent` ring on top, so a focused selected row
  shows both. Two buttons share the right lane, shown on hover or focus:
  details (a chevron that turns when open) and ⋮; both are pointer twins of
  keys (Space, Shift+F10) and stay out of the listbox's tree. A row's
  accessible name is its title, status, workspace and (for a question or an
  error) that text clipped. Rows never show terminal text, except an error
  row's last error line.
- **Now doing:** the agent's tool, as a sentence in the activity mono. A
  running agent says what it is doing in the present tense (`Editing
  foo.ts`, `Running npm test`); a finished or idle one says `Last: …` in the
  past tense (`Last: Ran npm test`), from the last tool it ran, which
  outlives the turn's end. An agent that reports no tools (Codex, others)
  shows its last reply; a question shows in quotes and wraps to two lines;
  an error row shows the last `Error:` / stderr-shaped line of its terminal
  (mono), else its label; stopped and unconfirmed rows keep their label.
- **Completion checks:** a finished pane's evidence badge reads its most
  recently updated delegated task, only when that task completed. A newer
  working, failed or canceled task suppresses older success evidence. Missing
  evidence says "No verification reported"; failed checks use a red cross,
  partial or unverified evidence stays neutral, and only an entirely verified
  set gets a green check. Text names each state independently of colour. The
  tooltip and accessible description identify the agent as the source and
  list the reported checks, including failed commands. This does not change
  the task completion gate or claim that wmux independently ran those checks.
- **Filters and summary:** the line under the title leads with the filter
  chips — Needs you, Running, Finished, Idle, Tickets — each with its count,
  hidden at zero; pressing the pressed chip shows everything again. Then
  approvals, LAN messages, account usage, the next schedule and phones
  watching, each only when it is not zero, and Settled. While Fleet is the
  page, the titlebar drops its own running / need you counts and usage.
- **Detail area:** under the list, opened by a deliberate selection (an
  arrow move, the row's details button, Space) and never by the focus Fleet
  takes when it opens; Esc closes it before it closes Fleet. It shows the
  selected agent's last 20 lines of output (40 for an error row, its error
  line marked and scrolled into view) and, for a fan-out task, its
  Conversation beside them (stacked below 900px): read-only, oldest first,
  live, in the mantle fill. The sidebar's Tasks line opens Fleet on that
  task with the detail open. For a
  Needs you row the detail leads with what it asks, above the output: the
  question in full (never truncated), the numbered choices of the prompt
  drawn at the bottom of its terminal (read-only), then Open approval (when
  an Approvals row waits on that workspace), Reply… (the row's composer;
  never on a permission prompt) and Jump to pane. An error row leads with
  its last error line. Check (an error, stopped or unconfirmed row's verb,
  click or Enter) opens this detail in place instead of jumping.
- **Board layout (opt-in):** a List | Board switch in the header (and the
  same choice in Settings › Appearance, saved with the session) draws the
  same rows as cards in four columns — Running, Needs you (with decision
  tickets), Finished (unread final reports, Ready to review tasks, finished
  turns; a task shows once, as its review row) and Idle — each headed by its
  chip's word, a dot and its count; an empty column is not drawn. Nothing
  folds. A card is the row's content restacked (status and verb, then name,
  workspace · agent, the now-doing line) on a `--selection-subtle` fill, no
  border or stripe. ↑↓ / Home / End move in a column, ←→ to the nearest
  non-empty column at the nearest row; Enter, Space, the row verbs, filters,
  search and the detail area are the list's. The Tickets filter stays a list.
  The list remains the default.
- **Tickets:** Moa's delegated work, one row per job — a hand-off waiting for
  its click, or a WorkLink with its A2A task. A chat message is never a
  ticket. States: Queued, Working, Needs your decision (yellow), Done
  (green), Failed (red); finished tickets stay listed for a day. Moa is the
  operator's chief of staff, so a ticket interrupts only for a decision Moa
  cannot make and once with its final report: it joins Needs you while a
  linked decision is pending; when it is done or failed it sits in the
  Final reports block (never among pane rows, never in the Needs you count)
  until that report has been shown on a ticket the operator chose (it stays
  in place while selected; a selection that merely falls onto it does not
  count).
  Queued and working
  tickets are quiet: the Tickets filter and the pane's title only, no badge,
  count or toast; the rail and sidebar counts stay the panes'. A ticket's
  detail holds the request, the decisions still waiting (each opens its
  workspace's decision card), the result and its verification count (read
  back from the daemon's task record after a reload; that record keeps a
  finished task for 30 minutes, after which the ticket says the result is
  no longer kept, and that counts as the report shown), and Jump to agent.
  An unapproved hand-off never retitles a pane, and a ticket that names no
  pane titles one only when its workspace runs a single agent.
- **Role:** a row's ⋮ menu holds Jump, Message (M), Stash (S), Label (L),
  Role… (R), then Close pane (⌫). Role… opens an inline picker under the row:
  None, then the roles (built-in, plus the pane's custom role), the current
  one selected; a pick writes the pane's role through the same path as the
  dock roster and None clears it. A set role is plain text on the row.
- **Empty fleet:** no agents is one call to action, the Tickets way in when
  there are any, and the three newest finished tasks.
- **Keys:** ↑↓ (and ←→) move through the list and open the detail, Home/End
  go to its ends, Enter jumps (Check rows open their detail), Space toggles
  the detail, Esc closes it, / searches, Shift+F10 or the Menu key opens
  the row's ⋮ menu, a opens the Approvals tab with the request waiting on
  the agent focused (it never approves); m, s, l, r, Backspace, d, p and j
  as before.
  A jump to a pane returns to the Workspaces page and hands it focus.

**Ready to review (2026-09-25; between Needs you and Running).** It lists fan-out TASKS, not panes: one row per task whose record is open
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
task with the reason. A refusal other than an unpushed branch carries one toast
action, Close and keep folder (#2388): it closes the task, leaves its folder on
disk as it is and names where; the sidebar's Close finished tasks, the task
diff and the task cleanup list offer the same. One close or PR runs per task at a time; the row says
"Closing…" / "Creating PR…" meanwhile. The section shows under All and Complete filters and in
search (title, owner, branch); it is not drawn when empty. It is the second
rendition of a finished task (the pane rows in Needs you are the first), so it
gets no filter chip, tab count or footer badge.

### Channel task records (2026-09-22)

The Channels tab groups linked mission records before shared discussions. Use
quiet navigation rows: 13px task titles, 11px secondary context,
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
