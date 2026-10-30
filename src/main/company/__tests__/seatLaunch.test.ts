import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SEAT_BRIEF_KEEP_MS, seatLaunches } from '../seatLaunch';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-seat-launch-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const req = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-1',
  company: 'checkout',
  mission: 'Ship refunds',
  ceo: 0,
  tellSeats: true,
  seats: [
    { label: 'researcher', owns: 'Research', agent: 'claude' },
    { label: 'reviewer', owns: 'Reviews', agent: 'codex' },
    { label: 'notes', owns: '' },
  ],
  ...over,
});

describe('seatLaunches', () => {
  it('names each seat free of the labels panes carry, and starts each agent with its brief', () => {
    const res = seatLaunches(req(), { dir, platform: 'darwin', takenLabels: () => ['Researcher'] });
    const brief = (n: number) => path.join(dir, 'company-briefs', 'ws-1', `seat-${n}.md`);
    expect(res).toEqual({
      ok: true,
      labels: ['researcher-2', 'reviewer', 'notes'],
      commands: [`claude "$(cat '${brief(1)}')"`, `codex "$(cat '${brief(2)}')"`, null],
    });
    // The briefs name the seats as they were made.
    expect(fs.readFileSync(brief(1), 'utf8')).toContain('You are #researcher-2, the CEO of the company "checkout"');
    expect(fs.readFileSync(brief(2), 'utf8')).toContain('Your CEO is #researcher-2.');
  });

  it('starts the bare agent when the seats are not told, and writes the PowerShell form on Windows', () => {
    expect(seatLaunches(req({ tellSeats: false }), { dir, takenLabels: () => [] })).toMatchObject({ commands: ['claude', 'codex', null] });
    const win = seatLaunches(req(), { dir, platform: 'win32', takenLabels: () => [] });
    expect(win.ok && win.commands[0]).toMatch(/^claude "\$\(Get-Content -Raw -Encoding UTF8 -LiteralPath '.*seat-1\.md'/);
  });

  it('writes nothing for seats a company cannot have, or a bad request', () => {
    const none = { dir, takenLabels: () => [] };
    expect(seatLaunches(req({ seats: [{ label: '../../x', owns: '', agent: 'claude' }, { label: 'a b', owns: '' }] }), none).ok).toBe(false);
    expect(seatLaunches(req({ seats: [{ label: 'ok', owns: '', agent: 'rm -rf' }] }), none).ok).toBe(false);
    expect(seatLaunches(req({ workspaceId: '../x' }), none).ok).toBe(false);
    expect(seatLaunches(req({ ceo: 7 }), none).ok).toBe(false);
    expect(fs.existsSync(path.join(dir, 'company-briefs'))).toBe(false);
  });

  it('removes brief folders older than a week when the next company is made', () => {
    const old = path.join(dir, 'company-briefs', 'ws-old');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'seat-1.md'), 'x');
    const now = Date.now() + SEAT_BRIEF_KEEP_MS + 60_000;
    expect(seatLaunches(req(), { dir, platform: 'darwin', takenLabels: () => [], now: () => now }).ok).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'company-briefs', 'ws-1', 'seat-1.md'))).toBe(true);
  });
});
