// Loop steps (per-iteration procedure) + skill catalog scan contract.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startLoop,
  loadWorkspaceLoopState,
  renderLoopStateBlock,
  LOOP_STATE_LIMITS,
} from '../deckLoopStateStore';
import { scanSkillCatalog, findProjectRoot } from '../skillCatalogScan';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wmux-loopsteps-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loop steps — persist·normalize·round-trip', () => {
  it('steps persist and survive reload (blank line trim·cap)', async () => {
    await startLoop(
      'ws-1',
      {
        objective: 'keep CI green',
        steps: ['  /qa run  ', '', 'fix failures', 'x'.repeat(LOOP_STATE_LIMITS.MAX_STEP_TEXT + 50)],
      },
      dir,
    );
    const loop = loadWorkspaceLoopState('ws-1', dir)!;
    expect(loop.steps).toEqual(['/qa run', 'fix failures', 'x'.repeat(LOOP_STATE_LIMITS.MAX_STEP_TEXT)]);
  });

  it('steps count cap (MAX_STEPS) — truncates overflow', async () => {
    await startLoop(
      'ws-1',
      { objective: 'o', steps: Array.from({ length: LOOP_STATE_LIMITS.MAX_STEPS + 5 }, (_, i) => `s${i}`) },
      dir,
    );
    expect(loadWorkspaceLoopState('ws-1', dir)!.steps.length).toBe(LOOP_STATE_LIMITS.MAX_STEPS);
  });

  it('loop without steps is empty array (legacy file backward compat)', async () => {
    await startLoop('ws-1', { objective: 'o' }, dir);
    expect(loadWorkspaceLoopState('ws-1', dir)!.steps).toEqual([]);
  });

  it('renderLoopStateBlock — steps injected after objective in numbered order', async () => {
    await startLoop('ws-1', { objective: 'o', steps: ['/qa', 'fix failures'], taskTexts: ['done'] }, dir);
    const block = renderLoopStateBlock(loadWorkspaceLoopState('ws-1', dir)!);
    expect(block).toContain('steps (follow in order each iteration');
    expect(block).toContain('  1. /qa');
    expect(block).toContain('  2. fix failures');
    // steps section comes before done-when.
    expect(block.indexOf('steps (')).toBeLessThan(block.indexOf('done-when'));
  });

  it('no steps section in block when steps absent', async () => {
    await startLoop('ws-1', { objective: 'o' }, dir);
    expect(renderLoopStateBlock(loadWorkspaceLoopState('ws-1', dir)!)).not.toContain('steps (');
  });
});

describe('scanSkillCatalog — .claude/skills|commands scan', () => {
  function seed(root: string, kind: 'skills' | 'commands', name: string, desc?: string): void {
    if (kind === 'skills') {
      const d = join(root, '.claude', 'skills', name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc ?? ''}\n---\nbody`);
    } else {
      const d = join(root, '.claude', 'commands');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${name}.md`), desc ? `---\ndescription: ${desc}\n---\n` : 'body');
    }
  }

  it('project skills+commands then user global, name dedup prefers project', () => {
    const project = join(dir, 'proj');
    const home = join(dir, 'home');
    seed(project, 'skills', 'qa', 'test the site');
    seed(project, 'commands', 'ship');
    seed(home, 'skills', 'qa', 'USER duplicate — must be shadowed');
    seed(home, 'commands', 'review', 'code review');
    const out = scanSkillCatalog(join(project, 'src', 'deep'), home);
    expect(out.map((e) => `${e.source}:${e.name}`)).toEqual([
      'project:qa',
      'project:ship',
      'user:review',
    ]);
    expect(out[0].description).toBe('test the site');
    expect(out[0].kind).toBe('skill');
    expect(out[1].kind).toBe('command');
  });

  it('findProjectRoot — finds .claude ancestor but home itself is not a project', () => {
    const project = join(dir, 'p2');
    mkdirSync(join(project, '.claude'), { recursive: true });
    const deep = join(project, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(findProjectRoot(deep, dir)).toBe(project);
    // Even if home(=dir) has .claude, walk-up hitting home returns null —
    // do not double-count ~/.claude as a "project".
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const bare = join(dir, 'bare');
    mkdirSync(bare);
    expect(findProjectRoot(bare, dir)).toBeNull();
  });

  it('nonexistent cwd and empty home fail-soft to empty list', () => {
    expect(scanSkillCatalog(join(dir, 'nope'), dir)).toEqual([]);
  });
});
