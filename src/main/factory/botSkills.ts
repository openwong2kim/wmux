// ─── Bot skills store — each bot's own procedures (shared/botSkill.ts) ──────
//
// One folder per skill under the bot's own folder (BotRuntime.botCwd):
//
//   <wmuxDir>/factory/bots/<botId>/skills/<name>/
//     SKILL.md, references/        the approved version — the only one read
//                                  for a wake, skill_read or a worker
//     proposed/                    the version waiting for the owner
//     denied/<hash>/               the last few proposals the owner denied
//
// Each skill's state and the content hash of each version (the approved
// one, the proposed one) are kept by main in `<wmuxDir>/factory/
// bot-skills.json` (BOT_SKILLS_FILENAME), which only this store writes. The
// skill folder holds files only. Every load (a wake's index, skill_read, a
// worker's copy, the baseline of an update's diff) reads the files, hashes
// them and uses them only when the hash is the one main recorded at the
// owner's Approve; otherwise the skill does not load and the profile says
// it changed since approval.
//
// Every path is built here from a checked bot id and a checked skill name;
// nothing a caller sends is ever a path. A folder or file that is a symlink,
// or that resolves outside the bot's skills folder, is refused on read and
// on write. A proposal is written into a fresh folder and renamed into
// place, so a write never goes through anything that was already there.
//
// The approved version and a proposal sit side by side: proposing never
// touches what loads. The owner's Approve (an approval card, action `skill`)
// moves the proposal whose hash the card carries into place; Deny moves it
// to denied/.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { BOT_ID_RE } from '../../shared/bot';
import { assertNotLiveWmuxPath } from '../../shared/constants';
import { readVersionedFile } from './versionedFile';
import { redactStoredSecrets } from './secretRedaction';
import {
  SKILL_LIMITS,
  SKILL_NAME_RE,
  SKILL_REFERENCE_NAME_RE,
  WORKER_SKILLS_EXCLUDE_LINE,
  parseSkillFrontmatter,
  serializeSkillFrontmatter,
  skillVersionNewer,
  workerSkillDirName,
  workerSkillFile,
  type BotSkillView,
  type SkillIndexEntry,
  type SkillReferenceInput,
  type SkillState,
} from '../../shared/botSkill';

/** Main's record of every bot's skills, under `<wmuxDir>/factory/`. */
export const BOT_SKILLS_FILENAME = 'bot-skills.json';
const SKILLS_FILE_VERSION = 1;
const SKILL_FILE = 'SKILL.md';
const REFERENCES_DIR = 'references';
const PROPOSED_DIR = 'proposed';
const DENIED_DIR = 'denied';
/** Denied proposals kept per skill. */
const DENIED_KEEP = 3;
/** A diff of more lines than this per side is shown as the new text. */
const DIFF_MAX_LINES = 600;

export type SkillRefusalCode = 'invalid' | 'not_found' | 'unsafe_path' | 'too_many' | 'too_large' | 'unchanged' | 'stale' | 'changed' | 'write_failed';

export interface SkillRefusal {
  ok: false;
  code: SkillRefusalCode;
  message: string;
}

function refuse(code: SkillRefusalCode, message: string): SkillRefusal {
  return { ok: false, code, message };
}

interface VersionMeta {
  hash: string;
  version: string;
  description: string;
  at: number;
}

/** One skill as main records it (BOT_SKILLS_FILENAME). */
interface SkillMeta {
  version: 1;
  name: string;
  state: SkillState;
  approved?: VersionMeta;
  proposed?: VersionMeta & { approvalId?: string; reason: string };
  createdAt: number;
  updatedAt: number;
}

/** One version's files, as written and hashed. */
interface SkillFiles {
  content: string;
  references: SkillReferenceInput[];
}

export interface SkillProposal {
  ok: true;
  skill: BotSkillView;
  /** The proposal's content hash: the owner's card approves this one. */
  hash: string;
  version: string;
  description: string;
  /** The skill is approved (not archived): this one would replace it. */
  update: boolean;
  /** What changes against the approved version (or the whole new skill). */
  diff: string;
  /** The same proposal was already waiting: nothing was written. */
  duplicate?: true;
  /** Its card, when the proposal already had one. */
  approvalId?: string;
  /** A different proposal waited and was replaced: its card is moot. */
  replacedApprovalId?: string;
}

/** A checked proposal not yet written (prepareProposal → writeProposal). */
export interface PreparedProposal extends SkillProposal {
  readonly prepared: { name: string; files: SkillFiles; reason: string; meta: SkillMeta | null; changed: boolean };
}

export interface ApprovedSkill {
  name: string;
  files: SkillFiles;
}

/** `<wmuxDir>/factory/bots/<botId>/skills` (BotRuntime.botCwd + skills). */
export function botSkillsRoot(wmuxDir: string, botId: string): string {
  return path.join(wmuxDir, 'factory', 'bots', botId, 'skills');
}

/** sha256 over one JSON document of SKILL.md and every reference, in
 *  code-unit name order (the same on every machine and locale): each file
 *  is a quoted JSON string, so the boundaries between files are part of
 *  what is hashed. Pure. */
export function skillHash(files: SkillFiles): string {
  const references = [...files.references]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => ({ name: r.name, content: r.content }));
  return createHash('sha256').update(JSON.stringify({ v: 1, content: files.content, references })).digest('hex');
}

/** Characters a skill's text never holds: C0 and C1 controls (tab and
 *  newline are text) and the bidirectional overrides and isolates, so the
 *  card shows the text as it reads. */
