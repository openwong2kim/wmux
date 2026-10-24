// Usage-limit card → "Continue on another PC": the held pane's work goes on in
// an agent another paired PC starts (a remote spawn, shared/a2aSpawn.ts). The
// note below is that agent's first prompt, so it is what leaves this PC:
//   - quoted requests, the reply and the draft are masked in full
//     (redactSecrets); the branch and paths only for key shapes, because the
//     long-random-token rule also takes names with digits in them;
//   - never the transcript or its path, absolute paths outside the folder, or
//     a file named like a secret (`.env`, keys, credentials);
//   - the quotes are marked as reference, not instructions: the other PC may
//     start it without anyone reading it first;
//   - it is sanitized as the request will be (sanitizeRemoteMessage, which
//     does not change it a second time), so what the dialog shows is what goes,
//     and it fits the request in UTF-8 bytes, shedding detail when it does not.

import { t } from '../i18n';
import { redactSecretsCounted } from '../../shared/redactSecrets';
import { sanitizeRemoteMessage } from '../../shared/a2aRemoteDelivery';
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

/** A file named like a secret: its name alone does not go to another PC. */
const SECRET_FILE_RE = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).length;

/** Whether `path`'s file name reads as a secret. */
export function isSecretFileName(path: string): boolean {
  return SECRET_FILE_RE.test(path.split(/[\\/]/).pop() ?? '');
}

const isAbsolute = (p: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(p);
const slashes = (p: string): string => p.replace(/\\/g, '/');

/** `path` below `cwd`, relative; null for an absolute path elsewhere (or with no folder to judge it by). */
export function folderRelative(path: string, cwd: string | undefined): string | null {
  if (!isAbsolute(path)) return slashes(path).replace(/^\.\//, '');
  if (!cwd) return null;
  const base = slashes(cwd).replace(/\/+$/, '');
  const p = slashes(path);
  // A Windows drive letter is case-insensitive; a POSIX path is not.
  const same = /^[A-Za-z]:/.test(base) ? p.toLowerCase().startsWith(`${base.toLowerCase()}/`) : p.startsWith(`${base}/`);
  return same ? p.slice(base.length + 1) : null;
}

/** The end of `text` in at most `max` UTF-8 bytes, cut on a character. */
function lastBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const chars = [...text];
  let used = 3; // the ellipsis
  let i = chars.length;
  while (i > 0 && used + bytes(chars[i - 1]) <= max) used += bytes(chars[--i]);
  return `…${chars.slice(i).join('')}`;
}

/** The start of `text` in at most `max` UTF-8 bytes, cut on a character. */
function firstBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const chars = [...text];
  let used = 3; // the ellipsis
  let i = 0;
  while (i < chars.length && used + bytes(chars[i]) <= max) used += bytes(chars[i++]);
  return `${chars.slice(0, i).join('')}…`;
}

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

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

/**
 * The first prompt for an agent on another PC taking over `fromAgent`'s held
 * work, and how many values were masked or left out. `cwd` is the held pane's
 * folder, the base its paths are given from. Pure.
 */
export function continueOnPcText(
  fromAgent: string,
  facts: Partial<HandoffFacts> | null,
  opts: { carryDraft?: boolean; cwd?: string } = {},
): { text: string; masked: number } {
  let masked = 0;
  const prose = (s: string): string => {
    const r = redactSecretsCounted(s);
    masked += r.masked;
    return r.text;
  };
  const name = (s: string): string => {
    const r = redactSecretsCounted(s, { keyShapesOnly: true });
    masked += r.masked;
    return r.text;
  };
  // Paths: inside the folder, and not named like a secret. What is left out counts as masked.
  const keep = (paths: readonly string[]): string[] => paths.flatMap((p) => {
    const rel = folderRelative(p, opts.cwd);
    if (rel === null || isSecretFileName(rel)) { masked++; return []; }
    return [name(rel)];
  });

  const requests = (facts?.requests ?? []).map((r) => r.trim()).filter(Boolean).map((r) => prose(cap(r, HANDOFF_REQUEST_MAX)));
  const replyRaw = facts?.reply?.trim();
  const reply = replyRaw ? prose(replyRaw.length > HANDOFF_REPLY_MAX ? `…${replyRaw.slice(-HANDOFF_REPLY_MAX).trimStart()}` : replyRaw) : null;
  const plans = keep(facts?.planFiles ?? []).slice(0, PLAN_FILES_MAX);
  const files = (facts?.files ?? []).flatMap((f) => {
    const [path] = keep([f.path]);
    return path === undefined ? [] : [` ${path} | ${f.additions === null ? 'bin' : `+${f.additions} -${f.deletions ?? 0}`}`];
  });
  const branch = facts?.branch ? name(facts.branch) : null;
  const draftRaw = facts?.draft?.trim();
  const draft = opts.carryDraft && draftRaw ? prose(cap(draftRaw, REMOTE_HANDOFF_DRAFT_MAX)) : null;

  const build = (s: Shape): string => {
    const quote = (r: string) => firstBytes(r, s.requestBytes);
    const parts = [t('usageLimit.remoteHandoffNote', { agent: fromAgent })];
    if (requests.length || reply) parts.push(t('usageLimit.remoteHandoffReference'));
    if (requests.length === 1) parts.push(`${t('usageLimit.handoffLastRequest')}\n${quote(requests[0])}`);
    if (requests.length > 1) {
      parts.push(`${t('usageLimit.handoffFirstRequest')}\n${quote(requests[0])}`);
      const recent = requests.slice(Math.max(1, requests.length - (s.middle ? 3 : 1)));
      parts.push(`${t('usageLimit.handoffRecentRequests')}\n${recent.map((r, i) => `${i + 1}. ${quote(r)}`).join('\n')}`);
    }
    if (reply) parts.push(`${t('usageLimit.handoffLastReply', { agent: fromAgent })}\n${lastBytes(reply, s.replyBytes)}`);
    if (plans.length) parts.push(`${t('usageLimit.handoffPlanFiles')}\n${plans.join('\n')}`);
    const git: string[] = [];
    if (branch) git.push(t('usageLimit.handoffBranch', { branch }));
    if (files.length) {
      git.push(t('usageLimit.remoteHandoffChanges'));
      git.push(...files.slice(0, s.files));
      if (files.length > s.files) git.push(` ${t('usageLimit.handoffMoreFiles', { count: files.length - s.files })}`);
    }
    git.push(branch ? t('usageLimit.remoteHandoffCheckout', { branch }) : t('usageLimit.remoteHandoffCheckFolder'));
    parts.push(git.join('\n'));
    if (draft) parts.push(`${t('usageLimit.handoffDraft')}\n${draft}`);
    return sanitizeRemoteMessage(parts.join('\n\n'));
  };

  for (const shape of SHAPES) {
    const text = build(shape);
    if (bytes(text) <= REMOTE_HANDOFF_MAX_BYTES) return { text, masked };
  }
  // Long paths or a long branch can still overflow: the head of the note is what matters most.
  return { text: firstBytes(build(SHAPES[SHAPES.length - 1]), REMOTE_HANDOFF_MAX_BYTES), masked };
}

/** Hours a handoff request may wait for the other PC: until the limit resets, at most four, at least one. */
export function remoteHandoffHours(resetsAt: number | undefined, now: number): number {
  if (resetsAt === undefined) return REMOTE_HANDOFF_HOURS_MAX;
  return Math.min(REMOTE_HANDOFF_HOURS_MAX, Math.max(1, Math.ceil((resetsAt - now) / 3_600_000)));
}
