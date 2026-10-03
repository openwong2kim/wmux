// The Windows window controls (titleBarOverlay) sit on the window frame, so
// they take the colour the frame actually paints. Both senders — the titlebar
// sync and the UI-scale sync — read it here, so neither can push a different
// colour over the other.

/** An alpha component (`0.85`, `85%`) as 0–1; undefined when absent, NaN when unreadable. */
function alphaOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  return raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
}

/**
 * `#rrggbb` from a computed CSS colour (`rgb()`, `rgba()`, `color(srgb …)` or
 * hex); null when unreadable or not fully opaque. The native overlay takes an
 * opaque colour only, and a translucent paint (window glass, a colour still
 * fading in) would be copied as a darker or lighter shade than the one on
 * screen — so callers fall back instead.
 */
export function cssColorToHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  // #rrggbbaa / #rgba: only a fully opaque one is a colour to copy.
  if (/^#[0-9a-f]{8}$/i.test(v)) return /ff$/i.test(v) ? v.slice(0, 7).toLowerCase() : null;
  if (/^#[0-9a-f]{4}$/i.test(v)) return /f$/i.test(v) ? cssColorToHex(v.slice(0, 4)) : null;
  const hex = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  const opaque = (raw: string | undefined) => {
    const a = alphaOf(raw);
    return a === undefined || a >= 1;
  };
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(v);
  if (rgb) return opaque(rgb[4]) ? `#${hex(+rgb[1])}${hex(+rgb[2])}${hex(+rgb[3])}` : null;
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i.exec(v);
  if (srgb) return opaque(srgb[4]) ? `#${hex(+srgb[1] * 255)}${hex(+srgb[2] * 255)}${hex(+srgb[3] * 255)}` : null;
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
