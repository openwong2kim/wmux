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
| Zinc | dark, neutral | `#FAFAFA` | Geist | 6px | fill + 1px ring | fill | no |
| Graphite | dark, cool | `#4C8DFF` | IBM Plex Sans | full round | fill (`#1B2433`) | fill + 2px accent underline | no |
| Paper | light | `#5B5BD6` | Figtree | 7px | fill (`#E4E4EA`) | fill | no |
| Amber Line | dark, warm | `#E8A33D` | Geist | 6px | 2px accent left bar | fill + 2px accent underline | no |

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
| `bgBase` | `--bg-base` | the sheet: panes, pages, dock |
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
| `--selection-hover` / `-emphasis` | 15% / 20% | 10% / 14% | hovered chip / pressed or active icon button |

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
in the terminal whatever the chrome accent.

## Window: frame and sheet

```
┌ frame ─ titlebar 40px ───────────────────────────────────────────────┐
│ [lights][wmux      ◧]            (drag region)            [vitals][Moa]│
├──┬───────────────────────────────────────────────────────────────────┤
│  │╭ sheet ────────────────────────────────────────────────────────╮ │
│r │ sidebar   │ pane tab strip                       │ tools dock    │ │
│a │ 264px     ├──────────────────────────────────────┤ 248–320px     │ │
│i │ (mantle)  │  terminal grid (THE HERO)            │               │ │
│l │           │                                      │               │ │
│48│           │  [agent bar — overlay, on approach]  │               │ │
│  │╰───────────────────────────────────────────────────────────────╯ │
└──┴── 8px frame margin ───────────────────────────────────────────────┘
```

- **Frame:** the titlebar row, the 48px rail and an 8px margin
  (`--sheet-inset`) on the left, right and bottom, painted `--frame-bg` — a
  step darker than the sheet in the dark looks, a soft grey in Paper.
- **Sheet:** one rounded panel (`--sheet-radius` 12px) flush under the
  titlebar, holding the sidebar, the panes and the tools dock. It is set
  off by a 1px `--sheet-edge` hairline and a faint `--sheet-shadow`, nothing
  else. Inside, the sidebar keeps its mantle tone and meets the body at a
  single seam.
- **Native fullscreen** (any platform): the sheet drops its margins and
  radius. The rail stays.
- **Terminal geometry is untouched** by the frame: margin changes, a sidebar
  collapse and fullscreen each refit the terminals once, never per frame.
- **Window glass (macOS, dark looks, `--theme-glass: 1`):** the window gets
  an under-window vibrancy material behind a transparent background, and
  `data-glass` on `<html>` makes the **frame only** paint at 85% over it. The
  sheet, the panes and every terminal stay opaque, so the hero never changes
  with the wallpaper. Glass needs macOS itself to be dark too: the material
  follows the system appearance, and changing that is app-wide (it would
  flip browser surfaces' `prefers-color-scheme` and the native menus), so a
  dark look on a light Mac keeps an opaque frame. Light looks, looks with
  `glass: false`, and Windows and Linux are opaque. The page fades through `color-mix(… 0%, transparent)`, never the
  `transparent` keyword (which interpolates through black).
- `BrowserWindow.backgroundColor` follows the default look so the first
  frame never flashes white; no native menu bar is visible
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
  bar drawn on the sidebar's side), the left-hand pair of Moa's panel toggle
  at the bar's other end. **Both titlebar panel toggles are bare icons:** no
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
  link and the branch (the shortcut to Git). On a rail page (Git, Fleet,
  Schedules, Remote) the title is the page's name, with no branch, whatever
  the sidebar does. Settings follows the Workspaces rule.
- **Centre: the drag region.** Nothing sits between the left segment and the
  right cluster; the whole gap drags the window. The command palette has no
  titlebar entry: ⌘K (Ctrl+K on Windows and Linux) opens it, and the rail's
  More menu lists it so it stays discoverable.
- **Right:** Fleet vitals as appearing chips (`N running`, `N need you`; only
  when nonzero, and dropped while Fleet is the page), the account usage when
  it matters, then Moa's icon, the right panel's only toggle, while Moa is
  on. With Moa off there is no right panel and no toggle (see Tools panel).
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

- **Pages, in order:** Workspaces (home: the sidebar, panes and tools dock)
  · Fleet · Schedules · Remote · Git. Settings is a page too, opened from the
  rail's More menu or ⌘,.
- **The rail's foot** holds one `⋯` **More** button (named "More",
  `aria-haspopup="menu"`). Its menu, beside the rail and level with the
  button: Command palette (with ⌘K), Settings (with ⌘,), Turn on Moa…
  (only while Moa is off; opens Settings › Moa), Keyboard shortcuts
  (Settings › Shortcuts),
  Check for updates (opens Settings › General, where the check reports, and
  starts it), then the version line as muted text. It is the pane actions
  menu's body (arrows, Enter, Escape, focus back on the button). The sidebar
  toggle is in the titlebar, so the foot carries no chevron.
