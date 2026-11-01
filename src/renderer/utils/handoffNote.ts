// The handoff note: what another agent needs to pick up a pane's work, typed
// into that agent's input (utils/continueInAgent.ts) and never sent by wmux.
// wmux writes it from facts alone, never with a model call:
//   - the pane's parsed transcript (TurnEvent: Claude Code, Codex CLI and every
//     other agent the daemon projects), read by `transcriptHandoff`;
//   - the folder's git state and the agent input's unsent draft, gathered by
//     continueInAgent.ts's `handoffFacts`.
// `handoffNoteText` turns those facts into the note. Both are pure: the same
// facts give the same note in the same locale. Short on purpose: the latest
// request, the end of the last reply and a capped file list, with the
// transcript named for anything more.

import { t } from '../i18n';
import { redactSecrets } from '../../shared/redactSecrets';
import { USAGE_LIMIT_CONTINUE_PROMPT } from '../../shared/usageLimit';
import type { DiffNumstat } from '../../shared/diffParse';
import type { TurnEvent } from '../../shared/transcript/turnEvents';

/** What the handoff note is built from. */
export interface HandoffFacts {
  /** The owner's requests, oldest first; the first is the earliest one read. */
  requests: string[];
  /** The agent's last reply, as prose. */
  reply: string | null;
  /** Files the agent wrote or patched, the latest first, below the repository's folder when inside it. */
  filesTouched: string[];
  /** The written files that are plans or todo lists. */
  planFiles: string[];
  /** The repository's folder name, else the pane folder's. */
  repo: string | null;
  branch: string | null;
  /** The folder's uncommitted changes, `git diff --stat` style. */
  files: readonly DiffNumstat[];
  transcriptPath: string | null;
  /** Text typed into the agent's input and never sent. */
  draft: string | null;
  /** The commit checked out when the facts were read (the branch's HEAD). */
  head?: string | null;
}

/** What one transcript says, for the note. */
export type TranscriptHandoff = Pick<HandoffFacts, 'requests' | 'reply' | 'filesTouched' | 'planFiles'>;

/** Longest request the remote (another PC) note quotes. */
export const HANDOFF_REQUEST_MAX = 2000;
/** Longest reply excerpt the remote note quotes (its end, where a summary sits). */
export const HANDOFF_REPLY_MAX = 1500;
/** Most changed files the remote note lists. */
export const HANDOFF_FILES_MAX = 30;

/** Longest request this note quotes. */
export const NOTE_REQUEST_MAX = 240;
/** Longest reply excerpt this note quotes: its end, where a summary sits. */
export const NOTE_REPLY_MAX = 400;
/** Most files this note names. */
export const NOTE_FILES_MAX = 8;
/** Longest draft this note carries. */
export const NOTE_DRAFT_MAX = 1000;
/** Most commits the note that brings work back names. */
export const NOTE_COMMITS_MAX = 5;
/** Longest commit subject it quotes. */
export const NOTE_COMMIT_SUBJECT_MAX = 60;

/** A commit an agent made, as `git commit` printed it. */
export interface TranscriptCommit {
  sha: string;
  subject: string;
}

/** What the agent that took a pane's work over did, for the note that brings it back. */
export interface BringBackFacts extends Pick<HandoffFacts, 'reply' | 'filesTouched' | 'repo' | 'branch' | 'files' | 'transcriptPath'> {
  /** The owner's requests there after the handoff note, oldest first. */
  requests: string[];
  commits: TranscriptCommit[];
}

/** A tool that writes files by name: Claude Code's Write/Edit/MultiEdit/
 *  NotebookEdit, Gemini's and Qwen's write_file/replace. Read-only tools take
 *  a `file_path` too, so the name decides. */
const WRITE_TOOL_RE = /write|edit|replace|patch/i;
/** A written path argument. */
const PATH_ARG_RE = /"(?:file_path|notebook_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)+)"/g;
/** A patch's file header: in a raw patch (Codex's apply_patch tool), one per
 *  line; inside a script's string literal (Codex CLI 0.163's `exec` tool
 *  calling `tools.apply_patch`), after a written `\n` and with its
 *  backslashes doubled. */
const PATCH_FILE_RE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;
const QUOTED_PATCH_FILE_RE = /(?<!\\)\\n\*\*\* (?:Add File|Update File|Move to): (.+?)(?=(?<!\\)\\n|")/g;
/** A plan or todo file: under a plans/todos folder, or named for one. */
const PLAN_FILE_RE = /(?:^|[\\/])(?:plans?|todos?)[\\/][^\\/]+$|(?:^|[\\/])[^\\/]*(?:plan|todo)[^\\/]*\.(?:md|txt)$/i;

/** `git commit`'s summary line: `[branch 3a91c2e] subject`, `[main (root-commit) 3a91c2e] subject`. */
const COMMIT_LINE_RE = /^\[[^\]\s]+(?: \([\w-]+\))? ([0-9a-f]{7,40})\] (.+)$/gm;

