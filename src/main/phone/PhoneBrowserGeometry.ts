import type { RpcResponse } from '../../shared/rpc';

export interface PhoneBrowserGeometry {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

/** Fixed probe only; expressions and CDP parameters never come from the phone. */
export const PHONE_BROWSER_GEOMETRY = '({width:innerWidth,height:innerHeight,scrollX,scrollY,scale:visualViewport?.scale ?? 1})';

export function phoneBrowserGeometry(response: RpcResponse): PhoneBrowserGeometry {
  if (!response.ok) throw new Error('Browser geometry unavailable');
  const value = (response.result as {value?:unknown} | undefined)?.value;
  if (!value || typeof value !== 'object') throw new Error('Browser geometry unavailable');
  const v = value as Record<string,unknown>;
  if (v.scale !== 1 || !validDimension(v.width) || !validDimension(v.height) ||
      typeof v.scrollX !== 'number' || !Number.isFinite(v.scrollX) ||
      typeof v.scrollY !== 'number' || !Number.isFinite(v.scrollY)) throw new Error('Unsupported browser geometry');
  return {width:v.width,height:v.height,scrollX:v.scrollX,scrollY:v.scrollY};
}

function validDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 32768;
}

/** The viewport no longer matches the geometry the phone sent: nothing was dispatched. */
export class PhoneBrowserViewportChanged extends Error {
  constructor() { super('Browser viewport changed; refresh before input'); }
}

export function phoneBrowserPoint(x: unknown, y: unknown, expected: unknown, current: PhoneBrowserGeometry,
  fields: ReadonlyArray<keyof PhoneBrowserGeometry> = ['width','height','scrollX','scrollY']): {x:number;y:number} {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x >= 1 ||
      typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y >= 1 ||
      !expected || typeof expected !== 'object') throw new Error('Invalid browser point');
  const previous = expected as Record<string,unknown>;
  for (const field of fields) {
    if (previous[field] !== current[field]) throw new PhoneBrowserViewportChanged();
  }
  return {x:x * current.width,y:y * current.height};
}

/**
 * Stream scroll: the viewport size only. The page may have scrolled since the
 * frame the phone saw, and a wheel at the same normalized anchor still means
 * the same thing; the size must match, so the anchor scales by the size sent.
 */
export function phoneBrowserScrollPoint(x: unknown, y: unknown, expected: unknown, current: PhoneBrowserGeometry): {x:number;y:number} {
  return phoneBrowserPoint(x, y, expected, current, ['width','height']);
}

/** A Chrome tab's visual viewport from Page.getLayoutMetrics, in CSS pixels, with its pinch scale and browser zoom. */
export interface PhoneLiveViewport { width: number; height: number; scrollX: number; scrollY: number; scale: number; zoom: number }

/** The geometry a stream frame carried, from that frame's metadata (`scale` only under pinch zoom). */
export interface PhoneStreamGeometry { width: number; height: number; scrollX: number; scrollY: number; scale?: number }

/**
 * How far a stream frame's width (the whole widget) may exceed the live
 * viewport's client width (classic scrollbars take that much), in CSS pixels.
 */
export const STREAM_SCROLLBAR_TOLERANCE = 24;

/**
 * Stream tap or scroll on a streamed Chrome tab, mapped with the geometry the
 * phone sent when it is the latest frame's (`latest`) and the live viewport
 * still agrees with it: the same pinch scale and browser zoom 1, a width and
 * height up to STREAM_SCROLLBAR_TOLERANCE larger than the client area, and
 * for a tap the same scroll offsets. A tap compares width, height, scroll
 * offsets and scale with the sent geometry; a scroll width, height and scale.
 * The point is in the visual viewport's CSS pixels (normalized × size /
 * scale), with the CSS pixels one normalized unit spans for scroll deltas.
 * Otherwise the live viewport is compared as for any input (pinch zoom and
 * browser zoom then refused), and a mismatch throws PhoneBrowserViewportChanged.
 */
export function phoneBrowserStreamPoint(x: unknown, y: unknown, sent: unknown, latest: PhoneStreamGeometry | null, live: PhoneLiveViewport, kind: 'tap' | 'scroll'): { x: number; y: number; spanX: number; spanY: number } {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x >= 1 ||
      typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y >= 1 ||
      !sent || typeof sent !== 'object') throw new Error('Invalid browser point');
  const phone = sent as Record<string, unknown>;
  const sentScale = phone.scale === undefined ? 1 : phone.scale;
  if (latest) {
    const scale = latest.scale ?? 1;
    const fields: Array<keyof PhoneBrowserGeometry> = kind === 'tap' ? ['width', 'height', 'scrollX', 'scrollY'] : ['width', 'height'];
    const same = fields.every((field) => phone[field] === latest[field]) && sentScale === scale;
    const near = (a: number, b: number, by: number) => Math.abs(a - b) <= by;
    const spare = (frame: number, client: number) => frame - client * live.scale;
    const agrees = live.zoom === 1 && near(live.scale, scale, scale * 1e-3) &&
      spare(latest.width, live.width) >= -0.5 && spare(latest.width, live.width) <= STREAM_SCROLLBAR_TOLERANCE &&
      spare(latest.height, live.height) >= -0.5 && spare(latest.height, live.height) <= STREAM_SCROLLBAR_TOLERANCE &&
      (kind === 'scroll' || (near(latest.scrollX, live.scrollX, 1) && near(latest.scrollY, live.scrollY, 1)));
    if (same && agrees) {
      const spanX = latest.width / scale;
      const spanY = latest.height / scale;
      return { x: x * spanX, y: y * spanY, spanX, spanY };
    }
  }
  if (sentScale !== 1 || live.scale !== 1 || live.zoom !== 1) throw new PhoneBrowserViewportChanged();
  const point = phoneBrowserPoint(x, y, sent, live, kind === 'tap' ? ['width', 'height', 'scrollX', 'scrollY'] : ['width', 'height']);
  return { ...point, spanX: live.width, spanY: live.height };
}
