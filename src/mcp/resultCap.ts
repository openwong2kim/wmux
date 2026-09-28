/**
 * Global result-size guard for MCP tool results.
 *
 * Several tools return data whose size the CALLER does not control (a console
 * ring, a network log, a full scrollback, a JSON.stringify of whatever a page
 * produced). One such call can drop several megabytes into the caller's
 * context and evict everything else. Every TEXT result therefore passes
 * through a head+tail cap at the dispatch layer — one implementation, shared
 * by the catalog lane (registerWmuxTools) and the legacy server.tool() lane —
 * so a tool that forgets its own bound is still bounded.
 *
 * Image/binary content is exempt from text truncation (the bytes are not
 * readable text and screenshots have their own explicit ceiling), and a tool
 * may declare a per-call `maxBytes` input so a caller that legitimately needs
 * more can raise the cap up to a hard maximum.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { truncateText } from './repl/truncate';

/** Default cap for a text tool result: 64 KiB. */
export const DEFAULT_RESULT_CAP_BYTES = 64 * 1024;
/** Hard maximum a caller can raise the text cap to with `maxBytes`: 512 KiB. */
export const MAX_RESULT_CAP_BYTES = 512 * 1024;
/**
 * Screenshot images ride as base64 outside the text cap; this ceiling bounds
 * the single image payload instead. Chosen to clear every ordinary viewport
 * capture (retina included) while keeping a runaway fullPage capture out of
 * the caller's context.
 */
export const MAX_SCREENSHOT_BASE64_BYTES = 2 * 1024 * 1024;
/**
 * Hard bound a caller can raise the screenshot ceiling to with `maxBytes`.
 * Above the default ceiling the tool DOWNSCALES rather than refusing, so this
 * exists for the caller who genuinely wants the original pixels — a visual
 * diff, an OCR pass — and accepts the context cost knowingly.
 */
export const MAX_SCREENSHOT_MAXBYTES = 8 * 1024 * 1024;

/**
 * Resolve the screenshot base64 ceiling from a caller's `maxBytes`. Clamped,
 * never rejected: absent or unusable falls back to the 2 MiB default, and an
 * over-bound ask is served at 8 MiB.
 */
export function clampScreenshotCeilingBytes(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return MAX_SCREENSHOT_BASE64_BYTES;
  }
  return Math.min(Math.floor(requested), MAX_SCREENSHOT_MAXBYTES);
}

/**
 * Resolve the per-call cap from a tool input. Only inputs whose schema
 * declares `maxBytes` can carry one (a stripping schema drops unknown keys),
 * so this never widens a tool that did not opt in. Values are clamped, never
 * rejected — a caller asking for more than the hard maximum gets the maximum,
 * and anything non-numeric or non-positive gets the default.
 */
export function clampResultCapBytes(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_RESULT_CAP_BYTES;
  }
  return Math.min(Math.floor(requested), MAX_RESULT_CAP_BYTES);
}

/** Options shared by the cap entry points. */
export interface ResultCapOptions {
  /**
   * Whether the tool's input schema declares `maxBytes`. The truncation
   * marker names the raise path only when passing maxBytes would actually
   * work — on a strictInput tool without the field the call would error, and
   * on a stripping tool the key would be silently dropped. Defaults to false:
   * both registration lanes read the real schema, so advertising is opt-in
   * and a caller is never told to pass a parameter the tool does not have.
   */
  readonly declaresMaxBytes?: boolean;
}

/**
 * Marker naming the raise path, so an agent that hits the cap learns in the
 * same result how to ask for more — and where the ceiling is. `shownBytes`
 * is always the TRUE count of retained original bytes; `totalBytes` is
 * always the original document size, never the size of a previous pass.
 */
function toolResultMarker(
  totalBytes: number,
  declaresMaxBytes: boolean,
): (shownBytes: number) => string {
  const raise = declaresMaxBytes ? '; pass maxBytes to raise, up to 512 KiB' : '';
  return (shownBytes) => `\n[truncated: ${shownBytes} of ${totalBytes} bytes shown${raise}]\n`;
}

