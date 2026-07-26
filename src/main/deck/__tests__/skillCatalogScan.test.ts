/**
 * skillCatalogScan — pane-location handling.
 *
 * The scan is the deck's project-skill source. Issue #21: it used to re-declare
 * the SessionLocation wire contract and reject `domain: 'msys'`, so a Git Bash
 * pane saw only the user-global catalog and none of its project skills.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanSkillCatalog } from '../skillCatalogScan';

let tmpRoot: string;
let home: string;
let proj: string;

function writeSkill(claudeDir: string, name: string): void {
  const dir = path.join(claudeDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\ndescription: ${name} skill\n---\n`);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-skillscan-'));
  home = path.join(tmpRoot, 'home');
  proj = path.join(tmpRoot, 'proj');
  writeSkill(path.join(home, '.claude'), 'global-only');
  writeSkill(path.join(proj, '.claude'), 'project-only');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('scanSkillCatalog — session locations', () => {
  it('finds project skills for a host location', () => {
    const names = scanSkillCatalog(proj, home).map((e) => e.name);
    expect(names).toContain('project-only');
    expect(names).toContain('global-only');
  });

  it('finds project skills for an MSYS (Git Bash) location', () => {
    const entries = scanSkillCatalog(
      { domain: 'msys', cwd: '/c/dev/proj', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      home,
      { toHostPath: (location, target) => {
        expect(location.domain).toBe('msys');
        expect(target).toBe('/c/dev/proj');
        return { ok: true, path: proj };
      } },
    );

    expect(entries.map((e) => e.name)).toContain('project-only');
    expect(entries.find((e) => e.name === 'project-only')?.source).toBe('project');
  });

});
