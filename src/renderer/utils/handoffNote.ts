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
  /** Files the agent wrote or patched, oldest first, below the folder when they are inside it. */
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

/** A tool that writes files: Claude Code's Write/Edit/MultiEdit/NotebookEdit,
 *  Codex's apply_patch, Gemini's and Qwen's write_file/replace. Read-only
 *  tools also take a `file_path`, so the name decides. */
const WRITE_TOOL_RE = /write|edit|replace|patch/i;
/** A written path: a `file_path`/`notebook_path`/`filePath` argument, or a
 *  Codex patch's file header. */
const WRITTEN_PATH_RE = /"(?:file_path|notebook_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)+)"|^\*\*\* (?:Add|Update) File: (.+)$/gm;
/** A plan or todo file: under a plans/todos folder, or named for one. */
const PLAN_FILE_RE = /(?:^|[\\/])(?:plans?|todos?)[\\/][^\\/]+$|(?:^|[\\/])[^\\/]*(?:plan|todo)[^\\/]*\.(?:md|txt)$/i;

/** `path` below `cwd` when it is inside it, else as given. */
function belowFolder(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const base = cwd.replace(/[\\/]+$/, '');
  if (!base) return path;
  // A Windows drive letter is case-insensitive; a POSIX path is not.
  const inside = /^[A-Za-z]:/.test(base) ? path.toLowerCase().startsWith(base.toLowerCase()) : path.startsWith(base);
  const sep = path.charAt(base.length);
  return inside && (sep === '/' || sep === '\\') && path.length > base.length + 1 ? path.slice(base.length + 1) : path;
}

/**
 * The owner's requests, the agent's last reply and the files it wrote, from
 * a transcript's events in file order (several pages joined, oldest first).
 * wmux's own continue message (sent at a usage-limit reset) is not a request.
 * Paths are given below `cwd` when they are inside it.
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
    } else if (e.kind === 'tool_use' && e.input?.inline && WRITE_TOOL_RE.test(e.name)) {
      for (const m of e.input.inline.matchAll(WRITTEN_PATH_RE)) {
        written.push(belowFolder(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2].trim(), cwd));
      }
    }
  }
  const filesTouched = [...new Set(written)];
  return { requests, reply, filesTouched, planFiles: filesTouched.filter((p) => PLAN_FILE_RE.test(p)) };
}

function first(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function last(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `…${s.slice(-max).trimStart()}` : s;
}

const counts = (f: DiffNumstat): string => (f.additions === null ? 'bin' : `+${f.additions} −${f.deletions ?? 0}`);

/**
 * The note typed into the agent taking over `fromAgent`'s work: where and on
 * which branch, what was asked (the first request and the latest), the end of
 * the last reply, the files touched (with their uncommitted line counts; the
 * uncommitted files when the transcript names none), the transcript, and the
 * unsent draft when the owner chose to carry it. Free text is masked for keys
 * and tokens.
 */
export function handoffNoteText(fromAgent: string, facts: Partial<HandoffFacts> | null, opts: { carryDraft?: boolean } = {}): string {
  const place = facts?.repo || t('handoff.note.thisFolder');
  const lines = [facts?.branch
    ? t('handoff.note.headBranch', { agent: fromAgent, place, branch: facts.branch })
    : t('handoff.note.head', { agent: fromAgent, place })];
  const quote = (text: string, max: number, from: typeof first) => redactSecrets(from(text, max));

  const requests = (facts?.requests ?? []).filter((r) => r.trim());
  if (requests.length) lines.push(t('handoff.note.asked', { text: quote(requests[0], NOTE_REQUEST_MAX, first) }));
  if (requests.length > 1) lines.push(t('handoff.note.latest', { text: quote(requests[requests.length - 1], NOTE_REQUEST_MAX, first) }));
  if (facts?.reply?.trim()) lines.push(t('handoff.note.reply', { text: quote(facts.reply, NOTE_REPLY_MAX, last) }));

  const changed = facts?.files ?? [];
  const touched = facts?.filesTouched ?? [];
  if (touched.length || changed.length) {
    const byPath = new Map(changed.map((f) => [f.path, f]));
    const named = touched.length
      ? touched.map((p) => { const f = byPath.get(p); return f ? `${p} (${counts(f)})` : p; })
      : changed.map((f) => `${f.path} (${counts(f)})`);
    const shown = named.slice(-NOTE_FILES_MAX).join(', ');
    const more = named.length > NOTE_FILES_MAX ? `, ${t('usageLimit.handoffMoreFiles', { count: named.length - NOTE_FILES_MAX })}` : '';
    lines.push(t(touched.length ? 'handoff.note.filesTouched' : 'handoff.note.filesChanged', { files: `${shown}${more}` }));
  }
  if (facts?.transcriptPath) lines.push(t('handoff.note.transcript', { path: facts.transcriptPath }));
  lines.push(t('handoff.note.carryOn'));
  if (opts.carryDraft && facts?.draft?.trim()) lines.push(t('handoff.note.draft', { text: quote(facts.draft, NOTE_DRAFT_MAX, first) }));
  return lines.join('\n');
}
