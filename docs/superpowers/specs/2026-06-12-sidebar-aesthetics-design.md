# Sidebar Aesthetics — "Refined Terminal" Design

**Date:** 2026-06-12
**Status:** Approved by Mattia (brainstormed via visual companion, direction B of 3)

## Goal

Polish the sidebar's visual design without changing its identity or density. The
current sidebar is functional but flat: text glyphs instead of icons, no depth,
weak active/idle contrast, and no motion. The chosen direction keeps the dense
monospace terminal character and adds polish through real SVG icons, layered
depth, status-aware glowing indicators, and a subtle motion layer.

Rejected alternatives: a Claude-Desktop-style soft/roomy redesign (too large a
departure, loses density) and a glass/blur treatment (GPU cost, fights the
8-theme system).

## Scope

All sidebar surfaces ("the whole family"):

- `src/renderer/components/Sidebar/Sidebar.tsx` — shell, header, footer
- `src/renderer/components/Sidebar/WorkspaceItem.tsx` — rows, drop indicator, context menu
- `src/renderer/components/Sidebar/MiniSidebar.tsx` — collapsed variant
- `src/renderer/components/Sidebar/PresetPicker.tsx` — popover
- `src/renderer/components/Sidebar/CompanyPanel.tsx` — panel
- `src/renderer/components/Settings/SettingsPanel.tsx` — only to import the extracted icon module (no visual change)

Out of scope: layout/width changes, new features, behavior changes, other app
surfaces (terminal area, settings visuals, file tree).

## Design

### 1. Shared icon module

Extract the stroke-based line-icon system that PR #148 established inside
`SettingsPanel.tsx` (shared `Icon` wrapper, 14×14 viewBox, stroke-only paths)
into `src/renderer/components/icons.tsx`. `SettingsPanel.tsx` imports from it
with zero visual change. The sidebar replaces its raw text glyphs (`+`, `‹`,
`›`, `⚙`) with icons from the same system: plus, collapse chevrons (both
directions, sidebar can dock left or right), gear/profile, and small play/pause
status marks. No icon library dependency — matches the maintainer's revealed
preference (hand-rolled SVGs in #148, zero UI deps in package.json).

### 2. Workspace rows (`WorkspaceItem.tsx`)

- **Active row:** replace flat `bg-[var(--bg-surface)]` with a subtle
  top-light treatment — a slight vertical gradient derived from `bgSurface`,
  an inset top highlight (`inset 0 1px 0` at low alpha of `textMain`), and a
  soft drop shadow. All values derived from existing theme tokens via the
  existing derived-token helpers (`shiftLightness`/`mixHex` in
  `tailwindPalette.ts`) so all 8 built-in themes plus custom themes work.
- **Status dots:** status-aware color and glow. Running agent = `success`
  token with a soft glow; waiting for input = `warning` token with glow;
  idle = muted, no glow. A small right-aligned status mark (play/pause icon)
  reinforces the dot.
- **Hover:** background/text transitions ease (~150ms) instead of snapping.
- **Drop indicator:** keep the accent line, slightly thicker, animated
  appearance.
- **Multiview marker:** unchanged semantics (2px accent left border), restyled
  to sit on the new row treatment.

### 3. Shell, header, footer (`Sidebar.tsx`)

- Borders soften from solid `--bg-surface` to ~60% alpha (derived rgba
  variable, following the existing `--bg-surface-rgb` pattern).
- `+` (new workspace) and collapse buttons become icon buttons: fixed-size
  rounded hit area with an eased hover background, replacing bare text glyphs.
- Footer collapse glyph (`sidebarGlyphs.ts`) is replaced by chevron icons;
  the position-aware logic (left/right dock) is preserved.

### 4. Satellites

- **MiniSidebar:** active tile gets the same gradient + inner-highlight
  treatment; workspace tiles carry glowing micro-dots with the same
  status-aware rules; same icon set.
- **Context menu (in WorkspaceItem), PresetPicker, CompanyPanel:** consistent
  corner radius, the softened border, a real drop shadow, and a ~120ms
  fade-in on open.

### 5. Motion layer

Plain CSS only (transitions + keyframes) — no animation library:

- Hover/active state changes ease over ~150ms.
- Running-agent dot glow pulses on a ~2s breathing cycle.
- Waiting-for-input dot pulses slightly faster to draw the eye.
- New workspace rows fade+slide in. (Row-removal fade-out is deferred — exit
  animations are omitted in the implementation plan.)
- All animation is disabled under `prefers-reduced-motion: reduce` via a
  single media-query gate.

### 6. Constraints

- The 10-token theme system is the only color source. New visual values are
  derived from tokens (alpha variants, lightness shifts), never hard-coded.
- Every styled element keeps its `tokenAttrs()` data attributes so the
  inspect-mode design editor's pixel→token reverse mapping keeps working;
  newly styled elements gain appropriate `tokenAttrs()` where they map to a
  token.
- Density unchanged: same row heights (±1px), same 240px width, same 11px
  monospace type.

## Error handling

Purely cosmetic change — no new failure modes. The one risk class is theme
compatibility: a derived value that looks good on Catppuccin Mocha but breaks
on light themes (`sandstone-light`, `paper-light`) or `monochrome`. Mitigation:
derive via the existing lightness-aware helpers (`isLight` exists in
`tailwindPalette.ts`) and visually verify every built-in theme before PR.

## Testing

- Update `sidebarGlyphs.test.ts` where text glyphs become icons (or retire it
  if the module is fully replaced by icons.tsx).
- Unit tests for any new derived-token helper logic.
- Full vitest suite stays green (~2900+ tests); changes are cosmetic so no
  structural test changes expected.
- Manual dogfood pass across all 8 built-in themes + a custom theme, both
  sidebar positions (left/right dock), expanded and collapsed, with
  `prefers-reduced-motion` on and off.

## Delivery

Single upstream PR on a feature branch (per the fork/branch-per-PR workflow).
If review pushes back on size, the satellite surfaces (section 4) split into a
follow-up PR cleanly.
