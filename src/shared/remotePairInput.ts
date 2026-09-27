import { DESKTOP_PAIR_FRAGMENT_KEY } from './web';

/**
 * What the "+ Pair new computer" field was given.
 *
 * One field accepts every shape a person is likely to paste:
 *
 *   - the computer pairing link  `https://host/pair#wmux-desktop-code=ABCD2345`
 *   - the phone pairing link     `https://host/pair?code=ABCD2345`
 *   - an address and a code      `https://host:7681 ABCD2345`
 *   - a `wmux web` token URL     `https://host:7681/?token=…`
 *
 * Parsed HERE, in shared code the renderer calls, so the raw text never
 * becomes an IPC payload: the main-process error log summarizes a failed
 * handler's first argument, and a pairing link is a credential. What crosses
 * is the origin and the code (`hostsPair`) or the token URL (`hostsAdd`,
 * which already guards that argument).
 */
export type RemotePairInput =
  | { kind: 'pair'; origin: string; code: string }
  | { kind: 'token'; url: string; origin: string }
  | { kind: 'error'; reason: RemotePairInputError };

export type RemotePairInputError =
  /** Nothing to parse. */
  | 'empty'
  /** Not an http(s) address — `javascript:`, `file:`, `data:`, or no scheme. */
  | 'not-a-link'
  /** An address with no code or token in it. */
  | 'missing-code'
  /** A code that cannot be one the host minted. */
  | 'bad-code';

/** The host's code alphabet: A-Z2-9 without the ambiguous 0/O/1/I. */
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;

/** Normalize a typed or pasted code; '' when it cannot be a real one. */
export function normalizePairCode(raw: string): string {
  const code = raw.trim().replace(/[\s-]/g, '').toUpperCase();
  return CODE_RE.test(code) ? code : '';
}

function parseHttpUrl(raw: string): URL | null {
  // The scheme is checked on the TEXT before `new URL` interprets anything,
  // so `javascript:`/`file:`/`data:` never become a URL object here at all.
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** `wmux-desktop-code=X` in a fragment, key matched case-insensitively. */
function fragmentCode(hash: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    let key = part.slice(0, eq);
    let value = part.slice(eq + 1);
    try {
      key = decodeURIComponent(key);
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (key.trim().toLowerCase() === DESKTOP_PAIR_FRAGMENT_KEY) return value;
  }
  return null;
}

export function parseRemotePairInput(input: string): RemotePairInput {
  const text = (input ?? '').trim();
  if (!text) return { kind: 'error', reason: 'empty' };

  // "address code": the two things the old form asked for, pasted together.
  const parts = text.split(/\s+/);
  if (parts.length === 2) {
    const url = parseHttpUrl(parts[0]);
    if (!url) return { kind: 'error', reason: 'not-a-link' };
    const code = normalizePairCode(parts[1]);
    return code ? { kind: 'pair', origin: url.origin, code } : { kind: 'error', reason: 'bad-code' };
  }
  if (parts.length > 2) return { kind: 'error', reason: 'not-a-link' };

  const url = parseHttpUrl(text);
  if (!url) return { kind: 'error', reason: 'not-a-link' };

  // The computer link wins over anything else in the same URL: it is the one
  // shape made for this field.
  const fromFragment = fragmentCode(url.hash);
  if (fromFragment !== null) {
    const code = normalizePairCode(fromFragment);
    return code ? { kind: 'pair', origin: url.origin, code } : { kind: 'error', reason: 'bad-code' };
  }
  const queryCode = url.searchParams.get('code');
  if (queryCode !== null) {
    const code = normalizePairCode(queryCode);
    return code ? { kind: 'pair', origin: url.origin, code } : { kind: 'error', reason: 'bad-code' };
  }
  if (url.searchParams.get('token')) return { kind: 'token', url: url.toString(), origin: url.origin };
  return { kind: 'error', reason: 'missing-code' };
}
