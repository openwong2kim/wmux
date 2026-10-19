import { sanitizeRemoteText } from './a2aRemoteDelivery';

/**
 * Browser inspector → agent hand-off. The user picks an element in a browser
 * tab, adds an optional note, and the pair is typed into the input line of the
 * terminal in the same pane (no Enter — the user sends it).
 *
 * Everything about the element comes from the page, which is untrusted: it is
 * validated here, stripped of terminal control sequences, collapsed to ONE
 * line (a newline typed into a shell without bracketed paste runs the line),
 * and length-capped. The line only ever goes to a terminal running an agent
 * (the caller checks): it is a prompt, never a shell command.
 */
export interface InspectedElement {
  title: string;
  url: string;
  selector: string;
  /** The element's opening tag with a few identifying attributes. */
  tag: string;
  /** The start of the element's visible text. */
  text: string;
  /** A few of the element's computed styles (ELEMENT_STYLE_KEYS only). */
  styles: Record<string, string>;
  /** Where the element sits in the page's viewport, in CSS pixels. Used to
   *  capture its screenshot; never part of the hand-off text. */
  rect?: ElementRect;
  /** Absolute path of the element's PNG screenshot, once it is saved. */
  screenshot?: string;
}

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The viewport the rect was measured in. */
  viewportWidth: number;
  viewportHeight: number;
}

const FIELD_MAX = { title: 120, url: 300, selector: 200, tag: 240, text: 200 } as const;
export const HANDOFF_NOTE_MAX = 1000;

/**
 * The computed styles a hand-off carries: enough to say how the element looks
 * and is laid out, few enough to keep the line short. Each value is capped at
 * STYLE_VALUE_MAX, so the styles add at most ~1.5 KB.
 */
export const ELEMENT_STYLE_KEYS = [
  'display', 'position', 'width', 'height', 'margin', 'padding',
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height',
  'border', 'border-radius', 'opacity', 'z-index',
] as const;
const STYLE_VALUE_MAX = 80;
/** File-name prefix of a saved element screenshot (swept with the paste images). */
export const ELEMENT_SHOT_PREFIX = 'wmux-element-';
/** The largest screenshot side, in CSS pixels, so one huge element cannot write a huge file. */
export const ELEMENT_SHOT_MAX_SIDE = 4096;

function oneLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // Counted in code points, so a cut never splits a surrogate pair.
  const chars = Array.from(sanitizeRemoteText(raw).replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** The inspector's result as the page reported it, or null when it is not one. */
export function parseInspectedElement(raw: unknown): InspectedElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const selector = oneLine(r.selector, FIELD_MAX.selector);
  if (!selector) return null;
  const styles: Record<string, string> = {};
  const rawStyles = r.styles && typeof r.styles === 'object' ? (r.styles as Record<string, unknown>) : {};
  // Only the allow-listed keys, read by name: a page cannot add a key of its own.
  for (const key of ELEMENT_STYLE_KEYS) {
    const v = oneLine(rawStyles[key], STYLE_VALUE_MAX);
    if (v) styles[key] = v;
  }
  const rect = parseElementRect(r.rect);
  return {
    title: oneLine(r.title, FIELD_MAX.title),
    url: oneLine(r.url, FIELD_MAX.url),
    selector,
    tag: oneLine(r.tag, FIELD_MAX.tag),
    text: oneLine(r.text, FIELD_MAX.text),
    styles,
    ...(rect ? { rect } : {}),
  };
}

/** A rect the page reported, or null unless every field is a finite number. */
export function parseElementRect(raw: unknown): ElementRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const keys = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'] as const;
  const out = {} as ElementRect;
  for (const k of keys) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * The part of the element to capture: its rect clipped to the viewport (only
 * what is on screen can be captured), in whole CSS pixels, each side capped at
 * ELEMENT_SHOT_MAX_SIDE. Null when nothing of it is visible.
 */
export function elementShotRect(rect: ElementRect): { x: number; y: number; width: number; height: number } | null {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(rect.viewportWidth, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(rect.viewportHeight, Math.ceil(rect.y + rect.height));
  const width = Math.min(ELEMENT_SHOT_MAX_SIDE, right - left);
  const height = Math.min(ELEMENT_SHOT_MAX_SIDE, bottom - top);
  if (!(width >= 1 && height >= 1)) return null;
  return { x: left, y: top, width, height };
}

/**
 * The single line typed into the terminal: the user's note, then the element
 * as a JSON object. Every page-supplied field is a JSON string, so a page
 * cannot close a quote and append words that read as the user's instruction.
 */
export function formatElementHandoff(el: InspectedElement, note: string): string {
  const fields: Record<string, string> = { page: el.title, url: el.url, selector: el.selector, tag: el.tag, text: el.text };
  const present: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
  // Styles and the screenshot path ride in the same JSON object: the agent
  // reads them as data, and a screenshot path is a file it can open.
  if (Object.keys(el.styles ?? {}).length > 0) present.styles = el.styles;
  if (el.screenshot) present.screenshot = el.screenshot;
  const element = JSON.stringify(present);
  const n = oneLine(note, HANDOFF_NOTE_MAX);
  return `${n ? `${n} ` : ''}[browser element] ${element}`;
}