// eslint-disable-next-line no-control-regex
const SKILL_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/** Remove a folder this store made; a failure leaves a dot-folder that never loads. */
function removeQuietly(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* only SKILL.md and references/ are ever read */
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** A line diff of two texts: `- `, `+ ` and `  ` lines, two lines of context
 *  around each change, `@@ line N` before each hunk. Null when either side
 *  is over DIFF_MAX_LINES after the common head and tail. Pure. */
export function skillLineDiff(before: string, after: string): string | null {
  const a0 = before === '' ? [] : before.split('\n');
  const b0 = after === '' ? [] : after.split('\n');
  let head = 0;
  while (head < a0.length && head < b0.length && a0[head] === b0[head]) head += 1;
  let ta = a0.length;
  let tb = b0.length;
  while (ta > head && tb > head && a0[ta - 1] === b0[tb - 1]) {
    ta -= 1;
    tb -= 1;
  }
  const a = a0.slice(head, ta);
  const b = b0.slice(head, tb);
  if (a.length === 0 && b.length === 0) return '';
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;
  const w = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  // Every line of both texts as one op, so the context comes along.
  const ops: Array<{ k: ' ' | '-' | '+'; line: string; at: number }> = a0.slice(0, head).map((line, i) => ({ k: ' ' as const, line, at: i + 1 }));
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ k: ' ', line: a[i], at: head + j + 1 });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      ops.push({ k: '-', line: a[i], at: head + j + 1 });
      i += 1;
    } else {
      ops.push({ k: '+', line: b[j], at: head + j + 1 });
      j += 1;
    }
  }
  for (let t = tb; t < b0.length; t += 1) ops.push({ k: ' ', line: b0[t], at: t + 1 });
  const keep = new Set<number>();
  ops.forEach((op, n) => {
    if (op.k === ' ') return;
    for (let c = Math.max(0, n - 2); c <= Math.min(ops.length - 1, n + 2); c += 1) keep.add(c);
  });
  const out: string[] = [];
  let last = -2;
  ops.forEach((op, n) => {
    if (!keep.has(n)) return;
    if (n !== last + 1) out.push(`@@ line ${op.at}`);
    out.push(`${op.k} ${op.line}`);
    last = n;
  });
  return out.join('\n');
}

/** SKILL.md as a worker's Claude Code reads it: the front matter written
 *  from its parsed fields, and the body. Null when it does not parse. */
function skillParts(content: string): { head: string; body: string } | null {
  const fm = parseSkillFrontmatter(content);
  return fm.ok ? { head: serializeSkillFrontmatter(fm.frontmatter), body: fm.body } : null;
}

/** The change from one version to another, file by file. SKILL.md shows
 *  its front matter as a worker's Claude Code reads it (the parsed fields,
 *  written again), always whole, apart from its body. Pure. */
export function skillFilesDiff(before: SkillFiles | null, after: SkillFiles): string {
  const parts: string[] = [];
  const one = (file: string, from: string, to: string): void => {
    if (from === to) return;
    const d = skillLineDiff(from, to);
    // Every line carries a prefix, so none can close the card's code fence.
    parts.push(`--- ${file}`, d ?? ['@@ too long to compare; the new text', ...to.split('\n').map((l) => `+ ${l}`)].join('\n'));
  };
  const to = skillParts(after.content);
  if (to) {
    const from = before ? skillParts(before.content) : null;
    // Five lines: a diff of them never runs over DIFF_MAX_LINES.
    const head = from?.head === to.head ? to.head.split('\n').map((l) => `  ${l}`).join('\n') : skillLineDiff(from?.head ?? '', to.head) as string;
    parts.push(`--- ${SKILL_FILE} front matter, as Claude Code reads it`, head);
    one(`${SKILL_FILE} body`, from ? from.body : before?.content ?? '', to.body);
  } else {
    one(SKILL_FILE, before?.content ?? '', after.content);
  }
  const names = new Set([...(before?.references ?? []), ...after.references].map((r) => r.name));
  for (const name of [...names].sort()) {
    const from = before?.references.find((r) => r.name === name)?.content ?? '';
    const to = after.references.find((r) => r.name === name)?.content;
    if (to === undefined) parts.push(`--- ${REFERENCES_DIR}/${name} (removed)`);
    else one(`${REFERENCES_DIR}/${name}`, from, to);
  }
  return parts.join('\n');
}

/** A proposal's files, checked: the front matter (its name is the skill's),
 *  the size limits, the reference names, and no stored secret's value in
 *  them (the secrets held now). */