/** A string literal's escapes taken out: a doubled backslash becomes one, `\"` becomes `"`. */
const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');

/** `path` below `cwd`, with `/` separators as git gives them, when it is
 *  inside it; else as given. Either separator, on either side. */
function belowFolder(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = path.replace(/\\/g, '/');
  if (!base) return path;
  // A Windows drive letter is case-insensitive; a POSIX path is not.
  const inside = /^[A-Za-z]:/.test(base) ? p.toLowerCase().startsWith(`${base.toLowerCase()}/`) : p.startsWith(`${base}/`);
  return inside && p.length > base.length + 1 ? p.slice(base.length + 1) : path;
}

/**
 * The owner's requests, the agent's last reply and the files it wrote (the
 * latest written first), from a transcript's events in file order (several
 * pages joined, oldest first). wmux's own continue message (sent at a
 * usage-limit reset) is not a request. Paths are given below `cwd` (the
 * repository's top folder, else the pane's) when they are inside it.
 */
export function transcriptHandoff(events: readonly TurnEvent[], cwd?: string): TranscriptHandoff {
  const requests: string[] = [];
  const written: string[] = [];
  let reply: string | null = null;
  for (const e of events) {
    if (e.folded) continue;
    if (e.kind === 'user_text') {
      const text = e.text.trim();
      if (text && text !== USAGE_LIMIT_CONTINUE_PROMPT) requests.push(e.text);
    } else if (e.kind === 'assistant_text') {
      // A code block's inline marker is NUL-delimited.
      // eslint-disable-next-line no-control-regex
      if (!e.thinking && e.text.trim()) reply = e.text.replace(/\u0000code:\d+\u0000/g, '[code]');
    } else if (e.kind === 'tool_use' && e.input?.inline) {
      const input = e.input.inline;
      if (WRITE_TOOL_RE.test(e.name)) {
        for (const m of input.matchAll(PATH_ARG_RE)) written.push(belowFolder(unescape(m[1]), cwd));
      }
      // Only a patch handed to apply_patch (the tool, or a script or shell calling it).
      if (input.includes('*** Begin Patch') && (/apply_patch/.test(e.name) || input.includes('apply_patch'))) {
        for (const m of input.matchAll(PATCH_FILE_RE)) {
          // The input is only a head when it is long: a header at its very end may be cut.
          if (e.input.truncated && (m.index ?? 0) + m[0].length >= input.length) continue;
          written.push(belowFolder(m[1].trim(), cwd));
        }
        for (const m of input.matchAll(QUOTED_PATCH_FILE_RE)) written.push(belowFolder(unescape(m[1].trim()), cwd));
      }
    }
  }
  // Each file once, at its latest write.
  const filesTouched = [...new Set(written.reverse())];
  return { requests, reply, filesTouched, planFiles: filesTouched.filter((p) => PLAN_FILE_RE.test(p)) };
}

/**
 * The commits an agent made, oldest first, each once: read from what its
 * commit calls returned (a shell running `git commit` prints its summary line).
 * A result cut short shows only its head, so a commit printed past it is not
 * seen.
 */
export function transcriptCommits(events: readonly TurnEvent[]): TranscriptCommit[] {
  // Only the results of calls that ran a commit: other output can print the same shape.
  const committing = new Set(events.flatMap((e) => (e.kind === 'tool_use' && /\bcommit\b/.test(e.input?.inline ?? e.argSummary) ? [e.toolUseId] : [])));
  const out = new Map<string, TranscriptCommit>();
  for (const e of events) {
    if (e.folded || e.kind !== 'tool_result' || !e.ok || !e.output?.inline || !committing.has(e.toolUseId)) continue;
    for (const m of e.output.inline.matchAll(COMMIT_LINE_RE)) {
      const sha = m[1].slice(0, 7);
      if (!out.has(sha)) out.set(sha, { sha, subject: m[2].trim() });
    }
  }
  return [...out.values()];
}

/** The first `max` characters, never ending on half of a surrogate pair. */
function first(text: string, max: number): string {
  const s = text.trim();
  if (s.length <= max) return s;
  const end = /[\uD800-\uDBFF]/.test(s.charAt(max - 1)) ? max - 1 : max;
  return `${s.slice(0, end).trimEnd()}…`;
}

/** The last `max` characters, never starting on half of a surrogate pair. */
function last(text: string, max: number): string {
  const s = text.trim();
  if (s.length <= max) return s;
  const start = /[\uDC00-\uDFFF]/.test(s.charAt(s.length - max)) ? s.length - max + 1 : s.length - max;
  return `…${s.slice(start).trimStart()}`;
}

const counts = (f: DiffNumstat): string => (f.additions === null ? 'bin' : `+${f.additions} −${f.deletions ?? 0}`);

/** "a.ts (+3 −1), b.ts, …and 2 more": the files `touched` names (the latest
 *  first) with their line counts from `changed`, or `changed` itself when
 *  `touched` is empty; null when both are. Whether it came from `touched`. */
