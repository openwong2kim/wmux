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

/** Sparkles — start a new (AI) conversation. Replaces the ⊕ glyph. */
export function IconSparkles({ size = 14 }: { size?: number }) {
  return (
    <Icon size={size}>
      <path d="M6 2 L6.9 4.6 L9.5 5.5 L6.9 6.4 L6 9 L5.1 6.4 L2.5 5.5 L5.1 4.6 Z" />
      <path d="M10 8 L10.5 9.5 L12 10 L10.5 10.5 L10 12 L9.5 10.5 L8 10 L9.5 9.5 Z" />
    </Icon>
  );
}
