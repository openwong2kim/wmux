// Usage-limit card → "Continue on another PC": the held pane's work goes on in
// an agent another paired PC starts (a remote spawn, shared/a2aSpawn.ts). The
// note below is that agent's first prompt, so it is what leaves this PC:
//   - quoted text (requests, the reply, the draft) is masked in full BEFORE it
//     is cut to length, so a cut never splits a key past recognition, and the
//     cut never splits a mask marker;
//   - local paths in quoted text become `.` (the folder), `<home>`,
//     `<file-url>` or `<unc-path>`, so no user or machine name goes along;
//   - never the transcript or its path, a path outside the folder, or a path
//     with any part named like a secret (`.env`, `.ssh/`, keys, credentials);
//   - every quoted part sits between `[quote <id>]` and `[end <id>]` with an
//     id drawn per note and removed from the quotes themselves, under a line
//     saying they are reference, not instructions: the other PC may start it
//     without anyone reading it first. The branch and paths are one line each,
//     in backticks;
//   - the whole note then goes through finalizeSpawnPrompt, which main runs
//     again before it leaves, and fits the request in UTF-8 bytes, shedding
//     detail when it does not.

import { t } from '../i18n';
import { REDACTED, redactSecretsCounted } from '../../shared/redactSecrets';
import { finalizeSpawnPrompt, stripBidi } from '../../shared/a2aSpawnPrompt';
import { SPAWN_TEXT_MAX } from '../../shared/a2aSpawn';
import { HANDOFF_FILES_MAX, HANDOFF_REPLY_MAX, HANDOFF_REQUEST_MAX, type HandoffFacts } from './continueInAgent';

/** The note's budget, in UTF-8 bytes: under the request's cap. */
export const REMOTE_HANDOFF_MAX_BYTES = SPAWN_TEXT_MAX - 2 * 1024;
/** Longest draft the note carries. */
export const REMOTE_HANDOFF_DRAFT_MAX = 1500;
/** Most plan files the note lists. */
const PLAN_FILES_MAX = 10;
/** A request waits for the other PC at most this long, and never past the limit's reset. */
export const REMOTE_HANDOFF_HOURS_MAX = 4;

/**
 * A path part named like a secret: env files, key and certificate files,
 * credential stores, SSH, cloud and GPG folders, service-account JSON.
 */
const SECRET_PART_RE = /^(?:\.env(?:rc)?(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.ssh|\.aws|\.gnupg|\.kube|\.docker|secrets?|authorized_keys|known_hosts|id_(?:rsa|dsa|ecdsa|ed25519).*|credentials?(?:\..*)?|.*service[-_]?account.*\.json|.*\.(?:pem|key|p8|p12|pfx|jks|keystore|gpg|asc))$/i;

const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).length;

/** Whether any part of `path` reads as a secret. */
export function isSecretFileName(path: string): boolean {
  return path.split(/[\\/]/).some((part) => SECRET_PART_RE.test(part));
}

