/**
 * The main-thread half of `browser_repl`: turns a worker's `browser.X(args)`
 * into a call through the real `browser_X` handler and shapes the handler's
 * MCP result into a plain value the script can use.
 *
 * Everything the browser tools guarantee — automation lease, password
 * redaction, action-trace recording, frame-aware refs — lives inside the
 * handler bodies, so calling the collected handler IS keeping those
 * guarantees. The bridge adds only what direct calls skip: the SDK's Zod
 * validation, and the connection scope that MCP dispatch would have set.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CollectedTool } from '../playwright/toolCollector';
import { isHintBlock } from '../playwright/hintBlock';
import { redactPasswordParams } from '../playwright/redact';
import { withSnapshotListingCapture } from '../playwright/snapshotListing';
import { MAX_SCREENSHOT_BASE64_BYTES } from '../resultCap';
import { withoutActionRecording } from '../browser-replay/recordingSuppression';
import type { BridgeImage } from './runCollect';
import {
  getConnectionScope,
  runInConnectionScope,
  type ConnectionScope,
} from '../connectionScope';

/**
 * The tools a script may call, by short name (`browser.click` → `browser_click`).
 *
 * This is the permission boundary the feature moves: one approval of
 * `browser_repl` covers all of these, so the list holds only the observe/act
 * tools whose round trips a script is meant to fold together, plus
 * `screenshot`, which only reads the page (its image rides back beside the
 * run's text result under per-run caps, see runCollect.ts). Everything
 * that reads or writes state outside the page (cookies, storage, files,
 * downloads, PDFs, traces), runs page scripts (evaluate), or manages
 * sessions/replay stays a separate, separately approved tool call.
 */
export const BROWSER_REPL_TOOLS: readonly string[] = Object.freeze([
  'navigate',
  'navigate_back',
  'tabs',
  'click',
  'type',
  'fill',
  'press_key',
  'hover',
  'drag',
  'select',
  'scroll',
  'scroll_into_view',
  'snapshot',
  'smart_snapshot',
  'extract_text',
  'extract_data',
  'wait',
  'console',
  'highlight',
  'resize',
  'dialog',
  'screenshot',
]);

/**
 * What `repl_run`'s `browser` object exposes: the browser_repl set plus
 * screenshot. Its own list, not an alias, so widening either tool later is a
 * separate decision that cannot move the other.
 */
export const REPL_RUN_BROWSER_TOOLS: readonly string[] = Object.freeze([
  ...new Set([...BROWSER_REPL_TOOLS, 'screenshot']),
]);

/** Tools whose value carries a parsed `refs[]` — see `shapeResult`. */
const SNAPSHOT_TOOLS = new Set(['snapshot', 'smart_snapshot']);

/** Argument keys whose values are typed into the page and never shown in the ledger. */
const TYPED_TEXT_KEYS = new Set(['text', 'value']);

const LEDGER_ARGS_MAX = 160;

/**
 * Typed text can be a password; the handler decides what to record in the
 * trace, the ledger only says how much was typed. Applied at every depth so
 * `browser_fill({fields:[{ref, value}]})` is masked the same way as
 * `browser_type({text})`.
 */
function maskTypedText(key: string, raw: unknown): unknown {
  if (TYPED_TEXT_KEYS.has(key) && typeof raw === 'string') return `…(${raw.length})`;
  if (Array.isArray(raw)) return raw.map((item) => maskTypedText('', item));
  if (raw && typeof raw === 'object') {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, maskTypedText(k, v)]),
    );
  }
  return raw;
}

export interface SnapshotRef {
  /**
   * The ref as its target argument's schema wants it: a string for `ref`, a
   * number for `smartRef`. Both listings number their refs, but the tools do
   * not agree on the type, and `refs[i].ref` is documented as passable
   * straight to `refs[i].param` — so the parse, not the caller, converts.
   */
  readonly ref: string | number;
  /** Which browser_click argument takes it: `ref` (snapshot) or `smartRef` (smart_snapshot). */
  readonly param: 'ref' | 'smartRef';
  readonly role: string;
  readonly name: string;
}

/** What `browser.X(args)` resolves to inside the script. */
export interface BridgeValue {
  /** The tool's own text, without the event/hint blocks the lease prepends. */
  readonly text: string;
  /** `[browser events]` lines the lease reported alongside this call. */
  readonly events: readonly string[];
  /**
   * Snapshot tools only: every ref the snapshot minted, even when `text` is a
   * diff that names only a few of them. Empty when the format is not
   * recognized.
   */
  readonly refs?: readonly SnapshotRef[];
  /** Id of the image this call attached to the run's result (`img-N`). */
  readonly image?: string;
  /** Why an image the call returned is not in the result. */
  readonly note?: string;
  /** Per image block, when the call returned several: its id or why it was left out. */
  readonly images?: readonly string[];
}

export type BridgeOutcome =
  | {
      readonly ok: true;
      readonly value: BridgeValue;
      readonly ledger: string;
      /** `[replay]`/`[skill]` blocks this call carried; the run collects them. */
      readonly hints?: readonly string[];
      /** Image blocks the handler returned; the run decides which to attach. */
      readonly images?: readonly BridgeImage[];
    }
  | { readonly ok: false; readonly error: string; readonly ledger: string };