export function validateSkillProposal(name: unknown, content: unknown, references: unknown): { ok: true; files: SkillFiles; version: string; description: string } | SkillRefusal {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return refuse('invalid', 'name is a lowercase slug (a-z, 0-9, -), at most 64 characters');
  if (typeof content !== 'string' || content.length === 0) return refuse('invalid', 'content is the whole SKILL.md');
  if (Buffer.byteLength(content, 'utf8') > SKILL_LIMITS.BODY_MAX) return refuse('invalid', `SKILL.md is at most ${SKILL_LIMITS.BODY_MAX} bytes`);
  if (redactStoredSecrets(content) !== content) return refuse('invalid', 'SKILL.md holds the value of a stored secret; refer to the secret by its name instead');
  if (SKILL_CONTROL_RE.test(content)) return refuse('invalid', 'SKILL.md is plain text: no control characters other than tab and newline (use \\n line ends)');
  const fm = parseSkillFrontmatter(content);
  if (!fm.ok) return refuse('invalid', fm.error);
  if (fm.frontmatter.name !== name) return refuse('invalid', `the front matter's name (${fm.frontmatter.name}) is not ${name}`);
  if (!fm.body.trim()) return refuse('invalid', 'SKILL.md needs the procedure after its front matter');
  // A dashes-only line in the body reads as a front matter marker to some
  // readers (right after the front matter, as a second block): none is taken.
  if (/^[ \t]*-{3,}[ \t]*$/m.test(fm.body)) return refuse('invalid', 'the procedure holds no line of only dashes (it reads as a front matter marker); use *** for a rule');
  const refs: SkillReferenceInput[] = [];
  if (references !== undefined) {
    if (!Array.isArray(references)) return refuse('invalid', 'references is a list of {name, content}');
    if (references.length > SKILL_LIMITS.REFERENCES_MAX) return refuse('invalid', `at most ${SKILL_LIMITS.REFERENCES_MAX} references`);
    let total = 0;
    for (const r of references as unknown[]) {
      const ref = r as Partial<SkillReferenceInput> | null;
      if (!ref || typeof ref.name !== 'string' || !SKILL_REFERENCE_NAME_RE.test(ref.name)) {
        return refuse('invalid', 'a reference name is a slug ending in .md or .txt (no folder)');
      }
      if (typeof ref.content !== 'string') return refuse('invalid', `reference ${ref.name} needs its content`);
      if (redactStoredSecrets(ref.content) !== ref.content) return refuse('invalid', `reference ${ref.name} holds the value of a stored secret; refer to the secret by its name instead`);
      if (SKILL_CONTROL_RE.test(ref.content)) return refuse('invalid', `reference ${ref.name} is plain text: no control characters other than tab and newline`);
      const bytes = Buffer.byteLength(ref.content, 'utf8');
      if (bytes > SKILL_LIMITS.REFERENCE_MAX) return refuse('invalid', `reference ${ref.name} is over ${SKILL_LIMITS.REFERENCE_MAX} bytes`);
      total += bytes;
      if (refs.some((x) => x.name === ref.name)) return refuse('invalid', `reference ${ref.name} is given twice`);
      refs.push({ name: ref.name, content: ref.content });
    }
    if (total > SKILL_LIMITS.REFERENCES_TOTAL_MAX) return refuse('invalid', `the references together are at most ${SKILL_LIMITS.REFERENCES_TOTAL_MAX} bytes`);
  }
  return { ok: true, files: { content, references: refs }, version: fm.frontmatter.version, description: fm.frontmatter.description };
}

function isMeta(v: unknown, name: string): v is SkillMeta {
  const m = v as SkillMeta | null;
  const ver = (x: unknown): boolean => {
    const r = x as VersionMeta | null;
    return !!r && typeof r === 'object' && typeof r.hash === 'string' && typeof r.version === 'string' && typeof r.description === 'string' && Number.isSafeInteger(r.at);
  };
  return !!m && typeof m === 'object' && m.version === 1 && m.name === name
    && (m.state === 'proposed' || m.state === 'approved' || m.state === 'archived')
    && (m.approved === undefined || ver(m.approved))
    && (m.proposed === undefined || ver(m.proposed))
    && Number.isSafeInteger(m.createdAt) && Number.isSafeInteger(m.updatedAt);
}

function view(m: SkillMeta, changed: boolean): BotSkillView {
  return {
    name: m.name,
    state: m.state,
    ...(m.approved ? { description: m.approved.description, version: m.approved.version, approvedAt: m.approved.at } : {}),
    ...(m.proposed ? {
      proposed: {
        version: m.proposed.version,
        description: m.proposed.description,
        at: m.proposed.at,
        ...(m.proposed.approvalId ? { approvalId: m.proposed.approvalId } : {}),
      },
    } : {}),
    ...(changed ? { changed: true as const } : {}),
    updatedAt: m.updatedAt,
  };
}

/** An approved skill's files, read from disk and found to be the version
 *  the owner approved, with its front matter. */
interface VerifiedSkill {
  files: SkillFiles;
  version: string;
  description: string;
}

export class BotSkillStore {
  private readonly now: () => number;
  private readonly file: string;
  /** botId → name → record: main's own state of every skill. */
  private records = new Map<string, Map<string, SkillMeta>>();

  /** Throws when main's record file exists but cannot be read (the skills
   *  module then stays off rather than guess). */
  constructor(private readonly opts: { wmuxDir: string; now?: () => number; writeRecord?: (file: string, data: unknown) => void }) {
    this.now = opts.now ?? Date.now;
    this.file = path.join(opts.wmuxDir, 'factory', BOT_SKILLS_FILENAME);
    assertNotLiveWmuxPath(this.file);
    const raw = readVersionedFile(this.file, SKILLS_FILE_VERSION);
    const bots = raw?.bots;
    if (bots && typeof bots === 'object' && !Array.isArray(bots)) {
      // Per bot, a list of records: a skill name is never an object key.
      for (const [botId, skills] of Object.entries(bots as Record<string, unknown>)) {
        if (!BOT_ID_RE.test(botId) || !Array.isArray(skills)) continue;
        const map = new Map<string, SkillMeta>();
        for (const rec of skills as unknown[]) {
          const name = (rec as { name?: unknown } | null)?.name;
          if (typeof name === 'string' && SKILL_NAME_RE.test(name) && isMeta(rec, name)) map.set(name, rec);
        }
        if (map.size > 0) this.records.set(botId, map);
      }
    }
  }

  // ── main's record ──

  private record(botId: string, name: string): SkillMeta | null {
    return this.records.get(botId)?.get(name) ?? null;
  }

