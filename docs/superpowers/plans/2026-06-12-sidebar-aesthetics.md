# Sidebar Aesthetics ("Refined Terminal") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the wmux sidebar family (Sidebar, WorkspaceItem, MiniSidebar, PresetPicker, CompanyPanel, context menus) with real SVG icons, layered depth on active rows, status-aware glowing dots, softened borders, and a subtle CSS-only motion layer — without changing density, layout, or behavior.

**Architecture:** Extract the stroke-icon system PR #148 built inside `SettingsPanel.tsx` into a shared `icons.tsx`; convert `sidebarGlyphs.ts` from glyph chars to direction values consumed by a chevron icon; add one new "sidebar polish" section to `globals.css` (keyframes + utility classes, all token-derived via CSS `color-mix`, gated behind `prefers-reduced-motion`); apply the classes across the five sidebar components. The 10-token theme system and `tokenAttrs()` inspect-mode markers stay intact everywhere.

**Tech Stack:** React 19, Tailwind utility classes + CSS variables, plain CSS keyframes (no animation library), vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-sidebar-aesthetics-design.md`

**Branch:** `feat/sidebar-aesthetics` (already created; spec committed).

---

## Context for a zero-context engineer

- **Theme tokens:** 12 editable tokens (`src/renderer/themes.ts:101-112`) become CSS vars (`--bg-base`, `--bg-mantle`, `--bg-surface`, `--bg-overlay`, `--text-main`, `--text-sub`, `--text-subtle`, `--text-muted`, `--accent-blue`, `--accent-green`, `--accent-red`, `--accent-yellow`). Never hard-code a color; derive in CSS with `color-mix(in srgb, var(--x) N%, transparent|var(--y))` — Electron's Chromium supports it. RGB triplet vars exist for only three tokens: `--accent-blue-rgb`, `--bg-surface-rgb`, `--bg-base-rgb` (`themes.ts:313-315`). Do NOT add new `-rgb` vars (they'd need wiring in both `applyCustomCssVars` and every `[data-theme]` block); use `color-mix` instead.
- **Inspect mode:** elements carry `{...tokenAttrs('bgSurface', 'bg')}` markers (`themes.ts:429-431`). Keep every existing marker; when you restyle an element, the marker stays on it.
- **Icon precedent:** `SettingsPanel.tsx:33-82` has the `Icon` wrapper (14×14 viewBox, `stroke="currentColor"`, strokeWidth 1.3, round caps) and 4 icons. This is the house style — all new icons must match it.
- **Animation precedent:** `globals.css:263-395` has keyframes + `prefers-reduced-motion` / `forced-colors` gates. Follow that structure.
- **Test env:** vitest runs in node env (no DOM) for these suites — test pure helpers, not rendered components.
- **Commands:** `npx vitest run <path>` for one file, `npx vitest run` for the suite, `npx tsc --noEmit` for types.

---

### Task 1: Shared icon module

**Files:**
- Create: `src/renderer/components/icons.tsx`
- Modify: `src/renderer/components/Settings/SettingsPanel.tsx:33-82` (delete the moved block, import instead)

- [ ] **Step 1: Create `src/renderer/components/icons.tsx`**

Move `Icon`, `IconX`, `IconCheck`, `IconChevron`, `IconExternalLink` verbatim from `SettingsPanel.tsx:41-82` (change `function` to `export function`), keeping the header comment about the one-stroke-system. Then add the sidebar icons in the same style:

```tsx
/** Plus — new workspace / new item. */
export function IconPlus({ size = 14 }: { size?: number }) {
  return <Icon size={size}><line x1="7" y1="2.5" x2="7" y2="11.5" /><line x1="2.5" y1="7" x2="11.5" y2="7" /></Icon>;
}

/** Directional chevron for the sidebar collapse/expand buttons (issue #151).
 *  `dir` is computed by sidebarGlyphs.ts so the arrow logic stays unit-testable. */
