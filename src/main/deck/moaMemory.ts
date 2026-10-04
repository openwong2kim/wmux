// ─── Moa memory: decision precedents and skill proposals (P3a/P3b) ───────────
//
// Moa never writes its own memory. It proposes, the operator decides:
//
//   1. Moa writes a `.md` file directly in `<memoryRoot>/_proposals/` (the only
//      place its PreToolUse gate lets Write/Edit land; commanderToolSandbox).
//      Main writes one there too when the operator answers a Moa decision: an
//      offer to keep that answer as a precedent.
//   2. sync() validates the oldest proposal and raises ONE "Remember this?"
//      decision card for it, snapshotting the content it shows.
//   3. Save writes the snapshot (never a re-read: Moa can still edit the file)
//      to its home: a precedent or note in Moa's memory partition, which the
//      first-turn memory injection reads, or a native Claude Code skill in
//      `brains/<HQ>/.claude/skills/<name>/SKILL.md`. Discard drops the file.
//
// The card lives under its own decision key (MOA_MEMORY_DECISION_KEY), never
// the HQ's: the decision store holds one pending decision per key and a pending
// one blocks that workspace's wakes, so a card on the HQ key would stall Moa
// and refuse its next deck_ask_decision. The key is never a workspace, so no
// brain ever runs for it; the resolve handler routes it here instead of
// resuming a turn.
//
// Nothing a proposal says is executed. Validation rejects what could grant a
// capability once saved: frontmatter keys beyond name/description/kind
// (`allowed-tools` would grant tools), the `!`-backtick inline-shell syntax, NUL
// bytes, and oversize files. Moa off, or proposals off, means no cards.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { MOA_MEMORY_DECISION_KEY, type MoaMemoryCard, type MoaMemoryItem } from '../../shared/moa';
import { getMemoryRootDir } from './commanderMemory';
import { PROPOSAL_MAX_BYTES } from './commanderToolSandbox';
import { buildBrainSkills } from './brainSkills';
import { resolveBrainHomeDir } from './ClaudePtyBrainAdapter';
import {
  DECISION_LIMITS,
  clearDecision,
  loadWorkspaceDecision,
  raiseDecision,
} from './deckDecisionStore';
import { getHqWorkspaceId, isMoaMemoryProposalsEnabled } from './deckHqStore';
import { createSerialChain } from './serialChain';

export type ProposalKind = 'skill' | 'note' | 'precedent';

export interface ParsedProposal {
  kind: ProposalKind;
  name: string;
  description: string;
  body: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION_CHARS = 1024;
const FRONTMATTER_KEYS = new Set(['name', 'description', 'kind']);
const SAVE_ANSWER = 'Save';
const DISCARD_ANSWER = 'Discard';
/** Written right after a saved skill's frontmatter. Settings lists and deletes
 *  only skills carrying it, so wmux's own and the operator's skills are safe. */
export const MOA_SAVED_SKILL_MARKER = '<!-- saved by Moa with the operator\'s approval -->';
/** The precedent body's first line: what the injected note is, and is not. */
export const PRECEDENT_FRAMING = 'A past answer, not a rule: if the situation differs, ask again.';

export function getProposalsDir(memoryRoot: string = getMemoryRootDir()): string {
  return path.join(memoryRoot, '_proposals');
}

/** Skill names wmux generates into every brain home (brainSkills.ts). */
function reservedSkillNames(): Set<string> {
  return new Set(buildBrainSkills().map((s) => s.relPath.split(/[\\/]/)[0]));
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    // A double-quoted scalar is how renderSaved writes one (JSON escapes are a
    // subset of YAML's double-quoted escapes).
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      /* not JSON: fall back to stripping the quotes */
    }
    return t.slice(1, -1).trim();
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'").trim();
  return t;
}

/** A YAML-safe scalar: double-quoted with JSON escapes, so `:`, `#`, quotes
 *  and leading indicators can never change the frontmatter's shape. */
