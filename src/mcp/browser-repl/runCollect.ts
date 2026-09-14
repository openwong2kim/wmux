/**
 * Per-run collectors shared by `browser_repl` and `repl_run`'s `browser`
 * object: the hint block and the image attachments a run reports once, at
 * the end, beside its text result. One implementation so both tools apply the
 * same caps and render the same legend.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MAX_SCREENSHOT_BASE64_BYTES } from '../resultCap';

/** Hint lines shown per run, and how much text one line and the whole block may spend. */
export const HINT_MAX_LINES = 20;
export const HINT_LINE_MAX_BYTES = 512;
export const HINT_CAP_BYTES = 8 * 1024;
/**
 * How many distinct hint lines the dedupe set remembers. A page is free to
 * vary its hint on every call, and the set must not grow with the call count
 * once the block is full anyway.
 */
const HINT_DEDUPE_MAX = 500;

/** Images attached to one run's result, at most. */
export const RUN_IMAGE_MAX = 4;
/**
 * Base64 bytes one run may attach in total. Also the per-image bound: it
 * equals the screenshot tool's default ceiling, which the bridge clamps every
 * scripted screenshot to.
 */
export const RUN_IMAGE_TOTAL_BYTES = MAX_SCREENSHOT_BASE64_BYTES;

/**
 * Cut a hint line to a byte budget on a codepoint boundary. A hint is one line
 * of advice; a page that made it a paragraph gets the start of it, not the run
 * result's whole budget.
 */
function clipToBytes(line: string, capBytes: number): string {
  if (Buffer.byteLength(line, 'utf8') <= capBytes) return line;
  let used = 0;
  let out = '';
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > capBytes - 3) break; // room for the ellipsis
    out += ch;
    used += size;
  }
  return `${out}…`;
}

/**
 * `[replay]`/`[skill]` hint lines, deduped, each prefixed with the number of
 * the call that produced it. The call number is carried into the line: two
 * pages in one run both say "for this page", and merged into one anonymous
 * list they would name flows for a page the reader cannot identify.
 */
export class RunHintCollector {
  readonly lines: string[] = [];
  private readonly seen = new Set<string>();
  private bytes = 0;
  private elidedCount = 0;

  /** Hint lines dropped by the caps; the result says so rather than truncating in silence. */
  get elided(): number {
    return this.elidedCount;
  }

  record(blocks: readonly string[] | undefined, callIndex: number): void {
    for (const block of blocks ?? []) {
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || this.seen.has(trimmed)) continue;
        if (this.seen.size < HINT_DEDUPE_MAX) this.seen.add(trimmed);
        const rendered = `${callIndex}. ${clipToBytes(trimmed, HINT_LINE_MAX_BYTES)}`;
        const cost = Buffer.byteLength(rendered, 'utf8') + 1;
        if (this.lines.length >= HINT_MAX_LINES || this.bytes + cost > HINT_CAP_BYTES) {
          this.elidedCount++;
          continue;
        }
        this.bytes += cost;
        this.lines.push(rendered);
      }
    }
  }
}

/** An image block a browser call returned, as the handler produced it. */
export interface BridgeImage {
  readonly data: string;
  readonly mimeType: string;
}

/** An image attached to the run's result, named in the script's value by `id`. */
export interface RunImage extends BridgeImage {
  readonly id: string;
  /** Number of the browser call that produced it, in the run's call order. */
  readonly callIndex: number;
}

/** What the script's value gains for a call that returned image blocks. */
export interface ImageMark {
  /** Id of the first attached image. */
  readonly image?: string;
  /** Why the first image left out was not attached. */
  readonly note?: string;
  /**
   * Only when the call returned more than one image: one entry per block, in
   * order — its id when attached, otherwise the reason it was left out.
   */
  readonly images?: readonly string[];
}

/** The refusal a browser call gets when it does not belong to the run in flight. */
export function lateCallRefusal(name: string, tool: string): string {
  return (
    `browser.${name}: refused — made after its ${tool} run finished (a timer or un-awaited ` +
    'promise from an earlier run). Await every browser call inside the run that makes it.'
  );
}

export const IMAGE_CAP_NOTE = 'image not attached (cap)';
const IMAGE_LATE_NOTE = 'image not attached (run finished)';

/**
 * Attaches a run's images under the caps, first come first served. An image
 * that does not fit is counted and the script's value says so — never an id
 * that names nothing in the result.
 */
export class RunImageCollector {
  readonly images: RunImage[] = [];
  private bytes = 0;
  private elidedCount = 0;
  private closed = false;

  get elided(): number {
    return this.elidedCount;
  }

  /** The run reported back; later images have no result to ride in. */
  close(): void {
    this.closed = true;
  }

  offer(blocks: readonly BridgeImage[] | undefined, callIndex: number): ImageMark {
    if (!blocks || blocks.length === 0) return {};
    let first: string | undefined;
    let note: string | undefined;
    const perBlock: string[] = [];
    for (const block of blocks) {
      if (this.closed) {
        note ??= IMAGE_LATE_NOTE;
        perBlock.push(IMAGE_LATE_NOTE);
        continue;
      }
      const size = block.data.length;
      if (
        this.images.length >= RUN_IMAGE_MAX ||
        size > RUN_IMAGE_TOTAL_BYTES ||
        this.bytes + size > RUN_IMAGE_TOTAL_BYTES
      ) {
        this.elidedCount++;
        note ??= IMAGE_CAP_NOTE;
        perBlock.push(IMAGE_CAP_NOTE);
        continue;
      }
      const id = `img-${this.images.length + 1}`;
      this.bytes += size;
      this.images.push({ id, callIndex, data: block.data, mimeType: block.mimeType });
      first ??= id;
      perBlock.push(id);
    }
    return {
      ...(first && { image: first }),
      ...(note && { note }),
      ...(blocks.length > 1 && { images: perBlock }),
    };
  }
}

/** The `--- images ---` block; empty when the run attached and dropped nothing. */
export function renderImageLegend(images: readonly RunImage[], elided: number): string[] {
  if (images.length === 0 && elided === 0) return [];
  const lines = ['', '--- images ---'];
  for (const image of images) {
    const kib = Math.ceil((image.data.length * 3) / 4 / 1024);
    lines.push(`${image.id}: call ${image.callIndex} (${image.mimeType}, ${kib} KiB)`);
  }
  if (elided > 0) {
    lines.push(
      `(${elided} image(s) not attached: at most ${RUN_IMAGE_MAX} images and ` +
        `${RUN_IMAGE_TOTAL_BYTES / (1024 * 1024)} MiB per run)`,
    );
  }
  return lines;
}

/** A text result followed by the run's images, in id order. */
export function textWithImages(body: string, images: readonly RunImage[], isError: boolean): CallToolResult {
  return {
    content: [
      { type: 'text' as const, text: body },
      ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
    ],
    isError: isError || undefined,
  };
}