  /** Set (or with null drop) one record and write the file; undone in
   *  memory when it did not reach the file. */
  private commit(botId: string, name: string, rec: SkillMeta | null): boolean {
    const before = this.record(botId, name);
    const set = (r: SkillMeta | null): void => {
      let map = this.records.get(botId);
      if (r) {
        if (!map) {
          map = new Map();
          this.records.set(botId, map);
        }
        map.set(name, r);
      } else if (map) {
        map.delete(name);
        if (map.size === 0) this.records.delete(botId);
      }
    };
    set(rec);
    if (this.save()) return true;
    set(before);
    return false;
  }

  /** Write every record to main's file; false when it did not land. */
  private save(): boolean {
    try {
      const bots: Record<string, SkillMeta[]> = {};
      for (const [id, map] of this.records) bots[id] = [...map.values()];
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      (this.opts.writeRecord ?? atomicWriteJSONSync)(this.file, { version: SKILLS_FILE_VERSION, bots });
      return true;
    } catch {
      return false;
    }
  }

  // ── paths ──

  /** The bot's skills folder, made when `create`; null when the bot id is
   *  not one, or a folder on the way is a symlink or leaves the bots folder. */
  private root(botId: string, create: boolean): string | null {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return null;
    const bots = path.join(this.opts.wmuxDir, 'factory', 'bots');
    const botDir = path.join(bots, botId);
    const root = path.join(botDir, 'skills');
    for (const p of [botDir, root]) {
      const st = lstatOrNull(p);
      if (st && !st.isDirectory()) return null;
    }
    if (!lstatOrNull(root)) {
      if (!create) return root;
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    try {
      if (!isInside(fs.realpathSync.native(root), fs.realpathSync.native(bots))) return null;
    } catch {
      return null;
    }
    return root;
  }

  /** One skill's folder: a real folder inside the root, or absent. */
  private skillDir(botId: string, name: unknown, create: boolean): { dir: string } | SkillRefusal {
    if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return refuse('invalid', 'name is a lowercase slug (a-z, 0-9, -)');
    let root: string | null;
    try {
      root = this.root(botId, create);
    } catch (err) {
      return refuse('write_failed', `the skills folder could not be made: ${String(err)}`);
    }
    if (!root) return refuse('unsafe_path', 'this bot\'s skills folder is not a plain folder of its own');
    const dir = path.join(root, name);
    const st = lstatOrNull(dir);
    if (st && !st.isDirectory()) return refuse('unsafe_path', `skill ${name} is not a plain folder`);
    if (st) {
      try {
        if (!isInside(fs.realpathSync.native(dir), fs.realpathSync.native(root))) return refuse('unsafe_path', `skill ${name} leaves the skills folder`);
      } catch {
        return refuse('unsafe_path', `skill ${name} could not be resolved`);
      }
    }
    return { dir };
  }

  /** A file inside `dir` that is a plain file (never a symlink), or null. */
  private readPlain(dir: string, rel: string): string | null {
    const file = path.join(dir, rel);
    if (!isInside(file, dir)) return null;
    let p = dir;
    for (const seg of rel.split('/')) {
      p = path.join(p, seg);
      const st = lstatOrNull(p);
      if (!st || st.isSymbolicLink()) return null;
    }
    const st = lstatOrNull(file);
    if (!st || !st.isFile() || st.size > SKILL_LIMITS.BODY_MAX + SKILL_LIMITS.REFERENCES_TOTAL_MAX) return null;
    return fs.readFileSync(file, 'utf8');
  }

  /** A version's files from `dir` (the skill folder or proposed/), or null
   *  when SKILL.md is missing or anything there is not a plain file. */
  private readVersion(dir: string): SkillFiles | null {
    try {
      const top = lstatOrNull(dir);
      if (!top || !top.isDirectory() || top.isSymbolicLink()) return null;
      const content = this.readPlain(dir, SKILL_FILE);
      if (content === null) return null;
      const references: SkillReferenceInput[] = [];
      const refDir = path.join(dir, REFERENCES_DIR);
      const st = lstatOrNull(refDir);
      if (st) {
        if (!st.isDirectory()) return null;
        for (const name of fs.readdirSync(refDir).sort()) {
          if (!SKILL_REFERENCE_NAME_RE.test(name)) continue;
          const text = this.readPlain(dir, `${REFERENCES_DIR}/${name}`);
          if (text === null) return null;
          references.push({ name, content: text });
        }
      }
      return { content, references };
    } catch {
      return null;
    }
  }

  /** The approved version of `name` as it is on disk, when its hash is the
   *  one main recorded at the owner's Approve; null otherwise. The files
   *  returned are the bytes that were hashed (never read again). */
  private verified(botId: string, name: string, rec: SkillMeta | null): VerifiedSkill | null {
    if (!rec || rec.state !== 'approved' || !rec.approved) return null;
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return null;
    const files = this.readVersion(d.dir);
    if (!files || skillHash(files) !== rec.approved.hash) return null;
    const fm = parseSkillFrontmatter(files.content);
    if (!fm.ok || fm.frontmatter.name !== name) return null;
    return { files, version: fm.frontmatter.version, description: fm.frontmatter.description };
  }

  /** Write a version into a fresh folder under `dir` (never through what is there). */
  private writeFresh(dir: string, files: SkillFiles): string {
    const tmp = fs.mkdtempSync(path.join(dir, '.tmp-'));
    fs.writeFileSync(path.join(tmp, SKILL_FILE), files.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (files.references.length > 0) {
      fs.mkdirSync(path.join(tmp, REFERENCES_DIR), { mode: 0o700 });
      for (const r of files.references) {
        fs.writeFileSync(path.join(tmp, REFERENCES_DIR, r.name), r.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      }
    }
    return tmp;
  }

  // ── reads ──

  private names(botId: string): string[] {
    return [...(this.records.get(botId)?.keys() ?? [])].sort();
  }

  /** The bot's skills, by name. An approved skill whose files on disk are
   *  not the approved version is `changed`. Never throws. */
  list(botId: string): BotSkillView[] {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return [];
    return this.names(botId).map((name) => {
      const rec = this.record(botId, name) as SkillMeta;
      const changed = rec.state === 'approved' && !this.verified(botId, name, rec);
      return view(rec, changed);
    });
  }

  /** What a wake lists: each approved skill whose files are the approved
   *  version, with the description from those files. */
  index(botId: string): SkillIndexEntry[] {
    return this.verifiedAll(botId).map((s) => ({ name: s.name, description: s.description }));
  }

  private verifiedAll(botId: string): Array<VerifiedSkill & { name: string }> {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return [];
    const out: Array<VerifiedSkill & { name: string }> = [];
    for (const name of this.names(botId)) {
      const v = this.verified(botId, name, this.record(botId, name));
      if (v) out.push({ name, ...v });
    }
    return out;
  }

  /** Where the version approved with content `hash` stands now: loaded,
   *  archived by the owner, changed on disk since, or replaced by another
   *  approved version. Null when the store has no such skill. */
  approvalStatus(botId: string, name: string, hash: string): 'loaded' | 'archived' | 'changed' | 'replaced' | null {
    const rec = typeof botId === 'string' && BOT_ID_RE.test(botId) && typeof name === 'string' ? this.record(botId, name) : null;
    if (!rec?.approved) return null;
    if (rec.state === 'archived') return 'archived';
    if (rec.state !== 'approved') return null;
    if (rec.approved.hash !== hash) return 'replaced';
    return this.verified(botId, name, rec) ? 'loaded' : 'changed';
  }

  /** The skills the owner archived after approving them: no longer loaded,
   *  and the wake says so (an earlier message may still cite them). */
  archivedNames(botId: string): string[] {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return [];
    return this.names(botId).filter((name) => {
      const rec = this.record(botId, name);
      return rec?.state === 'archived' && !!rec.approved;
    });
  }

  /** The approved version of every approved skill (for a worker's copy). */
  approved(botId: string): ApprovedSkill[] {
    return this.verifiedAll(botId).map((s) => ({ name: s.name, files: s.files }));
  }

  /** `skill_read`: an approved skill's SKILL.md and its reference names, or
   *  one reference; with no name, the list of approved skills. A proposal
   *  is never read. */
  read(botId: string, name?: unknown, reference?: unknown):
    | { ok: true; name: string; version: string; content: string; references: string[] }
    | { ok: true; skills: Array<SkillIndexEntry & { version: string }> }
    | SkillRefusal {
    if (name === undefined) {
      if (reference !== undefined) return refuse('invalid', 'a reference is read with the name of its skill');
      return { ok: true, skills: this.verifiedAll(botId).map((s) => ({ name: s.name, description: s.description, version: s.version })) };
    }
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const skill = name as string;
    const rec = this.record(botId, skill);
    if (!rec || rec.state !== 'approved' || !rec.approved) return refuse('not_found', `no approved skill ${skill}`);
    const v = this.verified(botId, skill, rec);
    if (!v) return refuse('changed', `skill ${skill} on disk is not the version the owner approved, so it does not load; propose it again with skill_propose`);
    const references = v.files.references.map((r) => r.name);
    if (reference !== undefined) {
      if (typeof reference !== 'string' || !SKILL_REFERENCE_NAME_RE.test(reference)) return refuse('invalid', 'reference is a reference file name');
      const ref = v.files.references.find((r) => r.name === reference);
      if (!ref) return refuse('not_found', `skill ${skill} has no reference ${reference}`);
      return { ok: true, name: skill, version: v.version, content: ref.content, references };
    }
    return { ok: true, name: skill, version: v.version, content: v.files.content, references };
  }

  // ── writes ──

  /** `skill_propose`: write a proposed version of a skill (an update when
   *  the skill exists). Never changes the approved version. */
  propose(botId: string, raw: { name?: unknown; content?: unknown; references?: unknown; reason?: unknown }): SkillProposal | SkillRefusal {
    const prep = this.prepareProposal(botId, raw);
    if (!prep.ok || prep.duplicate) return prep;
    return this.writeProposal(botId, prep);
  }

  /** A proposal checked and diffed, nothing written: the skills module
   *  posts its approval card first and writes it only once the card is up,
   *  so a refused card leaves the proposal waiting before it as it was.
   *  `duplicate` when the same proposal already waits on disk. */
  prepareProposal(botId: string, raw: { name?: unknown; content?: unknown; references?: unknown; reason?: unknown }): PreparedProposal | SkillRefusal {
    const checked = validateSkillProposal(raw.name, raw.content, raw.references);
    if (!checked.ok) return checked;
    const name = raw.name as string;
    const reason = typeof raw.reason === 'string' ? raw.reason.replace(/\s+/g, ' ').trim().slice(0, SKILL_LIMITS.REASON_MAX) : '';
    if (!reason) return refuse('invalid', 'reason is required (one line: what you learned, and from what)');
    const d = this.skillDir(botId, name, true);
    if (!('dir' in d)) return d;
    const meta = this.record(botId, name);
    if (!meta && this.names(botId).length >= SKILL_LIMITS.PER_BOT) return refuse('too_many', `a bot keeps at most ${SKILL_LIMITS.PER_BOT} skills; update one of yours instead`);
    const hash = skillHash(checked.files);
    // The diff's baseline is the approved version only when its files are
    // the ones the owner approved; otherwise the whole proposal is new.
    const baseline = this.verified(botId, name, meta);
    if (baseline && meta?.approved?.hash === hash) return refuse('unchanged', `skill ${name} ${baseline.version} is already approved with this content`);
    if (baseline && meta?.approved && !skillVersionNewer(checked.version, meta.approved.version)) {
      return refuse('invalid', `an update of ${name} takes a version newer than ${meta.approved.version}`);
    }
    const shown = skillFilesDiff(baseline?.files ?? null, checked.files);
    const diff = meta?.state === 'approved' && !baseline
      ? `@@ the approved version on disk is not the one approved; the whole proposal is shown\n${shown}`
      : shown;
    if (diff.length > SKILL_LIMITS.DIFF_MAX) {
      return refuse('too_large', `the change is ${diff.length} characters and the owner's card shows at most ${SKILL_LIMITS.DIFF_MAX}, all of it; propose a shorter skill or a smaller change (split a long one into two skills)`);
    }
    const changed = meta?.state === 'approved' && !baseline;
    const out = {
      ok: true as const, hash, version: checked.version, description: checked.description, update: meta?.state === 'approved', diff,
      prepared: { name, files: checked.files, reason, meta, changed },
    };
    if (meta?.proposed?.hash === hash) {
      const onDisk = this.readVersion(path.join(d.dir, PROPOSED_DIR));
      if (onDisk && skillHash(onDisk) === hash) {
        return { ...out, skill: view(meta, changed), duplicate: true, ...(meta.proposed.approvalId ? { approvalId: meta.proposed.approvalId } : {}) };
      }
    }
    return { ...out, skill: meta ? view(meta, changed) : { name, state: 'proposed', updatedAt: this.now() } };
  }

  /** Write a prepared proposal into proposed/ and record it. Refused as
   *  stale when the skill's record changed since it was prepared. */
  writeProposal(botId: string, prep: PreparedProposal): SkillProposal | SkillRefusal {
    const { name, files, reason, meta, changed } = prep.prepared;
    const hash = prep.hash;
    if (this.record(botId, name) !== meta) return refuse('stale', `skill ${name} changed while this proposal was prepared; propose it again`);
    const d = this.skillDir(botId, name, true);
    if (!('dir' in d)) return d;
    const proposedDir = path.join(d.dir, PROPOSED_DIR);
    const at = this.now();
    const next: SkillMeta = {
      version: 1,
      name,
      state: meta?.state ?? 'proposed',
      ...(meta?.approved ? { approved: meta.approved } : {}),
      proposed: { hash, version: prep.version, description: prep.description, at, reason },
      createdAt: meta?.createdAt ?? at,
      updatedAt: at,
    };
    let tmp: string | null = null;
    // The proposal waiting so far is set aside until the record is written,
    // so a failed write leaves it and its record as they were.
    const aside = path.join(d.dir, `.prev-${hash.slice(0, 12)}`);
    let setAside = false;
    try {
      if (!lstatOrNull(d.dir)) fs.mkdirSync(d.dir, { mode: 0o700 });
      tmp = this.writeFresh(d.dir, files);
      // rmSync on a symlink removes the link, never what it points at.
      fs.rmSync(aside, { recursive: true, force: true });
      if (lstatOrNull(proposedDir)) {
        fs.renameSync(proposedDir, aside);
        setAside = true;
      }
      fs.renameSync(tmp, proposedDir);
      tmp = null;
    } catch (err) {
      removeQuietly(tmp);
      try {
        if (setAside && !lstatOrNull(proposedDir)) fs.renameSync(aside, proposedDir);
      } catch {
        /* the record still names the earlier proposal's hash: approve checks it */
      }
      return refuse('write_failed', `skill ${name} could not be written: ${String(err)}`);
    }
    if (!this.commit(botId, name, next)) {
      try {
        fs.rmSync(proposedDir, { recursive: true, force: true });
        if (setAside) fs.renameSync(aside, proposedDir);
      } catch {
        /* the record still names the earlier proposal's hash: approve checks it */
      }
      return refuse('write_failed', `skill ${name} could not be recorded`);
    }
    if (setAside) removeQuietly(aside);
    return {
      ok: true, skill: view(next, changed), hash, version: prep.version, description: prep.description, update: prep.update, diff: prep.diff,
      ...(meta?.proposed?.approvalId ? { replacedApprovalId: meta.proposed.approvalId } : {}),
    };
  }

  /** Every bot that has a skill record. */
  botIds(): string[] {
    return [...this.records.keys()];
  }

  /** The bot was deleted: its records go, then its skills folder (a
   *  plain folder of its own; the bot's folder itself is kept). */
  removeBot(botId: string): boolean {
    if (typeof botId !== 'string' || !BOT_ID_RE.test(botId)) return false;
    const before = this.records.get(botId);
    if (before) {
      this.records.delete(botId);
      if (!this.save()) {
        this.records.set(botId, before);
        return false;
      }
    }
    let root: string | null = null;
    try {
      root = this.root(botId, false);
    } catch {
      root = null;
    }
    if (root && lstatOrNull(root)?.isDirectory()) fs.rmSync(root, { recursive: true, force: true });
    return true;
  }

  /** Every waiting proposal that has an approval card, for the skills
   *  module's start (its card may have been decided while it was off). */
  waitingProposals(): Array<{ botId: string; name: string; hash: string; approvalId: string }> {
    const out: Array<{ botId: string; name: string; hash: string; approvalId: string }> = [];
    for (const [botId, map] of this.records) {
      for (const rec of map.values()) {
        if (rec.proposed?.approvalId) out.push({ botId, name: rec.name, hash: rec.proposed.hash, approvalId: rec.proposed.approvalId });
      }
    }
    return out;
  }

  /** The proposal `hash` now has its approval card. */
  attachApproval(botId: string, name: string, hash: string, approvalId: string): boolean {
    const meta = this.record(botId, name);
    if (!meta?.proposed || meta.proposed.hash !== hash) return false;
    return this.commit(botId, name, { ...meta, proposed: { ...meta.proposed, approvalId }, updatedAt: this.now() });
  }

  /** The owner approved the proposal `hash`: it becomes the approved
   *  version, and main records its hash. A proposal that changed since the
   *  card was posted is refused. */
  approve(botId: string, name: string, hash: string): { ok: true; skill: BotSkillView } | SkillRefusal {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const meta = this.record(botId, name);
    if (!meta?.proposed || meta.proposed.hash !== hash) return refuse('stale', `the proposal of ${name} on this card is no longer the one waiting`);
    const proposedDir = path.join(d.dir, PROPOSED_DIR);
    const files = this.readVersion(proposedDir);
    if (!files || skillHash(files) !== hash) return refuse('stale', `the proposal of ${name} on disk is not the one on the card`);
    const fm = parseSkillFrontmatter(files.content);
    if (!fm.ok || fm.frontmatter.name !== name) return refuse('stale', `the proposal of ${name} on disk is not the one on the card`);
    const live = path.join(d.dir, SKILL_FILE);
    const liveRefs = path.join(d.dir, REFERENCES_DIR);
    let tmp: string | null = null;
    let backup: string | null = null;
    // Each entry this approve moved aside, and each it put in place: a
    // rollback undoes exactly those, nothing else.
    const movedAside: string[] = [];
    const placed: string[] = [];
    // Put the earlier approved files back (the proposal stays waiting).
    // Whatever cannot be put back stays unloaded: the record still names
    // the earlier hash, and files that do not match it never load.
    const restore = (): void => {
      for (const n of [...placed].reverse()) removeQuietly(path.join(d.dir, n));
      let whole = true;
      for (const n of [...movedAside].reverse()) {
        try {
          fs.renameSync(path.join(backup as string, n), path.join(d.dir, n));
        } catch {
          whole = false;
        }
      }
      // The backup goes only once everything in it is back in place;
      // otherwise it is the earlier version's copy, and it stays.
      if (whole) removeQuietly(backup);
      else console.warn(`[factory] skill ${name}: the earlier approved files are kept in ${path.basename(backup as string)}`);
    };
    try {
      // The approved SKILL.md and references/ are written from the bytes
      // just hashed, never moved from proposed/.
      tmp = this.writeFresh(d.dir, files);
      backup = fs.mkdtempSync(path.join(d.dir, '.bak-'));
      for (const n of [SKILL_FILE, REFERENCES_DIR]) {
        if (!lstatOrNull(path.join(d.dir, n))) continue;
        fs.renameSync(path.join(d.dir, n), path.join(backup, n));
        movedAside.push(n);
      }
      if (files.references.length > 0) {
        fs.renameSync(path.join(tmp, REFERENCES_DIR), liveRefs);
        placed.push(REFERENCES_DIR);
      }
      fs.renameSync(path.join(tmp, SKILL_FILE), live);
      placed.push(SKILL_FILE);
    } catch (err) {
      restore();
      removeQuietly(tmp);
      return refuse('write_failed', `skill ${name} could not be approved: ${String(err)}`);
    }
    const at = this.now();
    const next: SkillMeta = {
      version: 1, name, state: 'approved',
      approved: { hash, version: fm.frontmatter.version, description: fm.frontmatter.description, at },
      createdAt: meta.createdAt, updatedAt: at,
    };
    removeQuietly(tmp);
    if (!this.commit(botId, name, next)) {
      restore();
      return refuse('write_failed', `skill ${name} could not be recorded as approved`);
    }
    // Leftovers never load: the record names the approved hash.
    removeQuietly(backup);
    removeQuietly(proposedDir);
    return { ok: true, skill: view(next, false) };
  }

  /** The owner denied (or let lapse) the proposal `hash`: it moves to
   *  denied/; a skill never approved is archived. */
  deny(botId: string, name: string, hash: string): { ok: true; skill: BotSkillView } | SkillRefusal {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const meta = this.record(botId, name);
    if (!meta?.proposed || meta.proposed.hash !== hash) return refuse('stale', `the proposal of ${name} on this card is no longer the one waiting`);
    const next: SkillMeta = { ...meta, state: meta.approved ? meta.state : 'archived', updatedAt: this.now() };
    delete next.proposed;
    if (!this.commit(botId, name, next)) return refuse('write_failed', `the proposal of ${name} could not be recorded as denied`);
    try {
      this.shelveProposal(d.dir, hash);
    } catch {
      /* the record no longer names it: it never loads */
    }
    return { ok: true, skill: view(next, next.state === 'approved' && !this.verified(botId, name, next)) };
  }

  /** The owner's Archive: nothing of the skill loads any more, and a
   *  waiting proposal is shelved (its card is moot: `approvalId`). */
  archive(botId: string, name: unknown): { ok: true; skill: BotSkillView; approvalId?: string } | SkillRefusal {
    const d = this.skillDir(botId, name, false);
    if (!('dir' in d)) return d;
    const skill = name as string;
    const meta = this.record(botId, skill);
    if (!meta) return refuse('not_found', `no skill ${skill}`);
    const next: SkillMeta = { ...meta, state: 'archived', updatedAt: this.now() };
    delete next.proposed;
    if (!this.commit(botId, skill, next)) return refuse('write_failed', `skill ${skill} could not be archived`);
    try {
      if (meta.proposed) this.shelveProposal(d.dir, meta.proposed.hash);
    } catch {
      /* the record no longer names it: it never loads */
    }
    return { ok: true, skill: view(next, false), ...(meta.proposed?.approvalId ? { approvalId: meta.proposed.approvalId } : {}) };
  }

  /** proposed/ → denied/<hash>/, keeping the newest DENIED_KEEP. */
  private shelveProposal(dir: string, hash: string): void {
    const proposedDir = path.join(dir, PROPOSED_DIR);
    const st = lstatOrNull(proposedDir);
    if (!st) return;
    if (!st.isDirectory()) {
      fs.rmSync(proposedDir, { force: true });
      return;
    }
    const deniedRoot = path.join(dir, DENIED_DIR);
    const rs = lstatOrNull(deniedRoot);
    if (rs && !rs.isDirectory()) fs.rmSync(deniedRoot, { force: true });
    fs.mkdirSync(deniedRoot, { recursive: true, mode: 0o700 });
    const target = path.join(deniedRoot, hash.slice(0, 16));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(proposedDir, target);
    const kept = fs.readdirSync(deniedRoot)
      .map((n) => ({ n, at: lstatOrNull(path.join(deniedRoot, n))?.mtimeMs ?? 0 }))
      .sort((a, b) => b.at - a.at);
    for (const old of kept.slice(DENIED_KEEP)) fs.rmSync(path.join(deniedRoot, old.n), { recursive: true, force: true });
  }
}

// ── A worker's copy ─────────────────────────────────────────────────────────

/** Runs git in the worktree; never throws. */
export type SkillGitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Copy the bot's approved skills into a worker's worktree as
 *  `.claude/skills/bot-<name>/` (SKILL.md's front matter written again from
 *  its parsed fields: workerSkillFile), after adding WORKER_SKILLS_EXCLUDE_LINE to
 *  the worktree's `info/exclude` (`git rev-parse --git-path`, the common
 *  one for a linked worktree) so they are never committed. Nothing is copied
 *  when the exclude cannot be written, and a folder already there (one the
 *  repository holds) is left alone. Once copied, every file is checked with
 *  `git check-ignore`: when the repository's own ignore rules would let any
 *  of them into git, the files and folders this call wrote are removed again
 *  and it throws. Returns the names copied. */
export async function installWorkerSkills(
  skills: readonly ApprovedSkill[],
  worktree: string,
  deps: { git: SkillGitRun; exclude: (file: string, line: string) => Promise<void> },
): Promise<string[]> {
  if (skills.length === 0) return [];
  const r = await deps.git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], worktree);
  const excludeFile = r.stdout.trim();
  if (r.code !== 0 || !excludeFile || !path.isAbsolute(excludeFile)) throw new Error(`info/exclude not found: ${r.stderr.trim().slice(0, 200)}`);
  await deps.exclude(excludeFile, WORKER_SKILLS_EXCLUDE_LINE);
  const claudeDir = path.join(worktree, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  for (const p of [claudeDir, skillsDir]) {
    const st = lstatOrNull(p);
    if (st && !st.isDirectory()) throw new Error(`${path.relative(worktree, p)} is not a plain folder`);
  }
  // What this call wrote, in order: only these are ever removed again.
  const madeDirs: string[] = [];
  const madeFiles: string[] = [];
  const undo = (): void => {
    for (const f of [...madeFiles].reverse()) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
    for (const dir of [...madeDirs].reverse()) {
      try { fs.rmdirSync(dir); } catch { /* not empty or gone: left */ }
    }
  };
  const mkdir = (dir: string): void => {
    fs.mkdirSync(dir);
    madeDirs.push(dir);
  };
  const write = (file: string, text: string): void => {
    // Listed first: a write that fails half-way is removed too (the folder
    // was made by this call, so the name was free).
    madeFiles.push(file);
    fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
  };
  const copied: string[] = [];
  try {
    for (const p of [claudeDir, skillsDir]) if (!lstatOrNull(p)) mkdir(p);
    for (const s of skills) {
      const target = path.join(skillsDir, workerSkillDirName(s.name));
      // Never the bytes as written: the front matter Claude Code reads is
      // written again from the parsed fields.
      const text = workerSkillFile(s.files.content);
      if (text === null || lstatOrNull(target)) continue;
      mkdir(target);
      write(path.join(target, SKILL_FILE), text);
      if (s.files.references.length > 0) {
        mkdir(path.join(target, REFERENCES_DIR));
        for (const ref of s.files.references) write(path.join(target, REFERENCES_DIR, ref.name), ref.content);
      }
      copied.push(s.name);
    }
  } catch (err) {
    undo();
    throw err;
  }
  if (madeFiles.length === 0) {
    undo();
    return [];
  }
  const rel = madeFiles.map((f) => path.relative(worktree, f).split(path.sep).join('/'));
  const check = await deps.git(['check-ignore', '--', ...rel], worktree);
  const ignored = new Set(check.code === 0 ? check.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
  const tracked = rel.filter((f) => !ignored.has(f));
  if (tracked.length > 0) {
    undo();
    throw new Error(`the repository's ignore rules do not exclude ${tracked[0]}; no skills installed`);
  }
  return copied;
}

// ── Singleton (the `skills` module: pipe/handlers/skill.rpc.ts) ────────────

let current: BotSkillStore | null = null;

export function setBotSkillStore(s: BotSkillStore | null): void {
  current = s;
}

export function getBotSkillStore(): BotSkillStore | null {
  return current;
}