const isAbsolute = (p: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
const slashes = (p: string): string => p.replace(/\\/g, '/');

/**
 * `path` below `cwd`, relative. Null for: an absolute path elsewhere, any
 * path with a `..` part (it could climb out whatever its prefix), a `~` or
 * `file:` path, and an absolute path when there is no folder or the folder is
 * a root (`/`, `C:\`), which says nothing about where a path belongs.
 */
export function folderRelative(path: string, cwd: string | undefined): string | null {
  const p = slashes(path);
  if (/^(?:~|file:)/i.test(p) || p.split('/').includes('..')) return null;
  if (!isAbsolute(path)) return p.replace(/^(?:\.\/)+/, '') || null;
  const base = cwd ? slashes(cwd).replace(/\/+$/, '') : '';
  if (!base || /^[A-Za-z]:$/.test(base)) return null;
  // A Windows drive letter is case-insensitive; a POSIX path is not.
  const same = /^[A-Za-z]:/.test(base) ? p.toLowerCase().startsWith(`${base.toLowerCase()}/`) : p.startsWith(`${base}/`);
  const rel = same ? p.slice(base.length + 1) : '';
  return rel && !isAbsolute(rel) ? rel : null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Local paths in quoted text, with no user or machine name: the folder as
 * `.`, a home folder as `<home>`, a `file:` URL as `<file-url>`, a UNC path as
 * `<unc-path>`. Other absolute paths (`/etc/hosts`) name no one and stay.
 */
export function scrubLocalPaths(text: string, cwd: string | undefined): string {
  let out = text;
  const base = cwd?.replace(/[\\/]+$/, '');
  if (base && !/^[A-Za-z]:$/.test(base)) {
    for (const form of new Set([base, slashes(base)])) {
      // Only the whole folder: `/repo` is not the start of `/repository`.
      out = out.replace(new RegExp(`${escapeRe(form)}(?=[\\\\/\\s"'\`<>),;:]|$)`, /^[A-Za-z]:/.test(form) ? 'gim' : 'gm'), '.');
    }
  }
  return out
    .replace(/\bfile:\/\/[^\s"'`<>]*/gi, '<file-url>')
    .replace(/(^|[\s"'`(<])\\\\[^\\\s"'`<>]+\\[^\s"'`<>]*/g, '$1<unc-path>')
    // `C:\Users\kim`, also JSON-escaped (`C:\\Users\\kim`) or with forward slashes.
    .replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>]+/gi, '<home>')
    // `/Users/kim`, `/home/kim`, WSL's `/mnt/c/Users/kim`, also JSON-escaped (`\/Users\/kim`).
    .replace(/(^|[^\w.~-])\\?\/(?:mnt\\?\/[a-z]\\?\/)?(?:Users|home)\\?\/[^/\\\s"'`<>]+/gi, '$1<home>')
    .replace(/(^|[^\w.~-])\/root(?=[/\s"'`<>]|$)/g, '$1<home>')
    .replace(/(^|[\s"'`(<])~[A-Za-z0-9._-]*(?=[\\/])/g, '$1<home>');
}

/** `i` moved off a mask marker it falls inside: to the marker's start (`back`) or past its end. */
function offMarker(text: string, i: number, back: boolean): number {
  for (let at = text.indexOf(REDACTED); at !== -1 && at < i; at = text.indexOf(REDACTED, at + 1)) {
    if (i > at && i < at + REDACTED.length) return back ? at : at + REDACTED.length;
  }
  return i;
}

/** `i` moved back off the middle of a surrogate pair. */
const onChar = (text: string, i: number): number => (i > 0 && i < text.length && /[\uDC00-\uDFFF]/.test(text[i]) ? i - 1 : i);

/** The start of `text` in at most `max` UTF-8 bytes, cut on a character, never inside a mask marker. */
function firstBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let used = 3; // the ellipsis
  let i = 0;
  for (const c of text) {
    if (used + bytes(c) > max) break;
    used += bytes(c);
    i += c.length;
  }
  return `${text.slice(0, offMarker(text, i, true))}…`;
}

/** The end of `text` in at most `max` UTF-8 bytes, cut on a character, never inside a mask marker. */
function lastBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const chars = [...text];
  let used = 3; // the ellipsis
  let i = text.length;
  for (let k = chars.length - 1; k >= 0 && used + bytes(chars[k]) <= max; k--) {
    used += bytes(chars[k]);
    i -= chars[k].length;
  }
  return `…${text.slice(offMarker(text, i, false))}`;
}

/** The first `max` characters, never inside a mask marker. */
function firstChars(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, offMarker(text, onChar(text, max), true)).trimEnd()}…` : text;
}

/** The last `max` characters, never inside a mask marker. */
function lastChars(text: string, max: number): string {
  return text.length > max ? `…${text.slice(offMarker(text, onChar(text, text.length - max), false)).trimStart()}` : text;
}

/** One line, no controls or bidi, no backticks: a name shown as `name`. */
// eslint-disable-next-line no-control-regex -- removing controls is the point
const oneLine = (s: string): string => stripBidi(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/`/g, "'").trim();

const markers = (s: string): number => s.split(REDACTED).length - 1;

interface Shape {
  /** Keep the requests between the first and the latest. */
  middle: boolean;
  files: number;
  /** Byte caps for one request and for the reply (Infinity: the character caps alone). */
  requestBytes: number;
  replyBytes: number;
}

const SHAPES: readonly Shape[] = [
  { middle: true, files: HANDOFF_FILES_MAX, requestBytes: Infinity, replyBytes: Infinity },
  { middle: false, files: HANDOFF_FILES_MAX, requestBytes: Infinity, replyBytes: Infinity },
  { middle: false, files: 10, requestBytes: Infinity, replyBytes: Infinity },
  { middle: false, files: 10, requestBytes: Infinity, replyBytes: 2048 },
  { middle: false, files: 10, requestBytes: 2048, replyBytes: 1024 },
  { middle: false, files: 10, requestBytes: 1024, replyBytes: 512 },
];

/** A fresh id for a note's quote fences. */
function quoteId(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The first prompt for an agent on another PC taking over `fromAgent`'s held
 * work. `masked`: mask markers the note added; `leftOut`: paths left out
 * (outside the folder, or named like a secret). `cwd` is the held pane's
 * folder, the base its paths are given from. Pure but for the quote id, which
 * `opts.quoteId` fixes.
 */
export function continueOnPcText(
  fromAgent: string,
  facts: Partial<HandoffFacts> | null,
  opts: { carryDraft?: boolean; cwd?: string; quoteId?: string } = {},
): { text: string; masked: number; leftOut: number } {
  const id = opts.quoteId ?? quoteId();
  let leftOut = 0;
  // Quoted text: local paths scrubbed, masked whole, then the id taken out.
  const quoted = (s: string): string => redactSecretsCounted(scrubLocalPaths(stripBidi(s), opts.cwd)).text.split(id).join('');
  const name = (s: string): string => oneLine(redactSecretsCounted(s, { readableNames: true }).text);
  // Paths: inside the folder, and no part named like a secret.
  const keep = (paths: readonly string[]): string[] => paths.flatMap((p) => {
    const rel = folderRelative(oneLine(p), opts.cwd);
    if (rel === null || isSecretFileName(rel)) { leftOut++; return []; }
    return [`\`${name(rel)}\``];
  });

  const requests = (facts?.requests ?? []).map((r) => r.trim()).filter(Boolean).map((r) => firstChars(quoted(r), HANDOFF_REQUEST_MAX));
  const replyRaw = facts?.reply?.trim();
  const reply = replyRaw ? lastChars(quoted(replyRaw), HANDOFF_REPLY_MAX) : null;
  const plans = keep(facts?.planFiles ?? []).slice(0, PLAN_FILES_MAX);
  const files = (facts?.files ?? []).flatMap((f) => {
    const [path] = keep([f.path]);
    return path === undefined ? [] : [` ${path} | ${f.additions === null ? 'bin' : `+${f.additions} -${f.deletions ?? 0}`}`];
  });
  const branch = facts?.branch ? name(facts.branch) : '';
  const draftRaw = facts?.draft?.trim();
  const draft = opts.carryDraft && draftRaw ? firstChars(quoted(draftRaw), REMOTE_HANDOFF_DRAFT_MAX) : null;

  const fence = (label: string, body: string): string => `${label}\n[quote ${id}]\n${body}\n[end ${id}]`;
  const build = (s: Shape): string => {
    const quote = (r: string) => firstBytes(r, s.requestBytes);
    const parts = [t('usageLimit.remoteHandoffNote', { agent: fromAgent })];
    if (requests.length || reply || draft) parts.push(t('usageLimit.remoteHandoffReference', { id }));
    if (requests.length === 1) parts.push(fence(t('usageLimit.handoffLastRequest'), quote(requests[0])));
    if (requests.length > 1) {
      parts.push(fence(t('usageLimit.handoffFirstRequest'), quote(requests[0])));
      const recent = requests.slice(Math.max(1, requests.length - (s.middle ? 3 : 1)));
      parts.push(fence(t('usageLimit.handoffRecentRequests'), recent.map((r, i) => `${i + 1}. ${quote(r)}`).join('\n')));
    }
    if (reply) parts.push(fence(t('usageLimit.handoffLastReply', { agent: fromAgent }), lastBytes(reply, s.replyBytes)));
    if (plans.length) parts.push(`${t('usageLimit.handoffPlanFiles')}\n${plans.join('\n')}`);
    const git: string[] = [];
    if (branch) git.push(t('usageLimit.handoffBranch', { branch: `\`${branch}\`` }));
    if (files.length) {
      git.push(t('usageLimit.remoteHandoffChanges'));
      git.push(...files.slice(0, s.files));
      if (files.length > s.files) git.push(` ${t('usageLimit.handoffMoreFiles', { count: files.length - s.files })}`);
    }
    git.push(branch ? t('usageLimit.remoteHandoffCheckout', { branch: `\`${branch}\`` }) : t('usageLimit.remoteHandoffCheckFolder'));
    parts.push(git.join('\n'));
    if (draft) parts.push(fence(t('usageLimit.handoffDraft'), draft));
    return finalizeSpawnPrompt(parts.join('\n\n')).text;
  };

  let text: string | null = null;
  for (const shape of SHAPES) {
    const built = build(shape);
    if (bytes(built) <= REMOTE_HANDOFF_MAX_BYTES) { text = built; break; }
  }
  // Long paths or a long branch can still overflow: the head of the note is
  // what matters most, and the cut is final already (finalize changes nothing).
  text ??= finalizeSpawnPrompt(firstBytes(build(SHAPES[SHAPES.length - 1]), REMOTE_HANDOFF_MAX_BYTES)).text;
  // Only the markers this note added: a quoted `[redacted]` already in the conversation is not one.
  const before = markers([...(facts?.requests ?? []), facts?.reply ?? '', opts.carryDraft ? facts?.draft ?? '' : '', facts?.branch ?? '', ...(facts?.planFiles ?? []), ...(facts?.files ?? []).map((f) => f.path)].join('\n'));
  return { text, masked: Math.max(0, markers(text) - before), leftOut };
}

/**
 * Hours a handoff request may wait for the other PC: whole hours that do not
 * pass the limit's reset, one to four; four when the reset is unknown, one
 * when it is under an hour away (a request waits a whole hour at least). Null
 * once the limit has reset: the pane can simply resume.
 */
export function remoteHandoffHours(resetsAt: number | undefined, now: number): number | null {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return REMOTE_HANDOFF_HOURS_MAX;
  const left = resetsAt - now;
  if (left <= 0) return null;
  return Math.min(REMOTE_HANDOFF_HOURS_MAX, Math.max(1, Math.floor(left / 3_600_000)));
}
