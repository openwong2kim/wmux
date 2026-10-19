// ─── Bot skills — procedures a bot writes for itself, the owner approves ───
//
// Contract for main/factory/botSkills.ts (the store), the `skills` factory
// module (main/pipe/handlers/skill.rpc.ts), the `skill_propose` /
// `skill_read` bot tools (src/mcp/botSkills.ts) and the bot profile's Skills
// section.
//
// A skill is a procedure: how this bot does one kind of work, learned from an
// owner's correction or from a task that failed and then succeeded. Standing
// facts are not skills. Each bot keeps its own, under its own folder:
//
//   <wmuxDir>/factory/bots/<botId>/skills/<name>/
//     SKILL.md, references/     the approved version (what loads)
//     proposed/SKILL.md, proposed/references/
//                               the pending version (never loads)
//
// Each skill's state, and the content hash of the version the owner
// approved, are kept by main in its own `<wmuxDir>/factory/bot-skills.json`,
// not in the skill folder. Every load hashes the files on disk again and
// uses them only when they are the approved version.
//
// SKILL.md is markdown with a front matter of exactly `name`, `description`
// and `version` (agentskills.io style). Writing a skill only ever creates a
// proposed version; the owner's Approve on its approval card (action
// `skill`, shared/botApproval.ts) makes it the approved one, Deny archives
// the proposal. Nothing loads before approval: the bot's wake lists its
// approved skills by name and description and `skill_read` returns an
// approved body; a worker it starts in a worktree gets copies of the approved
// skills in its `.claude/skills/bot-<name>/`, excluded from git (a research
// worker's scratch folder gets none), each front matter written again from its
// parsed fields (main/factory/skillFrontmatter.ts), never copied as the bot
// wrote it.
//
// A bot writes and reads only its own skills; main takes the bot from the
// token's binding and builds every path itself — a call never names a path.

export const BOT_SKILL_RPC = {
  /** `skill_propose`: create or update one of the caller's skills, as a
   *  proposed version that waits for the owner (SkillProposeParams). */
  propose: 'skill.propose',
  /** `skill_read`: one of the caller's approved skills, or with no name
   *  the list of them (SkillReadParams). */
  read: 'skill.read',
} as const;

/** Main-window IPC (operator only; the main window's top frame). */
export const BOT_SKILL_IPC = {
  /** One bot's skills (SkillListRequest → SkillListResult). */
  list: 'factory:skill:list',
  /** Archive one skill (SkillArchiveRequest → SkillArchiveResult). */
  archive: 'factory:skill:archive',
} as const;

export const SKILL_LIMITS = {
  NAME_MAX: 64,
  DESCRIPTION_MAX: 300,
  VERSION_MAX: 32,
  /** SKILL.md, front matter included. */
  BODY_MAX: 16 * 1024,
  /** One reference file. */
  REFERENCE_MAX: 16 * 1024,
  REFERENCES_MAX: 8,
  /** Every reference of one skill together. */
  REFERENCES_TOTAL_MAX: 64 * 1024,
  /** Skills one bot keeps (archived ones included). */
  PER_BOT: 40,
  REASON_MAX: 300,
  /** The change a proposal shows on the owner's card (every character of
   *  it is shown there): a new skill is all new lines, an update its hunks.
   *  Below ROOM_LIMITS.CARD_BODY_MAX less the card's other lines. */
  DIFF_MAX: 7000,
} as const;

/** A skill's name: a lowercase slug — no separator, no dot, so never `..`
 *  — and never a Windows device name (con, prn, aux, nul, com0-9, lpt0-9),
 *  which no folder on Windows can be called. */
export const SKILL_NAME_RE = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$)[a-z0-9][a-z0-9-]{0,63}$/;

/** A reference file's name: a slug with a .md or .txt extension, whose
 *  stem is never a Windows device name (`con.md` is reserved too). */
export const SKILL_REFERENCE_NAME_RE = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\.)[a-z0-9][a-z0-9_-]{0,63}\.(md|txt)$/;

/** `MAJOR.MINOR.PATCH`. */
export const SKILL_VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

/** The front matter keys a SKILL.md carries, all required. */
export const SKILL_FRONTMATTER_KEYS = ['name', 'description', 'version'] as const;

/** proposed: written, never approved yet. approved: its approved version
 *  loads (an update may wait beside it). archived: nothing loads. */
export type SkillState = 'proposed' | 'approved' | 'archived';

export interface SkillReferenceInput {
  name: string;
  content: string;
}

/** `skill.propose` params (the bot comes from the binding). */
export interface SkillProposeParams {
  /** The skill's name; equal to the front matter's. */
  name: string;
  /** The whole SKILL.md: front matter, then the procedure. */
  content: string;
  /** The full set of reference files of this version (replaces the last). */
  references?: SkillReferenceInput[];
  /** The bot's one line to the owner: what it learned and from what. */
  reason: string;
}

/** `skill.read` params: a skill, or one of its reference files; no name
 *  lists the approved skills. */
export interface SkillReadParams {
  name?: string;
  reference?: string;
}

/** One skill as the owner's profile and the bot's tools see it. */
export interface BotSkillView {
  name: string;
  state: SkillState;
  /** The approved version's front matter. */
  description?: string;
  version?: string;
  /** A proposed version waits for the owner. */
  proposed?: { version: string; description: string; approvalId?: string; at: number };
  approvedAt?: number;
  /** The approved version's files on disk are not the ones the owner
   *  approved: nothing of it loads until a new proposal is approved. */
  changed?: true;
  updatedAt: number;
}

/** What a wake lists of one approved skill. */
export interface SkillIndexEntry {
  name: string;
  description: string;
}

export interface SkillListRequest { botId: string; }
export type SkillListResult = { ok: true; skills: BotSkillView[] } | { ok: false; error: string };
export interface SkillArchiveRequest { botId: string; name: string; }
export type SkillArchiveResult = { ok: true; skill: BotSkillView } | { ok: false; error: string };

/** The folder name of a bot's skill copied into a worker's worktree. */
export function workerSkillDirName(name: string): string {
  return `bot-${name}`;
}

/** The `info/exclude` line that keeps those copies out of git. */
export const WORKER_SKILLS_EXCLUDE_LINE = '/.claude/skills/bot-*/';

export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
}

/** a > b for two SKILL_VERSION_RE versions. Pure. */
export function skillVersionNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}
