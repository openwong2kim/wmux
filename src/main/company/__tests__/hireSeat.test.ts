// hireSeat without a repository: the name asked for or a refusal, the agent
// and the request checked, and the brief a seat gets when it starts where the
// panes start.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hireSeat } from '../seatLaunch';

const NOW = 1_700_000_000_000;
let dir: string;
let deps: Parameters<typeof hireSeat>[1];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hire-seat-'));
  deps = { dir, platform: 'darwin', takenLabels: () => ['ceo', 'Researcher'], now: () => NOW, env: {} };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const req = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-1',
  company: 'checkout',
  mission: 'Ship refunds',
  standingOrders: 'Live check first.',
  ceo: { label: 'ceo' },
  staff: [{ label: 'researcher', owns: 'Research' }],
  seat: { label: 'dev', owns: 'Payments', agent: 'claude' },
  ...over,
});
const briefsOf = () => {
  const folder = path.join(dir, 'company-briefs', 'ws-1');
  return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
};

describe('hireSeat', () => {
  it('starts the agent with its brief where the panes start when the company has no folder and no other agent seat', async () => {
    const res = await hireSeat(req(), deps);
    const file = path.join(dir, 'company-briefs', 'ws-1', `hire-dev-${NOW}.md`);
    expect(res).toEqual({ ok: true, label: 'dev', command: `claude "$(cat '${file}')"`, cwd: null, env: { CLAUDE_CODE_SANDBOXED: '1' } });
    const brief = fs.readFileSync(file, 'utf8');
    expect(brief).toContain('You are #dev in the company "checkout" in wmux. Your CEO is #ceo.');
    expect(brief).toContain('You own: Payments.');
    expect(brief).toContain('Mission: Ship refunds');
    expect(brief).toContain('Standing orders: Live check first.');
    expect(brief).toContain('Take briefs from #ceo.');
    expect(brief).not.toContain('Your worktree');
  });

  it('starts with no first-run env when the owner turned the first-run handling off', async () => {
    const res = await hireSeat(req(), { ...deps, env: { WMUX_AGENT_FIRST_RUN: 'off' } });
    expect(res.ok && res.env).toBe(undefined);
  });

  it('writes beside the briefs a preset left, and never over one', async () => {
    const folder = path.join(dir, 'company-briefs', 'ws-1');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'seat-1.md'), 'theirs');
    expect((await hireSeat(req(), deps)).ok).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'seat-1.md'), 'utf8')).toBe('theirs');
    // The same name at the same moment finds its file there already.
    expect((await hireSeat(req(), deps)).ok).toBe(false);
    expect(briefsOf().sort()).toEqual([`hire-dev-${NOW}.md`, 'seat-1.md']);
  });

  it('refuses a name another pane carries, in any case, instead of suffixing it', async () => {
    const res = await hireSeat(req({ seat: { label: 'researcher', owns: '', agent: 'claude' } }), deps);
    expect(res).toEqual({ ok: false, error: 'another pane is named researcher' });
    expect(briefsOf()).toEqual([]);
  });

  it('refuses a name that is not a pane label, an unknown agent, or a bad request, and writes nothing', async () => {
    for (const label of ['', 'has space', '#dev', '9lives', 'w1-2', 'x'.repeat(65)]) {
      expect((await hireSeat(req({ seat: { label, owns: '', agent: 'claude' } }), deps)).ok, label).toBe(false);
    }
    for (const agent of [undefined, 'rm -rf', 'Claude Code']) {
      expect(await hireSeat(req({ seat: { label: 'dev', owns: '', agent } }), deps)).toEqual({ ok: false, error: `unknown agent ${String(agent)}` });
    }
    expect((await hireSeat(req({ workspaceId: '..' }), deps)).ok).toBe(false);
    expect((await hireSeat(req({ folder: 'relative/path' }), deps)).ok).toBe(false);
    expect((await hireSeat(req({ ceo: { label: 'two words' } }), deps)).ok).toBe(false);
    expect((await hireSeat(req({ staff: [{ label: 'x', owns: 'o'.repeat(201) }] }), deps)).ok).toBe(false);
    expect((await hireSeat(req({ seat: { label: 'dev', owns: 'o'.repeat(201), agent: 'claude' } }), deps)).ok).toBe(false);
    expect(briefsOf()).toEqual([]);
  });

  it('refuses with no folder when another staff seat\'s agent already works where the panes start', async () => {
    const res = await hireSeat(req({ staff: [{ label: 'researcher', owns: 'Research', agent: true }] }), deps);
    expect(res.ok).toBe(false);
    expect(briefsOf()).toEqual([]);
  });
});