export interface BrowserBridgeOptions {
  /** Injected into every call whose schema accepts `surfaceId` and whose args omit it. */
  readonly surfaceId?: string;
  /**
   * The MCP connection scope captured when the run started. Worker messages
   * arrive outside the dispatch's AsyncLocalStorage, so without re-entering
   * it the handlers would fall back to process globals — another agent's
   * engine and refs under the broker.
   */
  readonly scope?: ConnectionScope;
  /**
   * False keeps every call out of the action ring. Default true: browser_repl
   * steps record exactly as direct calls do.
   */
  readonly record?: boolean;
  /** Tool name used in refusal messages; defaults to browser_repl. */
  readonly label?: string;
}

export type BridgeCall = (name: string, args: Record<string, unknown>) => Promise<BridgeOutcome>;

/** Compact, redacted rendering of a call's arguments for the ledger line. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(args)) {
    if (raw === undefined) continue;
    let rendered: string;
    try {
      rendered = JSON.stringify(maskTypedText(key, raw)) ?? String(raw);
    } catch {
      rendered = String(raw);
    }
    parts.push(`${key}:${redactPasswordParams(rendered)}`);
  }
  const joined = parts.join(', ');
  return joined.length > LEDGER_ARGS_MAX ? `${joined.slice(0, LEDGER_ARGS_MAX - 1)}…` : joined;
}

/** `  - button "Log in" ref="12"` (browser_snapshot, ai format). */
const SNAPSHOT_LINE = /^\s*-\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*?\sref="(\d+)"/;
/** `  [12] button "Log in"` (browser_smart_snapshot, Playwright lane). */
const SMART_LINE = /^\s*\[(\d+)\]\s+(\S+)\s+"((?:[^"\\]|\\.)*)"/;
/** `  [ref=12] button[type=submit] "Log in"` (browser_smart_snapshot, DOM lane). */
const SMART_DOM_LINE = /^\s*\[ref=(\d+)\]\s+(\S+?)(?:\[[^\]]*\])?\s+"((?:[^"\\]|\\.)*)"/;

/** Parse refs out of a snapshot listing. Unknown formats yield []. */
export function parseSnapshotRefs(text: string, tool: string): SnapshotRef[] {
  const refs: SnapshotRef[] = [];
  for (const line of text.split('\n')) {
    if (tool === 'snapshot') {
      const m = SNAPSHOT_LINE.exec(line);
      if (m) refs.push({ ref: m[3], param: 'ref', role: m[1], name: m[2] ?? '' });
      continue;
    }
    const m = SMART_LINE.exec(line);
    if (m) {
      refs.push({ ref: Number(m[1]), param: 'smartRef', role: m[2], name: m[3] });
      continue;
    }
    const d = SMART_DOM_LINE.exec(line);
    if (d) refs.push({ ref: Number(d[1]), param: 'smartRef', role: d[2], name: d[3] });
  }
  return refs;
}

/**
 * Split a handler result into the script-facing text, the lease's event lines,
 * and its hint blocks. The lease prepends up to two extra text blocks —
 * `[browser events]` and the `[replay]`/`[skill]` hints. Events are surfaced
 * to the script as data; hints are addressed to whoever wrote the snippet, so
 * they are kept out of the value and reported once per run instead. Any block
 * that matches neither is body. Image blocks are handed to the run, which
 * attaches them to its result; other non-text blocks are noted in the text.
 *
 * A hint is recognized by the marker only the lease can set, never by its text
 * (see hintBlock.ts): `browser_extract_text` hands back page text as its first
 * block, and a page whose text opened with `[skill] ` would otherwise empty the
 * script's value and get its own string printed as a hint. The events block has
 * no such marker, so its match is kept tight instead — it only ever precedes
 * the handler's own content, and every one of its lines must be in the lease's
 * `- type[: url] (N ago)` form. Once a body block is seen, the rest is body.
 */
const EVENT_LINE = /^- [\w-]+(?::.*)? \([^()]* ago\)$/;

function parseEventsBlock(text: string): string[] | null {
  if (!text.startsWith('[browser events]\n')) return null;
  const lines = text.slice('[browser events]\n'.length).split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0 || !lines.every((line) => EVENT_LINE.test(line))) return null;
  return lines.map((line) => line.slice(2));
}

export interface ShapedResult {
  readonly value: BridgeValue;
  /** `[replay]`/`[skill]` blocks the lease prepended, verbatim. */
  readonly hints: readonly string[];
  readonly images: readonly BridgeImage[];
}

/**
 * `listing` is the complete snapshot listing the handler published on the side
 * channel (snapshotListing.ts). It exists so `refs` can stay complete while
 * `text` is a diff; without one — an unrecognized route, or a tool that is not
 * a snapshot — the returned text is the only source there is.
 */
