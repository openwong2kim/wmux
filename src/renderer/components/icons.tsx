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

export function IconCheck({ size = 14 }: { size?: number }) {
  return <Icon size={size}><polyline points="2.5,7.4 5.8,10.5 11.5,3.5" /></Icon>;
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