function fileList(touched: readonly string[], changed: readonly DiffNumstat[]): { text: string; touched: boolean } | null {
  if (!touched.length && !changed.length) return null;
  const byPath = new Map(changed.map((f) => [f.path, f]));
  const named = touched.length
    ? touched.map((p) => { const f = byPath.get(p); return f ? `${p} (${counts(f)})` : p; })
    : changed.map((f) => `${f.path} (${counts(f)})`);
  const shown = named.slice(0, NOTE_FILES_MAX).join(', ');
  const more = named.length > NOTE_FILES_MAX ? `, ${t('usageLimit.handoffMoreFiles', { count: named.length - NOTE_FILES_MAX })}` : '';
  return { text: `${shown}${more}`, touched: touched.length > 0 };
}

/** Masked whole before it is cut, so a cut never leaves part of a key unrecognised. */
const quote = (text: string, max: number, from: typeof first) => from(redactSecrets(text), max);

/**
 * The note typed into the agent taking over `fromAgent`'s work: where and on
 * which branch, what was asked (the first request and the latest), the end of
 * the last reply, the files touched, the latest first (with their uncommitted
 * line counts; the uncommitted files when the transcript names none), the transcript, and the
 * unsent draft when the owner chose to carry it. Free text is masked for keys
 * and tokens.
 */
export function handoffNoteText(fromAgent: string, facts: Partial<HandoffFacts> | null, opts: { carryDraft?: boolean } = {}): string {
  const place = facts?.repo || t('handoff.note.thisFolder');
  const lines = [facts?.branch
    ? t('handoff.note.headBranch', { agent: fromAgent, place, branch: facts.branch })
    : t('handoff.note.head', { agent: fromAgent, place })];
  const requests = (facts?.requests ?? []).filter((r) => r.trim());
  if (requests.length) lines.push(t('handoff.note.asked', { text: quote(requests[0], NOTE_REQUEST_MAX, first) }));
  if (requests.length > 1) lines.push(t('handoff.note.latest', { text: quote(requests[requests.length - 1], NOTE_REQUEST_MAX, first) }));
  if (facts?.reply?.trim()) lines.push(t('handoff.note.reply', { text: quote(facts.reply, NOTE_REPLY_MAX, last) }));

  const files = fileList(facts?.filesTouched ?? [], facts?.files ?? []);
  if (files) lines.push(t(files.touched ? 'handoff.note.filesTouched' : 'handoff.note.filesChanged', { files: files.text }));
  if (facts?.transcriptPath) lines.push(t('handoff.note.transcript', { path: facts.transcriptPath }));
  lines.push(t('handoff.note.carryOn'));
  if (opts.carryDraft && facts?.draft?.trim()) lines.push(t('handoff.note.draft', { text: quote(facts.draft, NOTE_DRAFT_MAX, first) }));
  return lines.join('\n');
}

/**
 * The note typed back into the tab a handoff left from, once its limit has
 * reset: what `byAgent` did with the work there, from its own transcript.
 * Where and on which branch, the latest request the owner sent there, the
 * commits it made, the files it wrote (with their line counts since the
 * handoff), the end of its last reply, and its transcript. Free text is
 * masked for keys and tokens.
 */
export function bringBackNoteText(byAgent: string, facts: Partial<BringBackFacts> | null): string {
  const place = facts?.repo || t('handoff.note.thisFolder');
  const lines = [facts?.branch
    ? t('handoff.back.headBranch', { agent: byAgent, place, branch: facts.branch })
    : t('handoff.back.head', { agent: byAgent, place })];
  const requests = (facts?.requests ?? []).filter((r) => r.trim());
  if (requests.length) lines.push(t('handoff.back.asked', { text: quote(requests[requests.length - 1], NOTE_REQUEST_MAX, first) }));
  const commits = facts?.commits ?? [];
  if (commits.length) {
    const named = commits.slice(-NOTE_COMMITS_MAX).map((c) => `${c.sha} ${quote(c.subject, NOTE_COMMIT_SUBJECT_MAX, first)}`);
    const more = commits.length > NOTE_COMMITS_MAX ? `, ${t('usageLimit.handoffMoreFiles', { count: commits.length - NOTE_COMMITS_MAX })}` : '';
    lines.push(t('handoff.back.commits', { commits: `${named.join(', ')}${more}` }));
  }
  const files = fileList(facts?.filesTouched ?? [], facts?.files ?? []);
  if (files) lines.push(t(files.touched ? 'handoff.note.filesTouched' : 'handoff.back.filesChanged', { files: files.text }));
  if (facts?.reply?.trim()) lines.push(t('handoff.note.reply', { text: quote(facts.reply, NOTE_REPLY_MAX, last) }));
  if (facts?.transcriptPath) lines.push(t('handoff.note.transcript', { path: facts.transcriptPath }));
  lines.push(t('handoff.note.carryOn'));
  return lines.join('\n');
}