/**
 * Cap a result that is a single top-level JSON ARRAY by dropping trailing
 * items, so the output is still `JSON.parse`-able.
 *
 * A head+tail cut lands in the middle of a value and leaves an unparseable
 * document — the caller of browser_extract_data or browser_network gets a
 * truncated blob it then has to repair by hand. Dropping whole items and
 * appending one `{"_truncated": …}` element keeps the contract the tool
 * advertised (an array of records) and states what was dropped IN the data.
 * Returns null when the text is not such a document, or when not even the
 * marker element fits — both fall back to the head+tail cut.
 */
function capJsonArray(
  text: string,
  capBytes: number,
  totalBytes: number,
  declaresMaxBytes: boolean,
): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const render = (shownItems: number): string =>
    JSON.stringify(
      [
        ...parsed.slice(0, shownItems),
        {
          _truncated: {
            shownItems,
            totalItems: parsed.length,
            totalBytes,
            ...(declaresMaxBytes && { raise: `pass maxBytes up to ${MAX_RESULT_CAP_BYTES}` }),
          },
        },
      ],
      null,
      2,
    );
  const shown = largestFittingPrefix(parsed.length - 1, render, capBytes);
  return shown === null ? null : render(shown);
}

/**
 * Largest item count in [0, maxItems] whose render fits the cap, or null when
 * not even zero items fit. Items vary in size, so this is a search, not an
 * average — one huge record must not evict every small one after it.
 */
function largestFittingPrefix(
  maxItems: number,
  render: (shownItems: number) => string,
  capBytes: number,
): number | null {
  const fits = (shownItems: number): boolean =>
    Buffer.byteLength(render(shownItems), 'utf8') <= capBytes;
  if (!fits(0)) return null;
  let low = 0;
  let high = maxItems;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Cap a result that is a single top-level JSON OBJECT carrying an array
 * property (`{workspaceId, tasks: [...]}` and the like) — the object
 * counterpart of capJsonArray. The largest array property loses trailing
 * items until the document fits; every other property is kept, and the cut
 * is stated IN the data as `truncated: true` plus a `_truncated` descriptor
 * naming the field. Returns null when the text is not such a document, or
 * when the object does not fit even with that array emptied — both fall back
 * to the head+tail cut.
 */
function capJsonObject(
  text: string,
  capBytes: number,
  totalBytes: number,
  declaresMaxBytes: boolean,
): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  let field: string | null = null;
  let fieldBytes = -1;
  for (const [key, value] of Object.entries(record)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > fieldBytes) {
      field = key;
      fieldBytes = bytes;
    }
  }
  if (field === null) return null;
  const items = record[field] as unknown[];
  const render = (shownItems: number): string =>
    JSON.stringify(
      {
        // Spread first: the capped array keeps its original key position.
        ...record,
        [field as string]: items.slice(0, shownItems),
        truncated: true,
        _truncated: {
          field,
          shownItems,
          totalItems: items.length,
          totalBytes,
          ...(declaresMaxBytes && { raise: `pass maxBytes up to ${MAX_RESULT_CAP_BYTES}` }),
        },
      },
      null,
      2,
    );
  const shown = largestFittingPrefix(items.length - 1, render, capBytes);
  return shown === null ? null : render(shown);
}

/**
 * Cap one text string, head+tail, on UTF-8 codepoint boundaries. The marker
 * counts INSIDE the budget: the returned string never exceeds `capBytes`,
 * so a second application over already-capped text is a no-op. A result that
 * is a single top-level JSON array is capped by dropping trailing items
 * instead, so it stays parseable.
 */
