import qrcode from 'qrcode-generator';

/**
 * QR encoding, reduced to a single SVG path string.
 *
 * Split out of WebToggle for two reasons. It is pure, so it is testable
 * without a DOM — the popover's whole test strategy is renderToStaticMarkup
 * against controlled props, and a component that encoded its own QR would have
 * to grow a hook and break that. And the parent memoises the result: the
 * popover re-renders every 10s from the status poll and again on every copy
 * click, while the payload changes only when a human mints a code. Re-running
 * Reed-Solomon and eight mask evaluations for an identical string is waste
 * nobody would notice and nobody should pay.
 *
 * Why a path and not a <rect> per module: a 33x33 QR is ~1000 dark modules,
 * and a thousand elements in a 288px popover is a real layout cost. One path
 * with a thousand `M x y h1 v1 h-1 z` subpaths renders as one node.
 */

/** Error-correction level. `M` (~15%) is the usual choice for screen display —
 * `L` saves modules but a popover QR is scanned from 20cm, not across a room. */
const EC_LEVEL = 'M' as const;

export interface QrPath {
  /** SVG path data covering every dark module. */
  d: string;
  /** Module count per side, which is also the viewBox extent. */
  size: number;
}

/**
 * Encode `text` and return the path plus its module count.
 *
 * Returns null for empty input, and for anything the encoder refuses — a
 * payload too long for the largest version, most plausibly. A caller that gets
 * null must render no QR at all rather than an empty box: a blank square where
 * a code should be reads as "scan failed", which is worse than the plaintext
 * fallback that is already on screen.
 */
export function buildQrPath(text: string): QrPath | null {
  if (!text) return null;
  try {
    // Type 0 = "pick the smallest version that fits".
    const qr = qrcode(0, EC_LEVEL);
    qr.addData(text);
    qr.make();

    const size = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return d ? { d, size } : null;
  } catch {
    // The encoder throws on overflow rather than returning a code. Nothing here
    // is worth surfacing to the operator: the pair URL and the code are both
    // still on screen, so the fallback path is already what they see.
    return null;
  }
}