export function IconChevronDir({ dir, size = 12 }: { dir: 'left' | 'right'; size?: number }) {
  return (
    <Icon size={size}>
      {dir === 'left'
        ? <polyline points="8.5,3 4.5,7 8.5,11" />
        : <polyline points="5.5,3 9.5,7 5.5,11" />}
    </Icon>
  );
}

/** Gear — workspace profile / project config badges. */
export function IconGear({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="7" cy="7" r="2" />
      <path d="M7 1.8v1.6M7 10.6v1.6M1.8 7h1.6M10.6 7h1.6M3.3 3.3l1.1 1.1M9.6 9.6l1.1 1.1M3.3 10.7l1.1-1.1M9.6 4.4l1.1-1.1" />
    </Icon>
  );
}

/** Copy — duplicate document outline. */
export function IconCopy({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <path d="M9.5 4.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
    </Icon>
  );
}

/** Play — agent running status mark. */
export function IconPlay({ size = 14 }: { size?: number }) {
  return <Icon size={size}><polygon points="4.5,3 11,7 4.5,11" /></Icon>;
}

/** Pause — agent waiting / awaiting-input status mark. */
export function IconPause({ size = 14 }: { size?: number }) {
  return <Icon size={size}><line x1="5" y1="3.5" x2="5" y2="10.5" /><line x1="9" y1="3.5" x2="9" y2="10.5" /></Icon>;
}
```

- [ ] **Step 2: Point SettingsPanel at the module**

In `SettingsPanel.tsx`, delete lines 33–82 (the icon comment block through `IconExternalLink`) and add to the imports:

```tsx
import { Icon, IconX, IconCheck, IconChevron, IconExternalLink } from '../icons';
```

Note: `SettingsPanel` defines more icons further down (`IconGeneral`, `IconAppearance`, … at lines ~235+) that use raw `<svg>` instead of the `Icon` wrapper — leave those in place; moving them is out of scope.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → no errors. Run: `npx vitest run src/renderer/components/Settings` → all pass (settings suites are glyph-free; this is a pure move).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/icons.tsx src/renderer/components/Settings/SettingsPanel.tsx
git commit -m "refactor(icons): extract shared stroke-icon module from SettingsPanel"
```

---

### Task 2: sidebarGlyphs → directions; icon buttons in Sidebar + MiniSidebar shells

**Files:**
- Modify: `src/renderer/components/Sidebar/sidebarGlyphs.ts`
- Modify: `src/renderer/components/Sidebar/__tests__/sidebarGlyphs.test.ts`
- Modify: `src/renderer/components/Sidebar/Sidebar.tsx:72-99,137-146`
- Modify: `src/renderer/components/Sidebar/MiniSidebar.tsx:29-41,172-179`

- [ ] **Step 1: Rewrite the test (TDD — direction values, not glyphs)**

Replace the four test bodies in `sidebarGlyphs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { collapseDirection, expandDirection } from '../sidebarGlyphs';

describe('sidebar collapse/expand directions (issue #151)', () => {
  it('collapse arrow points toward the docked edge', () => {
    expect(collapseDirection('left')).toBe('left');
    expect(collapseDirection('right')).toBe('right');
  });

  it('expand arrow points inward toward the content area', () => {
    expect(expandDirection('left')).toBe('right');
    expect(expandDirection('right')).toBe('left');
  });

  it('collapse and expand always point in opposite directions', () => {
    for (const pos of ['left', 'right'] as const) {
      expect(collapseDirection(pos)).not.toBe(expandDirection(pos));
    }
  });

  it('flipping the position mirrors both directions', () => {
    expect(collapseDirection('left')).toBe(expandDirection('right'));
    expect(collapseDirection('right')).toBe(expandDirection('left'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/components/Sidebar/__tests__/sidebarGlyphs.test.ts`
Expected: FAIL — `collapseDirection` is not exported.

- [ ] **Step 3: Convert the helper**

In `sidebarGlyphs.ts`, replace `collapseGlyph`/`expandGlyph` with direction-returning versions (keep the file doc comment, update wording from "glyph" to "direction"):