- **Moa has no rail entry.** Its panel is its home, and the panel's ⋯ menu
  (View as terminal) shows its terminal in place. Moa's workspace stays out
  of the workspace list; when it is the active workspace (Settings › Moa),
  Workspaces leads back to the first listed one.
- **Rail item:** a 19px icon on a 40px square. The current page is a soft
  `--selection` square (plus the look's `--select-ring`) marked
  `aria-current="page"`; hover is
  `--hover-fill`; Fleet's and Remote's needs-you counts are small number
  badges on the icon's corner. Every button is named, and the arrow keys move between
  them.
- **A page fills the sheet beside the tools dock** (every rail page — Git,
  Fleet, Schedules, Remote — leaves the dock in view and usable, so Moa is in
  reach; the page is inset off the dock by measuring it, never by reflowing
  the sheet, whether the dock sits inline or floats as the narrow-window
  overlay; Moa's titlebar icon opens and closes it in place there). Settings alone covers the whole sheet, dock included. The
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
- **Badge:** one `--attention` number badge beside the title, the sum of
  the needs-you of the computers **not** selected (this computer's Fleet
  count counts while a host is selected). The selected computer has none —
  its rows are the evidence. No amber, no wash.
- **Collapsed sidebar:** with a computer paired, one item at the top of the
  rail's workspace list — the computer glyph for this one, the monogram for
  a host — carrying the same badge and opening the same dropdown beside the
  rail. The rail's workspace avatars follow the selection: a paired
  computer's own workspaces (same avatar look, no new-workspace button),
  this computer's again when it is selected.
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
- **Detail:** the name, the on/off switch, the next run, Run now and Edit,
  then the run history (status dot, start, duration, result, Open for a live
  run). Dividers are `--stroke` hairlines.

### Remote

One page, Tailnet first, on the sheet beside the tools dock with 28px sides
(14px under a 640px sheet). Top to bottom:

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
  the A2A port and the full fingerprint (plain mono values; the fingerprint
  wraps anywhere, copy). Connecting another computer by A2A starts from
  Connect a PC…; as a workspace share it starts from Connect a PC… or from
  Share & pair's **Connect another computer**, which mints the pairing link
  and copies it in one click. Connect a PC's invite tab carries **Also let
  it see this PC's workspaces** (off by default, offered only while Share &
  pair answers over HTTPS): ticked, the copy holds the invite and a
  view-only pairing link on a second line, and the other PC's one paste
  connects both.
- **Needs you** — drawn only while something waits, inside an
  `aria-live="polite"` region: ONE block with a 1px `--attention-hairline`
  border over `--selection-subtle` (no wash), rows split by `--stroke`
  hairlines. Rows: a link request (one sentence naming both ends — "DESK
  wants to link its Web/claude with this PC's api / build. Once accepted they
  send each other work and read the results." — its age, that the pane names
  are the other PC's report, the other PC's fingerprint prefix when known,
  same repo or the repo-mismatch warning, the direction; Decline, Accept);
  held remote work (the quoted task, why it is held; Send back, Deliver to
  the pane now — never re-routed on its own; a hold for Moa clears by itself,
  so it is a quiet muted line under the block, not a row and not counted);
  a PC whose certificate changed
  (how many links removing it ends; Remove asking twice, Pair again…, which
  opens Connect a PC on Paste when this PC joined that one and on Invite when
  it joined this one). There is no pane picker on a request: the request
  already names this PC's pane.
- **One list** (one hairline container, 36px rows on shared columns: icon ·
  13px/500 name · 12px muted meta · status · actions), in groups with a muted
  heading and count:
  - **Other PCs** — every A2A-paired PC (either role): its address, link
    counts and "Messages to send N", the status, and a ⋯ menu named after it
    (Link panes…, Link Moa…, What this PC can see…, Remove; portalled so the
    list's clip never cuts it, Escape on its button closes it first). Removing
    a PC says when the other PC was not told, and which side is left after a
    partial failure. Its live links
    sit nested under it (an elbow, `mine ↔ PC/theirs · direction`, or
    "waiting for PC to accept" with Check; Unlink asks twice). Then the
    workspace shares (remote hosts): Open unfolds that host's workspaces in
    place, each with its own Open; Pair again when its credential was
    refused. No path chip: Tailscale is the default, and the address that
    connected is not known to the renderer, so LAN is never guessed.
  - **Phones** — paired web devices: what each is viewing ("Viewing api /
    build", from the daemon's live streams, named here), whether it may
    type, and a direct Revoke asking twice (no ⋯ menu).
  - **Message links** — LanLink peers, messages only.
  - Status words are three: Connected, Disconnected (with "Disconnected 3h
    ago" when known), Waiting. The live dot is neutral, filled only while a
    connection is held. With nothing anywhere, the list gives way to one line
    of explanation and Connect a PC… as the primary.
- **Recent activity:** its own short list (paired, revoked, host added,
  connects seen while the page is open).
- **Connect a PC dialog:** two tabs, and opening it has no side effect. It
  opens on **Invite this PC** only while the A2A listener is already up;
  otherwise on **Paste an invite**, and choosing Invite is what turns the
  listener on (one muted line says so, and the page's line follows at once).
  Invite opens an invite and copies it at once (Copy reads "Copied" for
  1.5 s, is the primary and stays for re-copying), lists the addresses the
  other PC tries in order with "Tailscale" beside the tailnet ones, and
  counts down to expiry with Discard code. When a PC redeems the invite, the
  dialog turns into "<PC> joined. Choose what it can see" with the exposure
  checklist, nothing ticked. Paste reads the clipboard only on its Paste
  button and shows it masked; it routes by shape: `wmux-a2a://` joins over
  A2A (then offers Link a pane now), and every remote-host shape — a pairing
  link, a `wmux web` URL with its token, an address and a code — pairs a
  workspace share. Nothing connects before Connect.
- **Link dialog from this page:** picks the PC when there is one, picks the
  other PC's pane when there is one choice or one on the same repo, and
  offers this PC's pane with the focused one preselected.
- **Orange budget:** one event, two marks at most — the Needs you block's
  hairline and the Remote rail item's number badge (link requests + held
  work + PCs whose certificate changed, the same count from one store
  slice, cleared while the daemon is away). Link request toasts offer Review
  only: the repo a request names is the other PC's claim. The summary line, headings and activity stay neutral. The page's
  one primary is the first Accept, else (empty page) Connect a PC….
- Ids show only as needed and never in full; tokens and invite codes render
  only inside the dialog that made them.

### Git

Opened from the rail (the branch icon under Remote) or by clicking the
branch text in the titlebar. It is about the **repo**, not its branches:
the sheet beside the dock (see Rail and pages) with 28px sides; the header
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
  Remote rows answer the same keys (Shift+F10 opens their menu). Moa's HQ row
  sits above the tree and is not part of it: no row stop, its own buttons take
  Tab. Focus is the app's ring: 2px `--accent`, inside the row, never the
  browser default.
- **Order control:** a sort button in the header, left of the filter, names
  the current order (`Order: Manual`) and opens a three-item menu —
  Attention, Manual, Recent activity — the same setting as Settings ›
  Appearance › Sidebar.
- **Moa's workspace** is app-owned and never in the list, its count, the
  filter, the collapsed rail or Ctrl+N (the numbers skip it). While it is
  the active workspace it shows as its own row above the Workspaces header;
  its Close and Archive stay visible but disabled (`aria-disabled`, still
  focusable) with the reason as tooltip and description — turn Moa off in
  Settings › Moa instead. Every other close path (keyboard, task groups,
  Fleet) refuses it with that reason before any session is touched. When Moa
  is on and its workspace is gone, one persistent toast offers "Recreate Moa
  workspace" and leaves once the state recovers.
- The glance-board rules (attention order, pin to top, fan-out nesting, the
  changed-since-you-looked dot) are in "Sidebar rows" after the Decisions
  Log.

## Tools panel (Workspaces page)

The dock opposite the sidebar is **Moa's**, and exists only while Moa is on.
With Moa off nothing is drawn on that edge, the terminals take the full width
(one refit), and the titlebar has no panel toggle; the panel's saved open
state is kept, so turning Moa back on restores it as it was left. With Moa on,
Moa's titlebar icon is the only toggle, and the first time Moa is ever turned
on the panel opens once on Moa's conversation. Turning Moa on lives in
Settings › Moa and the rail's More menu. With Moa off, task status and fan-out
work are read in Fleet (the sidebar's Tasks line opens Fleet). Git is not here:
it is a page on the rail.

## The one-boundary rule

**Each element draws at most one boundary, and adjacent elements share it.**

- One seam per edge: the sidebar and the body share one 1px `--stroke` seam
  from the titlebar down; the pane border lands on the titlebar, sidebar and
  dock seams instead of beside them; the pane tab strip and the dock header
  end on the same line.
- A fill **or** a hairline, never both: user bubbles are fills without a
  border; composers are a hairline without a fill; Fleet cards and selected
  rows are fills; the sheet is an edge plus a faint shadow.
- No boxes inside boxes: no inner card around a selected workspace's agents,
  no doubled container in the dock, no dividers between toolbar buttons, no
  rule under the chat session header.
- A boundary that only appears on demand stays hidden until then: the
  sidebar's filter field appears from its button and folds away when empty.
- Before adding a line, ask which existing line it duplicates.

## Colour grammar

Colour carries **state only**. Surfaces, controls, selection and hover are
always neutral (the fill ladder).

- **Sidebar and pane marks** — shape first, colour second, one shared helper
  (`AGENT_STATUS_ICON.mark`): running = filled muted dot · needs input =
  `--attention` ring · error = red ✕ (SVG) · complete = muted check ·
  unconfirmed = hollow `--accent` ring · usage-limit hold = muted clock ·
  idle = no mark. Selection is never painted as a status. The collapsed
  rail draws the same marks (`StatusMarkView`), never text glyphs, and names
  each workspace `name, status` for assistive tech.
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
  composer input · 16px page and dialog titles (`--text-display-size`).
  Tabular figures for counts, durations and diff stats.
- **Icons** cap at 16px in chrome (19px on the rail); wmux's own icon set
  (`icons.tsx`), never emoji.
- **Density:** the chrome module is **40px** (titlebar, pane header, dock
  header, resume row, section headers). Sidebar rows are a title over one
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
- **Active tab** (pane tabs, dock tabs): a square-bottomed cell joined to
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
  actions (fan-out, broadcast) stay neutral at rest.
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
  so no PTY is resized when it appears.

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
  the label and `aria-describedby` into its control.
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
  **Agents**: Claude Code · Accounts · Moa · Roles & fan-out ·
  Token usage · Browser · Computer use. Group **Connections**: Remote & phone · LAN. Then
  About. Each tab answers one question; a setting lives on exactly one tab
  and the search catalog (`settings/catalog.ts`) names that tab. Retired tab
  ids resolve through `resolveSettingsTab` (Orchestrator became Moa, the HQ
  main bot: its master switch first, then engine, model and effort, the Moa
  workspace's status with its one-click recovery, a per-workspace mode table
  that leaves out the HQ, the hourly turn cap, bubbles and reduce motion, and
  the orchestrator rows it kept).
- **Theme picker:** visual cards whose thumbnails show the look's face,
  chip shape and selection style; selected by a neutral outline + check.
- **Nav:** 13px icon + label rows; group headings muted sentence case; the
  selected row uses the selection grammar above.
- **Page:** one centred column (720px max); the tab's name as the 16px
  title; sections 28px apart, each a muted sentence-case heading over ONE
  rounded container of rows.
- **Row:** label + one-line muted description on the left, control on the
  right; overflowing copy collapses behind Learn more. Status words are
  Badges. At most one primary per tab.

## Motion

- Minimal-functional. Spinners and the blinking cursor are the only
  perpetual motion; the welcome dialog and onboarding tour clips loop only
  while on screen and never under reduced motion. The one opt-in exception is
  the Attention blink setting's Continuous option (below): the user chose it.
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
  pulse (Off means still), and `prefers-reduced-motion` forces Off. Moa's
  Reduce motion setting is Moa's own and does not apply here.
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
  activity while running, else the pane coordinate) · elapsed time since the
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
  drag-to-reorder pauses. Every row (not a nested task, Moa's HQ or a
  Snoozed/Settled row) shows the number its Ctrl+N jumps to, left of its name,
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
  "Toggle bookmark for this workspace"), on any row but Moa's HQ. A bookmark
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

The Agent conversation uses a rounded, readable composer. Outside Moa's panel,
Mode and New session remain visible; Loop and Schedules are grouped under an
Automation disclosure. Keep approval countdowns visible. Show recovery once while
its notice is present, and restore the recovery shortcut after dismissal.
Briefing headlines may wrap instead of being clipped between a label and a pane
link.

**Moa's panel (2026-10-05)** has no control rows and no Fleet roster. One `⋯`
button at the end of its header ("Moa options") holds Model ›, Mode ›, New
session (confirmed), Wake, View as terminal / chat, Loop…, Schedules…
(the old Automation disclosure) and Moa settings…, each with the disabled state and reason of the
control it replaced. The current mode is a quiet text label next to Main bot
(red text for Danger), never a button. The panel scrolls as **one column**:
Waiting on you, Delegated work (folds to its heading and count), the briefing
(only what Waiting on you does not already say; never two lines that say the
same thing), then the chat. No card has its own height or scroller; long cards
grow, and a decision's quick replies stack full width. Agent recovery lives on
each pane's resume pill, not in Moa's panel. In terminal view the top sections (Waiting on
you, delegated work, briefing) are capped at 30% of the panel with their own
scroll, so the TUI always keeps most of the column. While Moa owns the tab, the
tab is a plain label (Moa · Main bot); the model is chosen only in ⋯ › Model.
Submenus are marked as such (`aria-haspopup`), and Escape steps back one level.
A delegated-work title is one line at rest and wraps once its card is open.

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
  live, in the mantle fill. Moa's task cards, Waiting on you rows and the
  deck ledger's `#` open Fleet on that task with the detail open. For a
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
- **Moa is not on the list.** Moa's HQ workspace is the main bot, not a
  worker: it is left off the rows, their counts and filters, the rail's
  badge, the titlebar vitals and `fleet_triage`. Its decisions and
  permission prompts reach you through Moa's panel (Waiting on you) and its
  titlebar icon's dot.
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
task with the reason. One close or PR runs per task at a time; the row says
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