export function shapeResult(
  result: CallToolResult,
  tool: string,
  listing?: string,
): ShapedResult {
  const events: string[] = [];
  const hints: string[] = [];
  const body: string[] = [];
  const images: BridgeImage[] = [];
  for (const block of result.content ?? []) {
    if (block.type === 'image') {
      images.push({ data: block.data, mimeType: block.mimeType });
      continue;
    }
    if (block.type !== 'text') {
      body.push(`[${block.type} content omitted]`);
      continue;
    }
    const text = block.text;
    if (body.length === 0) {
      const eventLines = parseEventsBlock(text);
      if (eventLines) {
        events.push(...eventLines);
        continue;
      }
    }
    if (isHintBlock(block)) {
      hints.push(text);
      continue;
    }
    body.push(text);
  }
  const text = body.join('\n');
  if (SNAPSHOT_TOOLS.has(tool)) {
    return { value: { text, events, refs: parseSnapshotRefs(listing ?? text, tool) }, hints, images };
  }
  return { value: { text, events }, hints, images };
}

/**
 * The reason a failed call gives the script. Only the event block is dropped —
 * the lease refuses to hint on a failure (a failed call is not a landing), so
 * every other block is the tool's own words and dropping one would cost the
 * script the reason it failed.
 */
function errorText(result: CallToolResult): string {
  const texts = (result.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    // The lease still prepends events to error results; the script wants the reason.
    .filter((t) => parseEventsBlock(t) === null);
  return texts.join('\n').trim() || 'tool returned an error without a message';
}

/**
 * Build the bridge over the collected handlers. `tools` is the collector sink
 * (full `browser_*` names); only entries in `allowedTools` are reachable, and
 * the name is checked on every call.
 */
export function createBrowserBridge(
  tools: ReadonlyMap<string, CollectedTool>,
  options: BrowserBridgeOptions,
  allowedTools: readonly string[] = BROWSER_REPL_TOOLS,
): BridgeCall {
  const validators = new Map<string, z.ZodObject<z.ZodRawShape>>();
  const allowed = new Set(allowedTools);
  const label = options.label ?? 'browser_repl';

  return async (name, rawArgs) => {
    const started = Date.now();
    const ledgerFor = (args: Record<string, unknown>, status: string) =>
      `${name}(${summarizeArgs(args)}) ${status} ${Date.now() - started}ms`;

    if (!allowed.has(name)) {
      const reason = tools.has(`browser_${name}`)
        ? `browser.${name} is not available inside ${label} — call the browser_${name} tool directly`
        : `browser.${name} is not a browser tool`;
      return { ok: false, error: reason, ledger: ledgerFor(rawArgs, 'REFUSED') };
    }
    const collected = tools.get(`browser_${name}`);
    if (!collected) {
      return {
        ok: false,
        error: `browser_${name} is not registered on this server`,
        ledger: ledgerFor(rawArgs, 'REFUSED'),
      };
    }

    const args: Record<string, unknown> = { ...rawArgs };
    if (options.surfaceId !== undefined && 'surfaceId' in collected.shape && args.surfaceId === undefined) {
      args.surfaceId = options.surfaceId;
    }
    // A scripted screenshot never raises its own ceiling: a loop of 8 MiB
    // captures would dwarf the run's image budget before the cap could count.
    if (
      name === 'screenshot' &&
      (typeof args.maxBytes !== 'number' || !(args.maxBytes <= MAX_SCREENSHOT_BASE64_BYTES))
    ) {
      args.maxBytes = MAX_SCREENSHOT_BASE64_BYTES;
    }
    let validator = validators.get(name);
    if (!validator) {
      validator = z.object(collected.shape);
      validators.set(name, validator);
    }
    const parsed = validator.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        ok: false,
        error: `browser.${name}: invalid arguments — ${issues} (valid: ${Object.keys(collected.shape).join(', ')})`,
        ledger: ledgerFor(args, 'INVALID'),
      };
    }

    const call = () => collected.handler(parsed.data as Record<string, unknown>);
    const invoke = options.record === false ? () => withoutActionRecording(call) : call;
    const scoped = async (): Promise<CallToolResult> => {
      const scope = options.scope ?? getConnectionScope();
      return scope ? await runInConnectionScope(scope, invoke) : await invoke();
    };
    let result: CallToolResult;
    // The script gets the same diff-or-full text a direct call would (its
    // first line says which), and the refs come from the full listing the
    // handler publishes alongside it — so `refs.find(...)` still sees every
    // element without the snapshot being taken in full every time.
    let listing: string | undefined;
    try {
      if (SNAPSHOT_TOOLS.has(name)) {
        const captured = await withSnapshotListingCapture(scoped);
        result = captured.result;
        listing = captured.listing;
      } else {
        result = await scoped();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `browser.${name}: ${message}`, ledger: ledgerFor(args, 'THREW') };
    }
    if (result.isError) {
      return { ok: false, error: `browser.${name}: ${errorText(result)}`, ledger: ledgerFor(args, 'FAILED') };
    }
    const { value, hints, images } = shapeResult(result, name, listing);
    const eventNote = value.events.length > 0 ? ` · ${value.events.length} event(s)` : '';
    return {
      ok: true,
      value,
      ledger: `${ledgerFor(args, 'ok')}${eventNote}`,
      hints,
      ...(images.length > 0 && { images }),
    };
  };
}