```ts
export type SidebarPosition = 'left' | 'right';
export type ChevronDirection = 'left' | 'right';

/** Direction for the full sidebar's hide button — toward the docked edge. */
export function collapseDirection(position: SidebarPosition): ChevronDirection {
  return position;
}

/** Direction for the mini sidebar's expand button — inward, toward content. */
export function expandDirection(position: SidebarPosition): ChevronDirection {
  return position === 'right' ? 'left' : 'right';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/renderer/components/Sidebar/__tests__/sidebarGlyphs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Update Sidebar.tsx (header `+`, footer chevron, softened borders)**

Imports: replace `import { collapseGlyph } from './sidebarGlyphs';` with:

```tsx
import { collapseDirection } from './sidebarGlyphs';
import { IconPlus, IconChevronDir } from '../icons';
```

Root div (line 72): soften the border by adding an inline borderColor (the Tailwind `border-[var(--bg-surface)]` class stays as fallback for inspect-mode marker semantics — the inline style wins the cascade):

```tsx
<div
  className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`}
  style={{ width: 240, borderColor: 'color-mix(in srgb, var(--bg-surface) 60%, transparent)' }}
  {...tokenAttrs('bgMantle', 'bg')} {...tokenAttrs('bgSurface', 'border')}
>
```

Header border (line 74) — same treatment on the header div:

```tsx
<div className="relative flex items-center justify-between px-4 py-3 border-b border-[var(--bg-surface)]" style={{ borderColor: 'color-mix(in srgb, var(--bg-surface) 60%, transparent)' }}>
```

`+` button (lines 86–96) — becomes a fixed-size rounded icon button with eased hover (all existing props/markers kept):

```tsx
<button
  className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-subtle)] hover:text-[var(--accent-green)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150"
  onClick={togglePicker}
  title={t('sidebar.newWorkspaceTooltip')}
  data-onboarding-target="add-workspace"
  {...tokenAttrs('textSub', 'text')}
  {...tokenAttrs('success', 'accent')}
  data-derived="textSubtle"
>
  <IconPlus size={13} />
</button>
```

Footer (lines 137–146) — soften border the same way, and swap the glyph:

```tsx
<button
  className="flex items-center justify-center w-5 h-5 rounded text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150"
  onClick={() => useStore.getState().toggleSidebar()}
  title={t('sidebar.hideTooltip')}
>
  <IconChevronDir dir={collapseDirection(sidebarPosition)} />
</button>
```

- [ ] **Step 6: Update MiniSidebar.tsx (same three spots)**

Imports: replace `expandGlyph` import with `expandDirection`, add `import { IconPlus, IconChevronDir } from '../icons';`.

Root div (line 29): add the same `borderColor: 'color-mix(in srgb, var(--bg-surface) 60%, transparent)'` to its `style` (merge with `width: 48`).

Header `+` button (lines 31–41): keep all props, replace the text child `+` with `<IconPlus size={14} />` and add `duration-150` to the className; also soften its `border-b` with the same inline borderColor.

Footer expand button (lines 173–179): replace `{expandGlyph(sidebarPosition)}` with `<IconChevronDir dir={expandDirection(sidebarPosition)} />`, add `hover:bg-[rgba(var(--bg-surface-rgb),0.6)] duration-150` to className. Soften the footer container's `border-t` (line 160) with the same inline borderColor.

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit` → clean. Run: `npx vitest run src/renderer/components/Sidebar` → all pass.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/Sidebar/sidebarGlyphs.ts src/renderer/components/Sidebar/__tests__/sidebarGlyphs.test.ts src/renderer/components/Sidebar/Sidebar.tsx src/renderer/components/Sidebar/MiniSidebar.tsx
git commit -m "feat(sidebar): SVG icon buttons + softened borders in shell (refined-terminal pass 1)"
```

---

### Task 3: CSS depth + motion layer

**Files:**
- Modify: `src/renderer/styles/globals.css` (append a new section after the B8 block, ~line 395)

- [ ] **Step 1: Append the sidebar polish section**

