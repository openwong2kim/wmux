// Skill-picker input for the loop settings modal — scans disk for the skill/command
// catalog available to pane agents (Claude CLI).
//
// Important distinction: these skills belong to the *in-pane CLI*, not the orchestrator.
// When a loop step references "/qa", execution means "type /qa into the pane"
// (grounding rules) — so the catalog's source of truth follows the same disk layout as the CLI:
//   <projectRoot>/.claude/skills/<name>/SKILL.md   (project skill)
//   <projectRoot>/.claude/commands/<name>.md       (project command)
//   <home>/.claude/skills|commands/...             (user-global)
// projectRoot is the nearest ancestor of cwd that has a `.claude` directory (same shape as
// CLI project resolution). Read-only, fail-soft: any I/O failure degrades to an empty or partial list.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { toHostAccessiblePath, type SessionLocation } from '../../shared/sessionLocation';
import { isLinuxLikeCwd } from '../../shared/wslCwd';

export interface SkillCatalogEntry {
  /** Name without leading slash — UI renders as `/${name}`. */
  readonly name: string;
  /** First line of SKILL.md frontmatter description (capped) or ''. */
  readonly description: string;
  readonly source: 'project' | 'user';
  readonly kind: 'skill' | 'command';
}

const MAX_ENTRIES = 200;
const MAX_DESC_CHARS = 160;
const MAX_WALK_UP = 12;

/** Walk up from cwd to find the nearest ancestor with a `.claude` directory.
 *  home itself is not a project (~/.claude is the user-global root) — if the walk
 *  reaches home, treat as no project (double-counting bug caught by tests). */
export function findProjectRoot(cwd: string, home: string = homedir()): string | null {
  const normHome = home.replace(/[/\\]+$/, '').toLowerCase();
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (dir.replace(/[/\\]+$/, '').toLowerCase() === normHome) return null;
    try {
      if (existsSync(join(dir, '.claude'))) return dir;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Extract one description line from SKILL.md/command md frontmatter (fail-soft). */
function readDescription(mdPath: string): string {
  try {
    const raw = readFileSync(mdPath, 'utf8').slice(0, 4096);
    const m = raw.match(/^description:\s*(.+)$/m);
    return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '').slice(0, MAX_DESC_CHARS);
  } catch {
    return '';
  }
}

function scanRoot(claudeDir: string, source: 'project' | 'user', out: SkillCatalogEntry[]): void {
  // skills/<name>/SKILL.md
  try {
    const skillsDir = join(claudeDir, 'skills');
    for (const name of readdirSync(skillsDir)) {
      if (out.length >= MAX_ENTRIES) return;
      try {
        const dir = join(skillsDir, name);
        if (!statSync(dir).isDirectory()) continue;
        const md = join(dir, 'SKILL.md');
        if (!existsSync(md)) continue;
        out.push({ name, description: readDescription(md), source, kind: 'skill' });
      } catch {
        /* per-entry fail-soft */
      }
    }
  } catch {
    /* skills directory missing — normal */
  }
  // commands/<name>.md
  try {
    const commandsDir = join(claudeDir, 'commands');
    for (const file of readdirSync(commandsDir)) {
      if (out.length >= MAX_ENTRIES) return;
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -3);
      out.push({
        name,
        description: readDescription(join(commandsDir, file)),
        source,
        kind: 'command',
      });
    }
  } catch {
    /* commands directory missing — normal */
  }
}

/**
 * Skill/command catalog for cwd. Project entries first (closer = more relevant);
 * same name: project shadows user-global (same as CLI resolution).
 */
export interface SkillCatalogScanOptions {
  toHostPath?: typeof toHostAccessiblePath;
}

export function scanSkillCatalog(
  input: string | SessionLocation,
  home: string = homedir(),
  options: SkillCatalogScanOptions = {},
): SkillCatalogEntry[] {
  const out: SkillCatalogEntry[] = [];
  const location = normalizeLocationInput(input);
  const converted = location
    ? (options.toHostPath ?? toHostAccessiblePath)(location, location.cwd)
    : null;
  const projectRoot = converted?.ok ? findProjectRoot(converted.path, home) : null;
  if (projectRoot) scanRoot(join(projectRoot, '.claude'), 'project', out);
  scanRoot(join(home, '.claude'), 'user', out);
  // Name dedup — project wins (pushed first).
  const seen = new Set<string>();
  return out.filter((e) => {
    if (seen.has(e.name)) return false;
    seen.add(e.name);
    return true;
  });
}

function normalizeLocationInput(input: string | SessionLocation): SessionLocation | null {
  if (typeof input === 'string') {
    if (!input || (process.platform === 'win32' && isLinuxLikeCwd(input))) return null;
    return { domain: 'host', cwd: input, shell: '' };
  }
  if (!input || typeof input !== 'object') return null;
  if (input.domain !== 'host' && input.domain !== 'wsl') return null;
  if (typeof input.cwd !== 'string' || !input.cwd || typeof input.shell !== 'string') return null;
  if (input.domain === 'wsl' && input.distro !== undefined && typeof input.distro !== 'string') return null;
  return input;
}
