// The Windows window controls (titleBarOverlay) sit on the window frame, so
// they take the colour the frame actually paints. Both senders — the titlebar
// sync and the UI-scale sync — read it here, so neither can push a different
// colour over the other.

/** `#rrggbb` from a computed CSS colour (`rgb()`, `rgba()`, `color(srgb …)` or hex); null when unreadable. */
export function cssColorToHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  const hex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  // A fully transparent paint is no colour to copy (e.g. before styles load).
  if (/^rgba\(.*,\s*0\s*\)$/i.test(v) || /\/\s*0\s*\)$/.test(v)) return null;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (rgb) return `#${hex(+rgb[1])}${hex(+rgb[2])}${hex(+rgb[3])}`;
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(v);
  if (srgb) return `#${hex(+srgb[1] * 255)}${hex(+srgb[2] * 255)}${hex(+srgb[3] * 255)}`;
  return null;
}

/** The overlay's colour pair: the painted frame and the secondary text, both `#rrggbb`. */
export function overlayColors(doc: Document = document): { color: string; symbolColor: string } | null {
  const root = doc.documentElement;
  const frame = doc.querySelector('.wmux-app-root');
  const rootStyle = getComputedStyle(root);
  const color = (frame ? cssColorToHex(getComputedStyle(frame).backgroundColor) : null)
    ?? cssColorToHex(rootStyle.getPropertyValue('--bg-base'));
  const symbolColor = cssColorToHex(rootStyle.getPropertyValue('--text-sub'));
  return color && symbolColor ? { color, symbolColor } : null;
}