```css
/* ─── Sidebar polish: depth + motion (refined-terminal pass) ────────────────
 * Depth on the active row comes from token-derived color-mix values, so all
 * built-in and custom themes work: the gradient/highlight lean toward
 * --text-main, which flips light/dark direction automatically per theme.
 * Motion is subtle (~150ms hovers, 2s breathing glow); everything animated
 * is disabled under prefers-reduced-motion below. */

.sidebar-row {
  transition: background-color 150ms ease, color 150ms ease;
}

.sidebar-row-active {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-surface) 94%, var(--text-main)),
    var(--bg-surface)
  );
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text-main) 7%, transparent),
    0 1px 3px color-mix(in srgb, var(--bg-base) 60%, transparent);
}

/* Status dots. Color comes from the inline background (set per status in
 * the component); these classes add the glow channel. */
.sidebar-dot {
  transition: background-color 150ms ease, box-shadow 150ms ease;
}
@keyframes sidebar-dot-breathe {
  0%, 100% { box-shadow: 0 0 4px 0 var(--sidebar-dot-glow, transparent); }
  50%      { box-shadow: 0 0 7px 1px var(--sidebar-dot-glow, transparent); }
}
.sidebar-dot-running {
  --sidebar-dot-glow: color-mix(in srgb, var(--accent-green) 70%, transparent);
  animation: sidebar-dot-breathe 2s ease-in-out infinite;
}
.sidebar-dot-waiting {
  --sidebar-dot-glow: color-mix(in srgb, var(--accent-yellow) 70%, transparent);
  animation: sidebar-dot-breathe 1.2s ease-in-out infinite;
}
.sidebar-dot-error {
  --sidebar-dot-glow: color-mix(in srgb, var(--accent-red) 70%, transparent);
  box-shadow: 0 0 5px 0 var(--sidebar-dot-glow);
}

/* New workspace rows ease in; popovers/menus fade-scale in. */
@keyframes sidebar-row-enter {
  from { opacity: 0; transform: translateY(-3px); }
  to   { opacity: 1; transform: translateY(0); }
}
.sidebar-row-enter { animation: sidebar-row-enter 150ms ease-out; }

@keyframes sidebar-popover-enter {
  from { opacity: 0; transform: scale(0.98); }
  to   { opacity: 1; transform: scale(1); }
}
.sidebar-popover-enter {
  animation: sidebar-popover-enter 120ms ease-out;
  transform-origin: top;
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-row, .sidebar-dot { transition: none; }
  .sidebar-dot-running, .sidebar-dot-waiting {
    animation: none;
    box-shadow: 0 0 5px 0 var(--sidebar-dot-glow);
  }
  .sidebar-row-enter, .sidebar-popover-enter { animation: none; }
}
```

- [ ] **Step 2: Verify**

Run: `npx vitest run` quick smoke on the styles-adjacent suites is not applicable (pure CSS) — instead run `npm run dev` briefly OR rely on Task 4's visual pass. Check the file parses by running the build's CSS step: `npx vite build --mode development 2>&1 | tail -5` → no CSS syntax errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/styles/globals.css
git commit -m "feat(sidebar): token-derived depth + motion CSS layer (reduced-motion gated)"
```

---

### Task 4: WorkspaceItem rows

**Files:**
- Modify: `src/renderer/components/Sidebar/agentStatusIcon.ts`
- Modify: `src/renderer/components/Sidebar/WorkspaceItem.tsx`

- [ ] **Step 1: Extend the status mapping with glow + mark**

`agentStatusIcon.ts` — add `glowClass` and `mark` fields so WorkspaceItem and MiniSidebar stay in lockstep:

```ts
import type { AgentStatus } from '../../../shared/types';

