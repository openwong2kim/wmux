import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildBrainSkills, installBrainSkills, WMUX_SKILL_MARKER } from '../brainSkills';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-brainskills-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildBrainSkills', () => {
  it('returns delegate + approve, each a well-formed, marked SKILL.md', () => {
    const skills = buildBrainSkills();
    expect(skills.map((s) => s.relPath)).toEqual([
      path.join('delegate', 'SKILL.md'),
      path.join('approve', 'SKILL.md'),
    ]);
    for (const skill of skills) {
      // Frontmatter must start at offset 0 or Claude Code does not parse it —
      // the marker therefore lives on the first line of the BODY.
      expect(skill.content.startsWith('---\n')).toBe(true);
      const frontmatter = skill.content.slice(4, skill.content.indexOf('\n---\n', 3));
      expect(frontmatter).toMatch(/^name: \S+$/m);
      expect(frontmatter).toMatch(/^description: .+$/m);
      expect(skill.content).toContain(WMUX_SKILL_MARKER);
    }
  });

  it('states the two facts the delegate skill exists to state', () => {
    const delegate = buildBrainSkills()[0].content;
    // 1. The no-shell boundary, named tool by tool.
    expect(delegate).toContain('You cannot run commands');
    for (const tool of ['Bash', 'Edit', 'Write', 'Task', 'Agent']) {
      expect(delegate).toContain(tool);
    }
    // 2. The pane workaround is exit-code-blind, so a calm screen is not proof.
    expect(delegate).toContain('cannot read an exit code');
  });

  it('makes the approve skill say verify-then-press, not press-on-event', () => {
    const approve = buildBrainSkills()[1].content;
    expect(approve).toContain('Never press on the strength of the event alone');
    expect(approve).toContain('deck_ask_decision');
  });
});

describe('installBrainSkills', () => {
  it('writes both skills under the brain home and is idempotent', () => {
    installBrainSkills(tmpDir);
    const root = path.join(tmpDir, '.claude', 'skills');
    const delegate = path.join(root, 'delegate', 'SKILL.md');
    const approve = path.join(root, 'approve', 'SKILL.md');
    expect(fs.existsSync(delegate)).toBe(true);
    expect(fs.existsSync(approve)).toBe(true);

    const before = fs.readFileSync(delegate, 'utf8');
    installBrainSkills(tmpDir);
    expect(fs.readFileSync(delegate, 'utf8')).toBe(before);
  });

  it('leaves a file the operator took ownership of byte-identical', () => {
    installBrainSkills(tmpDir);
    const delegate = path.join(tmpDir, '.claude', 'skills', 'delegate', 'SKILL.md');
    const mine = '---\nname: delegate\ndescription: my own rules\n---\n\nDo it my way.\n';
    fs.writeFileSync(delegate, mine, 'utf8');

    installBrainSkills(tmpDir);
    expect(fs.readFileSync(delegate, 'utf8')).toBe(mine);
    // The unclaimed sibling is still refreshed.
    expect(fs.readFileSync(path.join(tmpDir, '.claude', 'skills', 'approve', 'SKILL.md'), 'utf8'))
      .toContain(WMUX_SKILL_MARKER);
  });

  it('never throws when the target cannot be written', () => {
    // A regular file where the skills directory must go: every mkdir under it
    // fails, and the spawn must not care.
    const home = path.join(tmpDir, 'blocked');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.claude'), 'not a directory', 'utf8');
    expect(() => installBrainSkills(home)).not.toThrow();
  });
});