export function capText(text: string, capBytes: number, options?: ResultCapOptions): string {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= capBytes) return text;
  const declaresMaxBytes = options?.declaresMaxBytes === true;
  const asJson = capJsonArray(text, capBytes, totalBytes, declaresMaxBytes);
  if (asJson !== null) return asJson;
  const asJsonObject = capJsonObject(text, capBytes, totalBytes, declaresMaxBytes);
  if (asJsonObject !== null) return asJsonObject;
  const marker = toolResultMarker(totalBytes, declaresMaxBytes);
  // Reserve room for the marker, truncate, then verify the postcondition:
  // the marker embeds digit counts that shift by a byte or two when the
  // retained head/tail sizes change, so the first budget is an estimate
  // corrected with at most a couple of bounded refinement passes.
  let bodyBudget = capBytes - Buffer.byteLength(marker(totalBytes), 'utf8');
  // truncateText hands the marker the elided byte count; shown = total - elided.
  const elisionMarker = (elidedBytes: number): string => marker(totalBytes - elidedBytes);
  for (let pass = 0; pass < 3 && bodyBudget > 0; pass += 1) {
    const output = truncateText(text, bodyBudget, elisionMarker).text;
    const size = Buffer.byteLength(output, 'utf8');
    if (size <= capBytes) return output;
    bodyBudget -= size - capBytes;
  }
  // Degenerate cap (smaller than the marker itself): only a markerless cut
  // can still honor the byte bound.
  return truncateText(text, capBytes, () => '').text;
}

/**
 * Cap every TEXT content block of a tool result in place (copy-on-write).
 * Image/audio/embedded-resource blocks are left untouched. Returns the same
 * object when nothing changed, so re-applying the guard (the catalog lane and
 * the legacy lane can both wrap one handler) stays a no-op.
 */
export function capToolResultText<T>(result: T, capBytes: number, options?: ResultCapOptions): T {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return result;
  let changed = false;
  const cappedContent = content.map((part) => {
    if (
      part !== null &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      const text = (part as { text: string }).text;
      const capped = capText(text, capBytes, options);
      if (capped !== text) {
        changed = true;
        return { ...part, text: capped };
      }
    }
    return part;
  });
  return changed ? { ...(result as object), content: cappedContent } as T : result;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Whether a tool input schema declares `maxBytes`. Accepts the ZodRawShape
 * that server.tool()/registerTool() take, or a ZodObject via its `.shape`
 * (what toolInputSchema() builds for strictInput tools) — so the marker can
 * name the raise path exactly where passing maxBytes would actually work.
 */
export function inputSchemaDeclaresMaxBytes(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const shape = (schema as { shape?: unknown }).shape;
  const raw = shape !== null && typeof shape === 'object' ? shape : schema;
  return Object.prototype.hasOwnProperty.call(raw, 'maxBytes');
}

/**
 * Marks a handler already wrapped by the result cap. The catalog lane
 * (registerWmuxTools) pre-wraps its callback and hands it to the patched
 * server.registerTool, which would wrap it AGAIN — double truncation that
 * reports the first pass's size as the original. A wrapped callback carries
 * this mark and a second wrap returns it unchanged.
 */
const RESULT_CAP_WRAPPED: unique symbol = Symbol('wmuxResultCapWrapped');

/**
 * Wrap a tool handler so its result passes through the text cap. The cap is
 * read from the FIRST argument (the parsed tool input), so a tool that
 * declares `maxBytes` controls its own ceiling per call. Works for both the
 * SDK's tool() and registerTool() callback shapes; thrown errors pass through
 * untouched for the SDK to render. Idempotent: wrapping an already-wrapped
 * handler returns that handler as-is.
 */
export function wrapHandlerWithResultCap<Args extends unknown[], R>(
  handler: (...args: Args) => MaybePromise<R>,
  options?: ResultCapOptions,
): (...args: Args) => MaybePromise<R> {
  if ((handler as { [RESULT_CAP_WRAPPED]?: true })[RESULT_CAP_WRAPPED] === true) {
    return handler;
  }
  const wrapped = function cappedHandler(this: unknown, ...args: Args): MaybePromise<R> {
    const cap = clampResultCapBytes((args[0] as { maxBytes?: unknown } | undefined)?.maxBytes);
    const outcome = handler.apply(this, args);
    if (
      outcome !== null &&
      typeof outcome === 'object' &&
      typeof (outcome as { then?: unknown }).then === 'function'
    ) {
      return (outcome as Promise<R>).then((resolved) =>
        capToolResultText(resolved, cap, options),
      );
    }
    return capToolResultText(outcome, cap, options);
  };
  (wrapped as { [RESULT_CAP_WRAPPED]?: true })[RESULT_CAP_WRAPPED] = true;
  return wrapped;
}