// Shared mapping from agent status → visual indicator. Used by WorkspaceItem
// (full sidebar) and MiniSidebar so they stay in lockstep when statuses change.
// `dotVar` paints the row's main status dot, `glowClass` adds the animated
// glow channel (globals.css sidebar polish section), `mark` picks the small
// right-aligned play/pause icon.
export const AGENT_STATUS_ICON: Record<AgentStatus, {
  dot: string;
  className: string;
  labelKey: string;
  dotVar: string;
  glowClass: string;
  mark: 'play' | 'pause' | null;
}> = {
  running:        { dot: '●', className: 'text-[var(--accent-blue)]',   labelKey: 'workspace.agentRunning',       dotVar: 'var(--accent-green)',  glowClass: 'sidebar-dot-running', mark: 'play' },
  complete:       { dot: '●', className: 'text-[var(--accent-green)]',  labelKey: 'workspace.agentComplete',      dotVar: 'var(--accent-green)',  glowClass: '',                    mark: null },
  error:          { dot: '●', className: 'text-[var(--accent-red)]',    labelKey: 'workspace.agentError',         dotVar: 'var(--accent-red)',    glowClass: 'sidebar-dot-error',   mark: null },
  waiting:        { dot: '●', className: 'text-[var(--accent-yellow)]', labelKey: 'workspace.agentWaiting',       dotVar: 'var(--accent-yellow)', glowClass: 'sidebar-dot-waiting', mark: 'pause' },
  awaiting_input: { dot: '●', className: 'text-[var(--accent-yellow)]', labelKey: 'workspace.agentAwaitingInput', dotVar: 'var(--accent-yellow)', glowClass: 'sidebar-dot-waiting', mark: 'pause' },
  idle:           { dot: '●', className: 'text-[var(--text-muted)]',    labelKey: 'workspace.agentIdle',          dotVar: 'var(--text-muted)',    glowClass: '',                    mark: null },
};
```

(Existing `dot`/`className` consumers keep working — additive change.)

- [ ] **Step 2: Restyle the row in WorkspaceItem.tsx**

Imports — add:

```tsx
import { IconCopy, IconX, IconGear, IconPlay, IconPause } from '../icons';
```

Row container (lines 372–388): swap the active background class for the CSS depth class and add the transition class:

```tsx
className={`group sidebar-row flex items-start gap-2 px-3 py-1.5 cursor-pointer rounded-md select-none ${
  isActive
    ? 'sidebar-row-active text-[var(--text-main)]'
    : 'text-[var(--text-subtle)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
}`}
```

(`transition-colors` is removed — `.sidebar-row` owns the transition now. The row keeps no `tokenAttrs` today; add `{...tokenAttrs('bgSurface', 'bg')}` to the row div so the active surface stays inspectable, with `data-derived` not needed since the gradient follows bgSurface.)

Status dot (line 390): make it status-aware. Replace:

```tsx
<div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${isActive ? 'bg-[var(--accent-green)]' : 'bg-[var(--text-muted)]'}`} />
```

with:

```tsx
{(() => {
  const st = metadata?.agentStatus && metadata.agentStatus !== 'idle' ? AGENT_STATUS_ICON[metadata.agentStatus] : null;
  return (
    <div
      className={`sidebar-dot w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${st ? st.glowClass : ''}`}
      style={{ backgroundColor: st ? st.dotVar : isActive ? 'var(--accent-green)' : 'var(--text-muted)' }}
    />
  );
})()}
```

- [ ] **Step 3: Right-aligned status mark + icon buttons**

Shortcut hint span (lines 459–461): directly BEFORE it, add the play/pause mark:

```tsx
{(() => {
  const st = metadata?.agentStatus ? AGENT_STATUS_ICON[metadata.agentStatus] : null;
  if (!st?.mark) return null;
  return (
    <span className={`flex-shrink-0 mt-1 ${st.className}`} title={t(st.labelKey)}>
      {st.mark === 'play' ? <IconPlay size={9} /> : <IconPause size={9} />}
    </span>
  );
})()}
```

