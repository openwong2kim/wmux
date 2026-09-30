/**
 * One sanitizer for provider- or server-authored text the phone renders
 * (turn failure messages, rate-limit names, CI check names). Plain text only.
 */

// C0/C1 controls, bidi embeddings/overrides/isolates, zero-width and BOM.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Strip invisible and direction-changing characters, drop lone surrogates,
 * collapse whitespace, and clip to `maxUnits` UTF-16 units (including the
 * trailing ellipsis) without splitting a surrogate pair. Undefined when
 * nothing printable is left or the input is not a string.
 */
export function sanitizeDisplayText(value: unknown, maxUnits: number): string | undefined {
  if (typeof value !== 'string' || maxUnits < 1) return undefined;
  const flat = value.replace(LONE_SURROGATE, '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  if (flat.length <= maxUnits) return flat;
  let cut = maxUnits - 1;
  const last = flat.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  const head = flat.slice(0, cut).trimEnd();
  return head ? `${head}…` : undefined;
}

/**
 * Own-property lookup in a constant table, so an input such as `constructor`
 * or `toString` never resolves to an `Object.prototype` member.
 */
export function ownLookup<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