function yamlString(v: string): string {
  return JSON.stringify(v.replace(/[\r\n]+/g, ' '));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Validate a proposal file's text. Returns the parsed proposal, or the reason
 * it is refused. Pure; never throws.
 */
export function parseProposal(text: string): ParsedProposal | { error: string } {
  if (Buffer.byteLength(text, 'utf8') > PROPOSAL_MAX_BYTES) return { error: 'too large' };
  if (text.includes('\u0000')) return { error: 'contains a NUL byte' };
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { error: 'no frontmatter' };
  const end = src.indexOf('\n---', 4);
  if (end < 0) return { error: 'unterminated frontmatter' };
  const afterFence = src.slice(end + 4);
  if (afterFence.length > 0 && !afterFence.startsWith('\n')) return { error: 'unterminated frontmatter' };
  const fields = new Map<string, string>();
  for (const line of src.slice(4, end).split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([A-Za-z_-]+):(.*)$/.exec(line);
    if (!m) return { error: 'frontmatter must be plain key: value lines' };
    const key = m[1];
    if (!FRONTMATTER_KEYS.has(key)) return { error: `frontmatter key "${key}" is not allowed` };
    if (fields.has(key)) return { error: `frontmatter key "${key}" is repeated` };
    fields.set(key, unquote(m[2]));
  }
  const name = fields.get('name') ?? '';
  if (!NAME_RE.test(name)) return { error: 'name must be lowercase-kebab, at most 64 characters' };
  const description = fields.get('description') ?? '';
  if (!description || description.length > MAX_DESCRIPTION_CHARS || /[\r\n]/.test(description)) {
    return { error: 'description is missing, too long or multi-line' };
  }
  const kindRaw = fields.get('kind') ?? 'skill';
  const kind: ProposalKind | null =
    kindRaw === 'skill' ? 'skill' : kindRaw === 'note' || kindRaw === 'memory' ? 'note' : kindRaw === 'precedent' ? 'precedent' : null;
  if (!kind) return { error: 'kind must be skill, note or precedent' };
  const body = afterFence.replace(/^\n/, '').trim();
  if (!body) return { error: 'the body is empty' };
  // Claude Code runs `!`command`` in skill text before the model sees it.
  if (src.includes('!`')) return { error: 'inline shell syntax (!`) is not allowed' };
  if (kind === 'skill' && reservedSkillNames().has(name)) return { error: `"${name}" is a wmux skill name` };
  return { kind, name, description, body };
}

/** The text a saved proposal is written as: rebuilt from validated fields, so
 *  nothing outside them survives the save. */
export function renderSaved(p: ParsedProposal): string {
  const front = ['---', `name: ${p.name}`, `description: ${yamlString(p.description)}`];
  if (p.kind !== 'skill') front.push(`kind: ${p.kind}`);
  front.push('---');
  const marker = p.kind === 'skill' ? `${MOA_SAVED_SKILL_MARKER}\n\n` : '';
  return `${front.join('\n')}\n${marker}${p.body}\n`;
}

/** The precedent offer main writes when the operator answers a Moa decision. */
export function renderPrecedentOffer(args: {
  decisionId: string;
  question: string;
  answer: string;
  answeredAt: number;
  taskId?: string;
}): string {
  const name = args.decisionId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'decision';
  const firstLine = args.question.trim().split('\n')[0].trim().slice(0, 200);
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlString(firstLine)}`,
    'kind: precedent',
    '---',
    PRECEDENT_FRAMING,
    '',
    `Question: ${args.question.trim().slice(0, DECISION_LIMITS.MAX_QUESTION_CHARS)}`,
    `Answer: ${args.answer.trim().slice(0, DECISION_LIMITS.MAX_RESOLUTION_CHARS)}`,
    `Answered: ${new Date(args.answeredAt).toISOString()}`,
    `Source task: ${args.taskId ?? 'none'}`,
    '',
  ].join('\n');
}

/** Where a saved proposal lives. */
function savedPath(p: { kind: ProposalKind; name: string }, roots: { memoryDir: string; skillsDir: string }): string {
  if (p.kind === 'skill') return path.join(roots.skillsDir, p.name, 'SKILL.md');
  return path.join(roots.memoryDir, `${p.kind}-${p.name}.md`);
}

/** Write via a temp file and a rename, keeping no backup copy: a discarded
 *  proposal or a removed memory must leave nothing behind. */
function writeFileAtomic(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
}

/** Read a file only when it is a plain file within the size cap. */
function readPlainFile(file: string, maxBytes: number): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

interface PendingCard {
  decisionId: string;
  /** The proposal's file name inside `_proposals/`. */
  file: string;
  /** The proposal text when the card went up; Save writes what it renders to. */
  snapshot: string;
  raisedAt: number;
  /** Whether the decision's own context holds the whole text Save would
   *  write. Only then may a surface that shows just that context save. */
  fullTextInContext: boolean;
}

interface CardState {
  pending: PendingCard | null;
  /** Precedent offers main wrote: proposal file name → sha256 of its text.
   *  A precedent card is raised only for a file listed here, unchanged. */
  offers: Record<string, string>;
}


/** How the operator answered a card. Anything else is not an answer. */
export function parseCardAnswer(resolution: string): 'save' | 'discard' | null {
  const a = resolution.trim().toLowerCase();
  if (a === SAVE_ANSWER.toLowerCase()) return 'save';
  if (a === DISCARD_ANSWER.toLowerCase()) return 'discard';
  return null;
}

export interface MoaMemoryLaneOptions {
  /** wmux data dir (stores, brain homes). Defaults to getWmuxDir(). */
  dir?: string;
  /** Memory root. Defaults to `<dir>/memory`. */
  memoryRoot?: string;
  log?: (line: string) => void;
  /** Told after a card goes up or comes down, so the deck can re-read it. */
  onChange?: () => void;
}

export interface ResolveResult {
  ok: boolean;
  code?: string;
  saved?: boolean;
}

/**
 * The proposal → card → save/discard lane. One card at a time; the queue is
 * the proposals folder, so a lost card is simply raised again on the next
 * sync. Every entry point is serialized and never throws.
 */
export class MoaMemoryLane {
  private readonly opts: MoaMemoryLaneOptions;
  private readonly serial = createSerialChain();
  private readonly warned = new Set<string>();

  constructor(opts: MoaMemoryLaneOptions = {}) {
    this.opts = opts;
  }

  private get dir(): string {
    return this.opts.dir ?? getWmuxDir();
  }

  private get memoryRoot(): string {
    return this.opts.memoryRoot ?? (this.opts.dir ? path.join(this.opts.dir, 'memory') : getMemoryRootDir());
  }

  get proposalsDir(): string {
    return getProposalsDir(this.memoryRoot);
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.warn(l)))(`[moa:memory] ${line}`);
  }

  private statePath(): string {
    return path.join(this.dir, 'moa-memory-card.json');
  }

  private loadState(): CardState {
    const state: CardState = { pending: null, offers: {} };
    let raw: { pending?: unknown; offers?: unknown } | null;
    try {
      raw = JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) as { pending?: unknown; offers?: unknown } | null;
    } catch {
      return state; // a missing or torn state file is "no card"
    }
    const p = raw && typeof raw === 'object' ? (raw.pending as Record<string, unknown> | null | undefined) : null;
    if (
      p && typeof p.decisionId === 'string' && typeof p.file === 'string'
      && typeof p.snapshot === 'string' && typeof p.raisedAt === 'number'
    ) {
      state.pending = {
        decisionId: p.decisionId,
        file: p.file,
        snapshot: p.snapshot,
        raisedAt: p.raisedAt,
        fullTextInContext: p.fullTextInContext === true,
      };
    }
    const offers = raw && typeof raw === 'object' ? raw.offers : null;
    if (offers && typeof offers === 'object' && !Array.isArray(offers)) {
      for (const [k, v] of Object.entries(offers as Record<string, unknown>)) {
        if (typeof v === 'string') state.offers[k] = v;
      }
    }
    return state;
  }

  /** Main-owned state, written with no backup copy (see writeFileAtomic). */
  private saveState(state: CardState): void {
    writeFileAtomic(this.statePath(), JSON.stringify(state));
  }

  /** Take the card down. The decision store keeps the previous file as a
   *  backup, so a second write rotates the card's text out of it too. */
  private async clearCard(): Promise<void> {
    await clearDecision(MOA_MEMORY_DECISION_KEY, this.dir);
    await clearDecision(MOA_MEMORY_DECISION_KEY, this.dir);
    this.changed();
  }

  private changed(): void {
    try {
      this.opts.onChange?.();
    } catch {
      /* a listener never breaks the lane */
    }
  }

  /** The HQ these proposals belong to, or null when the lane is off. */
  private activeHq(): string | null {
    if (!isMoaMemoryProposalsEnabled(this.dir)) return null;
    return getHqWorkspaceId(this.dir);
  }

  private roots(hq: string): { memoryDir: string; skillsDir: string } {
    return {
      memoryDir: path.join(this.memoryRoot, hq),
      skillsDir: path.join(resolveBrainHomeDir(this.dir, hq), '.claude', 'skills'),
    };
  }

  /** Raise the next card if none is up; clear the card when the lane is off. */
  sync(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.syncLocked();
      } catch (err) {
        this.log(`sync failed: ${String(err)}`);
      }
    });
  }

  private async syncLocked(): Promise<void> {
    const hq = this.activeHq();
    const state = this.loadState();
    const card = loadWorkspaceDecision(MOA_MEMORY_DECISION_KEY, this.dir);
    if (!hq) {
      if (card) await this.clearCard();
      if (state.pending) this.saveState({ ...state, pending: null });
      return;
    }
    if (state.pending && card?.status === 'pending' && card.id === state.pending.decisionId) return;
    // A card nobody tracks (or a state whose card is gone): start over. The
    // proposal file is still on disk, so it is raised again below.
    if (card) await this.clearCard();
    if (state.pending) this.saveState({ ...state, pending: null });
    await this.raiseNext(hq);
  }

  private listProposalFiles(): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.proposalsDir).filter((n) => n.toLowerCase().endsWith('.md'));
    } catch {
      return [];
    }
    const withTime = names.map((n) => {
      let t = 0;
      try {
        t = fs.lstatSync(path.join(this.proposalsDir, n)).mtimeMs;
      } catch {
        /* vanished — sorts first, then fails its read */
      }
      return { n, t };
    });
    withTime.sort((a, b) => a.t - b.t || a.n.localeCompare(b.n));
    return withTime.map((x) => x.n);
  }

  private skip(file: string, text: string, reason: string): void {
    const key = `${file}:${sha256(text)}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(`skipping proposal ${file}: ${reason}`);
  }

  private async raiseNext(hq: string): Promise<void> {
    const state = this.loadState();
    const files = this.listProposalFiles();
    // Forget offers whose file is gone.
    const live = new Set(files);
    for (const f of Object.keys(state.offers)) if (!live.has(f)) delete state.offers[f];
    for (const file of files) {
      const text = readPlainFile(path.join(this.proposalsDir, file), PROPOSAL_MAX_BYTES);
      if (text === null) continue;
      const parsed = parseProposal(text);
      if ('error' in parsed) {
        this.skip(file, text, parsed.error);
        continue;
      }
      // A precedent is the operator's own answer: only main writes one, so
      // only a file main recorded, unchanged since, may become a card.
      if (parsed.kind === 'precedent' && state.offers[file] !== sha256(text)) {
        this.skip(file, text, 'a precedent main did not write');
        continue;
      }
      const card = this.renderCard(parsed, hq);
      const decision = await raiseDecision(
        MOA_MEMORY_DECISION_KEY,
        { question: card.question, options: [SAVE_ANSWER, DISCARD_ANSWER], context: card.context },
        this.dir,
      );
      if (!decision) break;
      state.pending = {
        decisionId: decision.id,
        file,
        snapshot: text,
        raisedAt: decision.raisedAt,
        // Trust what the store kept, not what was asked for: it may cap or
        // prefix the context.
        fullTextInContext: card.fullTextInContext && decision.context.includes(renderSaved(parsed).trim()),
      };
      break;
    }
    this.saveState(state);
    if (state.pending) this.changed();
  }

  private renderCard(p: ParsedProposal, hq: string): { question: string; context: string; fullTextInContext: boolean } {
    const replaces = fs.existsSync(savedPath(p, this.roots(hq)));
    const what =
      p.kind === 'precedent'
        ? 'Remember this answer as a precedent for next time?'
        : p.kind === 'note'
          ? `Remember this? Moa proposes a memory note: "${p.name}"`
          : `Remember this? Moa proposes a skill: "${p.name}"`;
    const question = replaces ? `${what} (replaces the saved one)` : what;
    // Shown to the operator as text. The whole text Save writes when it fits;
    // otherwise a pointer to the deck card, which shows all of it.
    const fullText = renderSaved(p);
    const fullTextInContext = fullText.length <= DECISION_LIMITS.MAX_CONTEXT_CHARS;
    const context = fullTextInContext
      ? fullText
      : `${p.description.slice(0, 400)}\n---\nToo long to show here (${fullText.length} characters). Open Moa's deck to read the full text before saving.`;
    return { question, context, fullTextInContext };
  }

  /** The pending card with the full text Save would write, or null. */
  cardView(): MoaMemoryCard | null {
    const hq = this.activeHq();
    if (!hq) return null;
    const { pending } = this.loadState();
    const card = loadWorkspaceDecision(MOA_MEMORY_DECISION_KEY, this.dir);
    if (!pending || card?.id !== pending.decisionId || card.status !== 'pending') return null;
    const parsed = parseProposal(pending.snapshot);
    if ('error' in parsed) return null;
    return {
      id: card.id,
      kind: parsed.kind,
      name: parsed.name,
      question: card.question,
      description: parsed.description,
      fullText: renderSaved(parsed),
      replaces: fs.existsSync(savedPath(parsed, this.roots(hq))),
    };
  }

  /**
   * The operator answered the card: exactly Save or Discard. Save writes what
   * the snapshot renders to, never a re-read of the file Moa can still edit.
   * Any other answer changes nothing and the card stays up. Save from a
   * surface that showed only the decision's context is refused when that
   * context did not hold the whole text (`fullTextShown`). The proposal file is
   * removed only while it still holds the snapshot, so an edit Moa made
   * meanwhile comes back as a new card. Then the next card goes up.
   */
  resolve(decisionId: string, resolution: string, opts: { fullTextShown?: boolean } = {}): Promise<ResolveResult> {
    return this.serial(async () => {
      try {
        const state = this.loadState();
        const card = loadWorkspaceDecision(MOA_MEMORY_DECISION_KEY, this.dir);
        if (!state.pending || state.pending.decisionId !== decisionId || card?.id !== decisionId || card.status !== 'pending') {
          return { ok: false, code: 'not_pending' };
        }
        const pending = state.pending;
        const answer = parseCardAnswer(resolution);
        if (!answer) return { ok: false, code: 'unknown_answer' };
        const save = answer === 'save';
        if (save && !opts.fullTextShown && !pending.fullTextInContext) return { ok: false, code: 'open_full_text' };
        const hq = this.activeHq();
        let saved = false;
        if (save && hq) {
          const parsed = parseProposal(pending.snapshot);
          if (!('error' in parsed)) {
            writeFileAtomic(savedPath(parsed, this.roots(hq)), renderSaved(parsed));
            saved = true;
          }
        }
        const file = path.join(this.proposalsDir, pending.file);
        if (readPlainFile(file, PROPOSAL_MAX_BYTES) === pending.snapshot) {
          try {
            fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        }
        const offers = { ...state.offers };
        delete offers[pending.file];
        this.saveState({ pending: null, offers });
        await this.clearCard();
        if (hq) await this.raiseNext(hq);
        return { ok: true, saved };
      } catch (err) {
        this.log(`resolve failed: ${String(err)}`);
        return { ok: false, code: 'failed' };
      }
    });
  }

  /**
   * The operator answered one of Moa's own decisions: queue the offer to keep
   * that answer as a precedent. A no-op while the lane is off.
   */
  offerPrecedent(args: { decisionId: string; question: string; answer: string; taskId?: string; answeredAt?: number }): Promise<void> {
    return this.serial(async () => {
      try {
        if (!this.activeHq()) return;
        const text = renderPrecedentOffer({ ...args, answeredAt: args.answeredAt ?? Date.now() });
        const parsed = parseProposal(text);
        if ('error' in parsed) {
          this.log(`not offering a precedent for ${args.decisionId}: ${parsed.error}`);
          return;
        }
        fs.mkdirSync(this.proposalsDir, { recursive: true, mode: 0o700 });
        const file = `precedent-${parsed.name}.md`;
        writeFileAtomic(path.join(this.proposalsDir, file), text);
        const state = this.loadState();
        state.offers[file] = sha256(text);
        this.saveState(state);
      } catch (err) {
        this.log(`could not queue a precedent offer: ${String(err)}`);
      }
    }).then(() => this.sync());
  }

  /** What Moa remembers, for Settings → Moa. Empty without an HQ. */
  list(): MoaMemoryItem[] {
    const hq = getHqWorkspaceId(this.dir);
    if (!hq) return [];
    const { memoryDir, skillsDir } = this.roots(hq);
    const items: MoaMemoryItem[] = [];
    const push = (kind: MoaMemoryItem['kind'], name: string, file: string, needMarker: boolean): void => {
      const text = readPlainFile(file, PROPOSAL_MAX_BYTES * 2);
      if (text === null || (needMarker && !text.includes(MOA_SAVED_SKILL_MARKER))) return;
      const parsed = parseProposal(text);
      let savedAt = 0;
      try {
        savedAt = fs.lstatSync(file).mtimeMs;
      } catch {
        /* listed without a time */
      }
      items.push({ kind, name, description: 'error' in parsed ? '' : parsed.description, savedAt });
    };
    try {
      for (const n of fs.readdirSync(memoryDir).sort()) {
        const m = /^(precedent|note)-([a-z0-9][a-z0-9-]{0,63})\.md$/.exec(n);
        if (m) push(m[1] as 'precedent' | 'note', m[2], path.join(memoryDir, n), false);
      }
    } catch {
      /* no memory partition yet */
    }
    try {
      for (const n of fs.readdirSync(skillsDir).sort()) {
        if (NAME_RE.test(n)) push('skill', n, path.join(skillsDir, n, 'SKILL.md'), true);
      }
    } catch {
      /* no skills yet */
    }
    return items.sort((a, b) => b.savedAt - a.savedAt);
  }

  /** Delete one saved item. Only Moa-saved files are touched: a precedent or
   *  note in the HQ partition, or a skill carrying the saved marker. */
  remove(kind: unknown, name: unknown): boolean {
    if ((kind !== 'precedent' && kind !== 'note' && kind !== 'skill') || typeof name !== 'string' || !NAME_RE.test(name)) {
      return false;
    }
    const hq = getHqWorkspaceId(this.dir);
    if (!hq) return false;
    const file = savedPath({ kind, name }, this.roots(hq));
    const text = readPlainFile(file, PROPOSAL_MAX_BYTES * 2);
    if (text === null) return false;
    if (kind === 'skill' && !text.includes(MOA_SAVED_SKILL_MARKER)) return false;
    try {
      fs.unlinkSync(file);
      if (kind === 'skill') {
        try {
          fs.rmdirSync(path.dirname(file));
        } catch {
          /* the folder holds something else; the skill itself is gone */
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