Copy button (lines 464–470): replace the `⧉` child with `<IconCopy size={11} />` and add `duration-150` to the className. Close button (lines 473–479): replace `✕` with `<IconX size={11} />`, add `duration-150`. Profile gear (lines 411–418): replace the `⚙` child with `<IconGear size={9} />` (keep the span's classes/title). Project trust badge `⛭` (line 441): replace with `<IconGear size={9} />` (the button already carries the color via `style`).

The existing `AgentStatusDot` component (lines 25–37, the tiny dot next to the name) is now redundant with the main dot being status-aware — remove the component and its render site (line 444–446), since the left dot + right mark carry the same information. Also remove the now-unused `AgentStatusDot`-only imports if any.

- [ ] **Step 4: Drop indicator + row entrance**

Both drop indicators (lines 368–370, 484–486): change `h-0.5` to `h-[3px]` and add `sidebar-row-enter` to their className (the keyframe doubles as their appear animation). Outer row wrapper (line 355 `relative mx-2`): add `sidebar-row-enter` so newly created workspaces ease in:

```tsx
<div className="relative mx-2 sidebar-row-enter" ...>
```

(Rows mount once per workspace id — React keys make this animate only on add, which is the spec behavior. Removal fade-out is NOT implemented — it requires exit-animation state machinery; YAGNI, the spec's "fade out" is dropped as agreed scale-to-subtle.)

- [ ] **Step 5: Context menu + close-confirm popovers (in this same file)**

Context menu (line 491): `className="fixed z-[9999] w-max flex flex-col py-1 rounded-lg shadow-xl sidebar-popover-enter"` and in its `style` change the border to `border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)'`. Same two changes on: the working-dirs submenu (line 533, keep its positioning classes), and the close-confirmation popover (line 578). In the working-dirs submenu trigger, replace the `▸` span (line 529) with `<IconChevron />` wrapped in the same muted span; replace the path-copy `⧉` (line 563) with `<IconCopy size={11} />`.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` → clean. Run: `npx vitest run` → full suite green (status-icon mapping is additive; AgentStatusDot had no dedicated test — if a suite references it, update the assertion to the new dot/mark structure rather than resurrecting the component).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/Sidebar/agentStatusIcon.ts src/renderer/components/Sidebar/WorkspaceItem.tsx
git commit -m "feat(sidebar): depth-styled rows, status-aware glowing dots, icon controls"
```

---

### Task 5: MiniSidebar tiles

**Files:**
- Modify: `src/renderer/components/Sidebar/MiniSidebar.tsx`

- [ ] **Step 1: Active tile depth + micro-dot glow**

Tile button (lines 113–130): swap classes the same way as the row:

```tsx
className={`sidebar-row relative w-8 h-8 rounded-md flex items-center justify-center text-[10px] font-bold font-mono select-none ${
  isActive
    ? 'sidebar-row-active text-[var(--text-main)]'
    : 'text-[var(--text-muted)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)] hover:text-[var(--text-sub)]'
} ${isDragging ? 'opacity-40' : 'opacity-100'}`}
```

(`transition-colors` removed; `bg-[var(--bg-surface)]` removed — `.sidebar-row-active` paints it; keep both `tokenAttrs` spreads.)

Agent micro-dot (lines 142–149): replace the glyph span with a real dot that reuses the shared mapping:

```tsx
{agentIcon && (
  <span
    className={`sidebar-dot absolute -bottom-0.5 -right-0.5 w-[7px] h-[7px] rounded-full border border-[var(--bg-mantle)] ${agentIcon.glowClass}`}
    style={{ backgroundColor: agentIcon.dotVar }}
    title={`${ws.metadata?.agentName ? `${ws.metadata.agentName} — ` : ''}${t(agentIcon.labelKey)}`}
  />
)}
```

(The 1px mantle-colored border keeps the dot legible over the tile, mirroring badge practice. The old `animate-pulse` is replaced by the glow classes.)

- [ ] **Step 2: Tile entrance**

Tile wrapper (line 109 `relative w-8`): add `sidebar-row-enter`.

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit && npx vitest run src/renderer/components/Sidebar` → green.

```bash
git add src/renderer/components/Sidebar/MiniSidebar.tsx
git commit -m "feat(sidebar): MiniSidebar tile depth + glowing status micro-dots"
```

---

### Task 6: PresetPicker + CompanyPanel satellites

**Files:**
- Modify: `src/renderer/components/Sidebar/PresetPicker.tsx:50-54`
- Modify: `src/renderer/components/Sidebar/CompanyPanel.tsx` (container surfaces only)

- [ ] **Step 1: PresetPicker popover**

Container (line 53):

```tsx
className="absolute right-2 top-10 z-50 w-52 bg-[var(--bg-overlay)] rounded-lg shadow-xl py-1 text-xs font-mono sidebar-popover-enter"
style={{ border: '1px solid color-mix(in srgb, var(--bg-surface) 70%, transparent)' }}
```

Option buttons (lines 57, 70): add `duration-150` to their `transition-colors` classes.

- [ ] **Step 2: CompanyPanel surfaces**

Three touch points, styling only:
- Line 61 (broadcast card): change `rounded` to `rounded-lg` in the className; keep its inline alert border.
- Line 215 (header bottom border): change the inline style to `borderBottom: '1px solid color-mix(in srgb, var(--bg-surface) 60%, transparent)'`.
- Lines 148, 196, 275 (buttons): append `duration-150` to each `transition-colors`/`transition-opacity` class list.

Do not touch any handler, store call, or layout class in CompanyPanel.

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit && npx vitest run` → full suite green.

```bash
git add src/renderer/components/Sidebar/PresetPicker.tsx src/renderer/components/Sidebar/CompanyPanel.tsx
git commit -m "feat(sidebar): consistent radius/border/fade-in on PresetPicker + CompanyPanel"
```

---

### Task 7: Full verification + theme dogfood

**Files:** none (verification only; fixes land as follow-up commits)

- [ ] **Step 1: Static checks**

Run: `npx tsc --noEmit` → clean. Run: `npx vitest run` → full suite green (~2900+ tests). Run: `npx eslint src/renderer/components/Sidebar src/renderer/components/icons.tsx --max-warnings=0` → clean (the repo CI pins strict ESLint on touched files).

- [ ] **Step 2: Visual dogfood matrix**

Launch with `npm run dev`. Walk every cell:

| Check | How |
|---|---|
| All 8 built-in themes | Settings → Appearance: catppuccin-mocha, monochrome, stars-and-stripes, red-dynasty, nightowl, void, hinomaru (light), taegeuk (light). Active row gradient must be visible-but-subtle on each; on light themes the gradient leans dark (text-main mix) — confirm it doesn't look dirty. |
| Custom theme | Pick Custom, change `bgSurface` + `success` — dots and active row must follow. |
| Both docks | Settings: sidebar left and right — chevrons point per issue #151 (collapse toward edge, expand inward). |
| Collapsed | Toggle MiniSidebar: active tile depth, micro-dot glow, expand chevron. |
| Status states | Run a Claude agent in one workspace (running glow breathes ~2s), let it ask a question (waiting pulse faster), error state if reachable. |
| Motion | Hover rows/buttons (150ms ease), open context menu / PresetPicker (120ms fade-scale), add a workspace (row eases in), drag-reorder (3px indicator, no 🚫 cursor regressions — test drag to external window too, the dataTransfer paths in WorkspaceItem are fragile by history). |
| Reduced motion | Windows Settings → Accessibility → Visual effects → Animation effects OFF: glows go static, no pulsing, hovers snap. |
| Inspect mode | Enter color inspect mode; click sidebar header, active row, `+` button — token resolution must still hit (markers untouched). |

- [ ] **Step 3: Fix anything found, then commit fixes individually**

Each fix is its own commit with a message naming the theme/state it fixes.

---

## Self-review notes

- Spec §1 (icon module) → Task 1; §2 (rows) → Task 4; §3 (shell) → Task 2; §4 (satellites) → Tasks 4 (menus live in WorkspaceItem), 5, 6; §5 (motion) → Task 3 + consumers; §6 (constraints) → woven through + Task 7 inspect/theme checks.
- Deviation from spec, intentional: row *removal* fade-out is dropped (exit animations need unmount-delay machinery — not worth it for "subtle"); spec's `shiftLightness/mixHex` derivation is realized as CSS `color-mix` (same math, no new `-rgb` var plumbing). Both noted inline where they occur.
- Type check: `AGENT_STATUS_ICON` gains fields additively (Task 4 Step 1); `IconChevronDir({dir})` matches `ChevronDirection` from Task 2; class names in Tasks 4–6 all exist in Task 3's CSS.
