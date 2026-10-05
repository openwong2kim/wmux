// Arrow-key movement between sidebar rows (the rail's pattern, MiniSidebar):
// ↑ ↓ step through the rows in screen order without wrapping, Home and End
// jump to the ends. Pure, so the key model is testable without a DOM.

/** The row index a key moves to, or null when the key does not move focus. */
export function nextRowIndex(key: string, at: number, count: number): number | null {
  if (count === 0 || at < 0) return null;
  switch (key) {
    case 'ArrowDown': return at < count - 1 ? at + 1 : null;
    case 'ArrowUp': return at > 0 ? at - 1 : null;
    case 'Home': return at === 0 ? null : 0;
    case 'End': return at === count - 1 ? null : count - 1;
    default: return null;
  }
}
