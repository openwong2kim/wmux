/* eslint-disable no-control-regex -- this sanitizer's entire purpose is to match
   and strip C0/C1/DEL/ESC/OSC control characters from untrusted remote text. */
// === LanLink ingress sanitizer (PR-4, C16) ===
//
// A NEW pure sanitizer for UNTRUSTED remote text — NOT shared/types.ts'
// sanitizePtyText, which strips only NUL+C1 and deliberately PRESERVES ESC/CSI
// for trusted PTY-bound output. Remote LAN text is rendered as React text (the
// no-paste wall keeps it out of any PTY), but it is still control-char and
// homograph sanitized here, before it reaches the durable inbox, so the renderer
// never has to trust the bytes.
//
// ORDER MATTERS: CR/LF are normalized to a single space FIRST (so a stripped
// newline cannot weld two lines together), THEN OSC is removed before lone-ESC
// (so the OSC intro ESC is consumed as part of the OSC, not left as a bare ESC),
// THEN the control / invisible / bidi classes, THEN the length clamp, THEN a
// trailing lone surrogate is dropped (no malformed UTF-16 on disk).
//
// Pure + TOTAL: this NEVER throws on hostile input — a throw out of the accept
// loop would be a DoS. A malformed / huge field simply degrades (clamp / strip).
//
// Every pattern below is built with `new RegExp(<ascii-escaped string>)` so the
// source file contains ONLY printable ASCII escape sequences (\\xNN / \\uNNNN) —
// never a literal invisible/control character, which would be unreviewable and
// could silently corrupt the very patterns meant to strip it.

import { BODY_MAX, PEER_NAME_MAX, clampText } from '../../shared/lanlink';

// CR/LF + Unicode line/paragraph separators (U+2028/U+2029) -> single space (run
// FIRST so the C0 strip below can't weld lines, and so a non-C0 separator can't
// sneak an injected line break past the CR/LF normalization).
const CRLF_RE = new RegExp('[\\r\\n\\u2028\\u2029]+', 'g');
// OSC: ESC ] ... BEL (stripped before the lone-ESC pass). An unterminated OSC
// (no BEL) consumes to end-of-string — the safe over-strip direction.
const OSC_RE = new RegExp('\\x1B\\][^\\x07]*\\x07?', 'g');
// C0 controls EXCEPT TAB (0x09); CR/LF already normalized away. Covers
// 0x00-0x08 and 0x0B-0x1F (so 0x0B/0x0C and the lone ESC 0x1B are included).
const C0_EXCEPT_TAB_RE = new RegExp('[\\x00-\\x08\\x0B-\\x1F]', 'g');
// DEL.
const DEL_RE = new RegExp('\\x7F', 'g');
// C1 controls, including the 8-bit CSI 0x9B.
const C1_RE = new RegExp('[\\x80-\\x9F]', 'g');
// Zero-width / bidi incl. LRI/RLI/FSI/PDI isolates (U+2066-2069, Trojan-Source)
// and the Arabic letter mark U+061C.
const ZW_BIDI_RE = new RegExp(
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u061C\\uFEFF\\u00AD]',
  'g',
);
// Invisible filler homoglyphs (Hangul filler family + halfwidth Hangul filler).
const FILLER_RE = new RegExp('[\\u115F\\u1160\\u3164\\uFFA0]', 'g');

function strip(raw: string): string {
  return raw
    .replace(CRLF_RE, ' ')
    .replace(OSC_RE, '')
    .replace(C0_EXCEPT_TAB_RE, '')
    .replace(DEL_RE, '')
    .replace(C1_RE, '')
    .replace(ZW_BIDI_RE, '')
    .replace(FILLER_RE, '');
}

/** Drop a trailing high surrogate with no following low surrogate (malformed). */
function dropTrailingLoneSurrogate(s: string): string {
  if (s.length === 0) return s;
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return s.slice(0, -1);
  return s;
}

function sanitize(raw: string, max: number): string {
  const stripped = strip(raw);
  const clamped = clampText(stripped, max);
  return dropTrailingLoneSurrogate(clamped);
}

/** Sanitize a remote message body (clamped to BODY_MAX). Never throws. */
export function sanitizeRemoteText(raw: string): string {
  return sanitize(raw, BODY_MAX);
}

/** Sanitize a remote peer display name (clamped to PEER_NAME_MAX). Never throws. */
export function sanitizeRemotePeerName(raw: string): string {
  return sanitize(raw, PEER_NAME_MAX);
}

// Defense-in-depth (C16): after sanitize, re-check for any residual stripped-class
// codepoint. isInboxFile validates text/peerName only as strings, so this gives a
// cheap "drop the record" backstop should a strip rule ever regress. TAB is
// allowed (it is the one preserved C0).
const RESIDUAL_RE = new RegExp(
  '[\\x00-\\x08\\x0B-\\x1F\\x7F\\x80-\\x9F\\u2028\\u2029\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u061C\\uFEFF\\u00AD\\u115F\\u1160\\u3164\\uFFA0]',
);

/** True iff `s` still contains a stripped-class codepoint (=> drop the record). */
export function hasResidualControl(s: string): boolean {
  return RESIDUAL_RE.test(s);
}
