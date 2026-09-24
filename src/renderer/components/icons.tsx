// ─── Icon components ──────────────────────────────────────────────────────────
//
// One stroke-based line-icon system. All icons share a 14×14 viewBox,
// `stroke="currentColor"` (so they inherit the caller's text color, including
// active/inactive tab coloring), strokeWidth 1.3, and round caps/joins. This
// replaces the Unicode glyphs (⚙◑◎⌨◈◇ℹ✓✗▾▸↺✕⎋) that rendered at mismatched
// sizes and weights across platforms (issue #145).

/** Shared svg wrapper — keeps every icon on the same grid + style. */
export function Icon({ children, size = 14 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconX({ size = 14 }: { size?: number }) {
  return <Icon size={size}><line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" /></Icon>;
}

/** Two overlapping figures — channel member roster count. Replaces the 👥 glyph
 *  (the Unicode members emoji that issue #145 set out to eliminate). */
export function IconUsers({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="5.1" cy="4.5" r="2.2" />
      <path d="M1.6 11.4 a3.6 3.6 0 0 1 7 0" />
      <path d="M9.2 2.6 a2.2 2.2 0 0 1 0 4" />
      <path d="M10 7.4 a3.6 3.6 0 0 1 2.4 4" />
    </Icon>
  );
}

export function IconCheck({ size = 14 }: { size?: number }) {
  return <Icon size={size}><polyline points="2.5,7.4 5.8,10.5 11.5,3.5" /></Icon>;
}

/** Triangle with an exclamation mark — a warning that needs a decision. */
export function IconWarning({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M7 1.8 L12.6 11.8 H1.4 Z" />
      <line x1="7" y1="5.4" x2="7" y2="8.2" />
      <line x1="7" y1="10" x2="7" y2="10.1" />
    </Icon>
  );
}

/** Four equal quadrants — layout templates / snap-to-layout verbs. */
export function IconGrid({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="1" y="1" width="5" height="5" rx="0.8" />
      <rect x="8" y="1" width="5" height="5" rx="0.8" />
      <rect x="1" y="8" width="5" height="5" rx="0.8" />
      <rect x="8" y="8" width="5" height="5" rx="0.8" />
    </Icon>
  );
}

/** A friendly little robot — the agent panel toggle. Antenna + rounded head +
 *  two dot eyes + a small smile; ears nudge it toward "cute" over "clinical". */
export function IconRobot({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      {/* antenna */}
      <line x1="7" y1="1.4" x2="7" y2="3" />
      <circle cx="7" cy="1.1" r="0.75" fill="currentColor" stroke="none" />
      {/* head */}
      <rect x="2.4" y="3" width="9.2" height="8" rx="2.4" />
      {/* ears */}
      <line x1="2.4" y1="6.4" x2="1.3" y2="6.4" />
      <line x1="11.6" y1="6.4" x2="12.7" y2="6.4" />
      {/* eyes */}
      <circle cx="5.3" cy="6.3" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="8.7" cy="6.3" r="0.85" fill="currentColor" stroke="none" />
      {/* smile */}
      <path d="M5.4 8.6 Q7 9.9 8.6 8.6" />
    </Icon>
  );
}

/** Archive — a lidded box with a handle. Channel archive (read-only, one-way). */
export function IconArchive({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="2" y="2.4" width="10" height="2.6" rx="0.6" />
      <path d="M3 5 V11 a0.6 0.6 0 0 0 0.6 0.6 H10.4 a0.6 0.6 0 0 0 0.6 -0.6 V5" />
      <line x1="5.6" y1="7.6" x2="8.4" y2="7.6" />
    </Icon>
  );
}

/** Eye — "this is visible / bring it back into view". Paired with IconEyeOff.
 *
 *  The stash vocabulary (#977): eye-off removes a pane from the layout, eye
 *  brings it back. Deliberately NOT IconArchive, which this file already spends
 *  on channel archive — a one-way DEACTIVATION, the opposite of a stashed pane's
 *  "still running". Reusing it would have made the two states look alike in a
 *  sidebar that shows both. */
export function IconEye({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M1 7 C2.8 4.2 4.7 3 7 3 C9.3 3 11.2 4.2 13 7 C11.2 9.8 9.3 11 7 11 C4.7 11 2.8 9.8 1 7 Z" />
      <circle cx="7" cy="7" r="1.9" />
    </Icon>
  );
}

/** Eye with a slash — "take this out of view". See IconEye for the pairing.
 *
 *  The slash runs corner to corner so the two icons are distinguishable at 9px
 *  in the sidebar roster, where the difference between them carries the whole
 *  hidden/visible signal. */
export function IconEyeOff({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M2.2 4.6 C1.7 5.3 1.3 6.1 1 7 C2.8 9.8 4.7 11 7 11 C7.9 11 8.7 10.8 9.5 10.4" />
      <path d="M11.4 9 C12 8.4 12.5 7.8 13 7 C11.2 4.2 9.3 3 7 3 C6.5 3 6.1 3.05 5.7 3.15" />
      <path d="M5.7 5.7 a1.9 1.9 0 0 0 2.6 2.6" />
      <line x1="1.9" y1="1.9" x2="12.1" y2="12.1" />
    </Icon>
  );
}

export function IconPencil({ size = 14 }: { size?: number }) {
  // Nib + shaft + baseline, drawn on the same 14px stroked grid as the rest of
  // the set — a filled glyph (✎) next to these reads as a different weight.
  return (
    <Icon size={size}>
      <path d="M9.4 2.6 a1.4 1.4 0 0 1 2 2 L5 11 L2.5 11.5 L3 9 Z" />
      <line x1="8.6" y1="3.4" x2="10.6" y2="5.4" />
    </Icon>
  );
}

export function IconChevron({ size = 14 }: { size?: number }) {
  // Points right; rotate 90° via transform for an expanded/down state.
  return <Icon size={size}><polyline points="5.5,3 9.5,7 5.5,11" /></Icon>;
}

export function IconExternalLink({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M6 3H3.3v7.7h7.7V8" />
      <polyline points="8.2,2.5 11.5,2.5 11.5,5.8" />
      <line x1="11.5" y1="2.5" x2="6.6" y2="7.4" />
    </Icon>
  );
}

/** Padlock — a private channel the operator is not (yet) a member of
 *  (operator-join §3 discovery section). */
export function IconLock({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="3" y="6.2" width="8" height="5.3" rx="1" />
      <path d="M4.6 6.2 V4.6 a2.4 2.4 0 0 1 4.8 0 V6.2" />
    </Icon>
  );
}

/** Plus — new workspace / new item. */
export function IconPlus({ size = 14 }: { size?: number }) {
  return <Icon size={size}><line x1="7" y1="2.5" x2="7" y2="11.5" /><line x1="2.5" y1="7" x2="11.5" y2="7" /></Icon>;
}

/** Refresh — circular arrow for a manual re-sync (channel catalog reload). */
export function IconRefresh({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M11 5.5 A4.2 4.2 0 1 0 11.6 8.7" />
      <polyline points="8.6,5.2 11.4,5.6 11.7,2.9" />
    </Icon>
  );
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

/** Gear — settings entry point and workspace profile / project config badges.
 *  An eight-tooth cog outline around a hub. The previous glyph (hub + eight
 *  detached rays) read as a sun / brightness control, not as settings.
 *  At 10px and below (the 9px workspace badges) eight teeth and a hub blur
 *  into a smudge, so small sizes draw a ring with six short teeth on a
 *  heavier stroke instead. */
export function IconGear({ size = 14 }: { size?: number }) {
  if (size <= 10) {
    return (
      <Icon size={size}>
        <g strokeWidth="1.8">
          <circle cx="7" cy="7" r="3.2" />
          <path d="M7 1.4v2.4M7 10.2v2.4M2.15 4.2l2.08 1.2M9.77 8.6l2.08 1.2M2.15 9.8l2.08-1.2M9.77 5.4l2.08-1.2" />
        </g>
      </Icon>
    );
  }
  return (
    <Icon size={size}>
      <path d="M5.86 2.75 L6.11 1.37 A5.7 5.7 0 0 1 7.89 1.37 L8.14 2.75 A4.4 4.4 0 0 1 9.2 3.19 L10.35 2.39 A5.7 5.7 0 0 1 11.61 3.65 L10.81 4.8 A4.4 4.4 0 0 1 11.25 5.86 L12.63 6.11 A5.7 5.7 0 0 1 12.63 7.89 L11.25 8.14 A4.4 4.4 0 0 1 10.81 9.2 L11.61 10.35 A5.7 5.7 0 0 1 10.35 11.61 L9.2 10.81 A4.4 4.4 0 0 1 8.14 11.25 L7.89 12.63 A5.7 5.7 0 0 1 6.11 12.63 L5.86 11.25 A4.4 4.4 0 0 1 4.8 10.81 L3.65 11.61 A5.7 5.7 0 0 1 2.39 10.35 L3.19 9.2 A4.4 4.4 0 0 1 2.75 8.14 L1.37 7.89 A5.7 5.7 0 0 1 1.37 6.11 L2.75 5.86 A4.4 4.4 0 0 1 3.19 4.8 L2.39 3.65 A5.7 5.7 0 0 1 3.65 2.39 L4.8 3.19 A4.4 4.4 0 0 1 5.86 2.75 Z" />
      <circle cx="7" cy="7" r="1.9" />
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

/** Clock — schedule a future prompt for the active agent session. */
export function IconClock({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="7" cy="7" r="5" />
      <path d="M7 4.1 V7.2 L9.2 8.5" />
    </Icon>
  );
}

/** Paperclip — attach file. Replaces the ＋ glyph on the toolbar attach button. */
export function IconPaperclip({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M10.7 6.2 L6 10.9 a2.4 2.4 0 0 1 -3.4 -3.4 L7.6 2.5 a1.6 1.6 0 0 1 2.3 2.3 L5.2 9.6 a0.8 0.8 0 0 1 -1.2 -1.2 L8.3 4" />
    </Icon>
  );
}

/** Folder — file explorer. Replaces the 📁 emoji. */
export function IconFolder({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M2 3.6 h3.1 l1.1 1.4 H12 v6 a0.6 0.6 0 0 1 -0.6 0.6 H2.6 a0.6 0.6 0 0 1 -0.6 -0.6 Z" />
    </Icon>
  );
}

/** Star — snippets. Replaces the ★ glyph. */
export function IconStar({ size = 14 }: { size?: number }) {
  return <Icon size={size}><polygon points="7,1.8 8.6,5.2 12.2,5.6 9.5,8.1 10.3,11.7 7,9.8 3.7,11.7 4.5,8.1 1.8,5.6 5.4,5.2" /></Icon>;
}

/** Bell — last-notification line. Replaces the 🔔 emoji (monochrome chrome). */
export function IconBell({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M7 1.6a3.4 3.4 0 0 0-3.4 3.4c0 3.2-1.1 4.2-1.1 4.2h9c0 0-1.1-1-1.1-4.2A3.4 3.4 0 0 0 7 1.6Z" />
      <path d="M5.9 11.4a1.2 1.2 0 0 0 2.2 0" />
    </Icon>
  );
}

/** Keyboard — rich input. Replaces the ⌨ emoji (same class as issue #145). */
export function IconKeyboard({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="1.5" y="3.8" width="11" height="6.4" rx="1" />
      <line x1="3.4" y1="6" x2="4" y2="6" />
      <line x1="6.2" y1="6" x2="6.8" y2="6" />
      <line x1="9" y1="6" x2="9.6" y2="6" />
      <line x1="4.6" y1="8.4" x2="9.4" y2="8.4" />
    </Icon>
  );
}

/** Terminal — a shell window with a prompt. New-terminal pane header action. */
export function IconTerminal({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1" />
      <polyline points="4,6 5.7,7.6 4,9.2" />
      <line x1="7.2" y1="9.2" x2="9.6" y2="9.2" />
    </Icon>
  );
}

/** Split right — a pane divided by a vertical seam into two side-by-side
 *  columns. Matches wmux `splitPane(_, 'horizontal')` (the new pane opens to
 *  the right; PaneContainer maps 'horizontal' → a row of columns). */
export function IconSplitRight({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1" />
      <line x1="7" y1="2.6" x2="7" y2="11.4" />
    </Icon>
  );
}

/** Split down — a pane divided by a horizontal seam into two stacked rows.
 *  Matches wmux `splitPane(_, 'vertical')` (the new pane opens below;
 *  PaneContainer maps 'vertical' → a column of rows). */
export function IconSplitDown({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1" />
      <line x1="1.8" y1="7" x2="12.2" y2="7" />
    </Icon>
  );
}

/** Globe — a browser surface. New-browser pane header action. */
export function IconBrowser({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="7" cy="7" r="5.2" />
      <ellipse cx="7" cy="7" rx="2.1" ry="5.2" />
      <line x1="1.8" y1="7" x2="12.2" y2="7" />
    </Icon>
  );
}

/** Git branch — two nodes on a trunk with a branch line. Opens the Git surface
 *  (worktrees + PRs) in the center pane. */
export function IconGitBranch({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="4" cy="3.4" r="1.5" />
      <circle cx="4" cy="10.6" r="1.5" />
      <circle cx="10" cy="5.2" r="1.5" />
      <line x1="4" y1="4.9" x2="4" y2="9.1" />
      <path d="M10 6.7 V7.2 a2.4 2.4 0 0 1 -2.4 2.4 H4" />
    </Icon>
  );
}

/** Hash — the channel glyph. Opens the deck on the Channels tab. */
export function IconHash({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <line x1="5.2" y1="2" x2="4.2" y2="12" />
      <line x1="9.4" y1="2" x2="8.4" y2="12" />
      <line x1="2.4" y1="5.2" x2="11.4" y2="5.2" />
      <line x1="2" y1="8.8" x2="11" y2="8.8" />
    </Icon>
  );
}

/** Review — a checklist / diff roster. Opens the Review surface (cross-workspace
 *  diff roster) in the center pane. */
export function IconReview({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <rect x="2.4" y="2" width="9.2" height="10" rx="1" />
      <polyline points="4.4,5 5.3,5.9 7,4.2" />
      <line x1="8.4" y1="5" x2="10" y2="5" />
      <polyline points="4.4,9 5.3,9.9 7,8.2" />
      <line x1="8.4" y1="9" x2="10" y2="9" />
    </Icon>
  );
}

/** Sparkles — start a new (AI) conversation. Replaces the ⊕ glyph. */
export function IconSparkles({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M6 2 L6.9 4.6 L9.5 5.5 L6.9 6.4 L6 9 L5.1 6.4 L2.5 5.5 L5.1 4.6 Z" />
      <path d="M10 8 L10.5 9.5 L12 10 L10.5 10.5 L10 12 L9.5 10.5 L8 10 L9.5 9.5 Z" />
    </Icon>
  );
}

/** Remote access across a desktop and a phone. */
export function IconRemoteDevices({ size = 14 }: { size?: number }) {
  return <Icon size={size}>
    <path d="M7.5 9H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v1M5 9v3m-2 0h4" />
    <rect x="9" y="5.5" width="4" height="7" rx=".8" />
    <path d="M10.7 10.8h.6" />
  </Icon>;
}

/** Worktree — a branch that lives in its own checkout: the branch glyph's
 *  side node boxed. Replaces the ⊕ text mark on the sidebar's git line. */
export function IconWorktree({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="4" cy="3.4" r="1.5" />
      <circle cx="4" cy="10.6" r="1.5" />
      <line x1="4" y1="4.9" x2="4" y2="9.1" />
      <rect x="8.2" y="3.4" width="3.8" height="3.8" rx="0.8" />
      <path d="M8.2 5.3 H6.8 a2 2 0 0 0 -2 2 V9" />
    </Icon>
  );
}

/** Fan-out — one node splitting into three. Marks a workspace a fan-out
 *  created (sidebar task rows, provenance). */
export function IconFanOut({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="2.8" cy="7" r="1.3" />
      <path d="M4.1 7 H6 L10.6 3" />
      <line x1="6" y1="7" x2="10.6" y2="7" />
      <path d="M6 7 L10.6 11" />
    </Icon>
  );
}

/** Corner up-left — "go up to the parent". The task workspace's link back to
 *  the workspace that fanned it out. */
export function IconCornerUpLeft({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <polyline points="5.4,2.8 2.6,5.6 5.4,8.4" />
      <path d="M2.6 5.6 H8.4 a2.8 2.8 0 0 1 2.8 2.8 V11.4" />
    </Icon>
  );
}

/** Vertical ellipsis — an overflow menu trigger. */
export function IconMoreVertical({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <line x1="7" y1="3" x2="7" y2="3.1" />
      <line x1="7" y1="7" x2="7" y2="7.1" />
      <line x1="7" y1="11" x2="7" y2="11.1" />
    </Icon>
  );
}

/** Pin — a row that keeps its place in the sidebar's Attention order. */
export function IconPin({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M5 2.2 H9 L8.4 5.6 L10.4 7.6 H3.6 L5.6 5.6 Z" />
      <line x1="7" y1="7.6" x2="7" y2="11.8" />
    </Icon>
  );
}
