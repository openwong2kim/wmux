import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seatLaunches } from '../seatLaunch';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-seat-launch-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('seatLaunches', () => {
  it('starts each seat with its brief file as the first prompt', () => {
    const res = seatLaunches({
      workspaceId: 'ws-1',
      seats: [
        { label: 'researcher', agent: 'claude', brief: 'You are #researcher.' },
        { label: 'reviewer', agent: 'codex', brief: 'You are #reviewer.' },
        { label: 'dev-1', agent: 'claude' },
        { label: 'shell' },
      ],
    }, { dir, platform: 'darwin' });
    const file = path.join(dir, 'company-briefs', 'ws-1', 'researcher.md');
    expect(res).toEqual({
      ok: true,
      commands: [
        `claude "$(cat '${file}')"`,
        `codex "$(cat '${path.join(dir, 'company-briefs', 'ws-1', 'reviewer.md')}')"`,
        'claude',
        null,
      ],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('You are #researcher.');
  });

  it('writes the PowerShell form on Windows', () => {
    const res = seatLaunches({ workspaceId: 'ws-1', seats: [{ label: 'lead', agent: 'claude', brief: 'x' }] }, { dir, platform: 'win32' });
    expect(res.ok && res.commands[0]).toMatch(/^claude "\$\(Get-Content -Raw -Encoding UTF8 -LiteralPath '.*lead\.md'/);
  });

  it('writes nothing when any seat is invalid', () => {
    const written: string[] = [];
    const writeFile = (file: string) => { written.push(file); };
    expect(seatLaunches({ workspaceId: 'ws-1', seats: [{ label: 'ok', agent: 'claude', brief: 'x' }, { label: 'bad label', agent: 'claude' }] }, { dir, writeFile }).ok).toBe(false);
    expect(seatLaunches({ workspaceId: 'ws-1', seats: [{ label: 'ok', agent: 'rm -rf', brief: 'x' }] }, { dir, writeFile }).ok).toBe(false);
    expect(seatLaunches({ workspaceId: '../x', seats: [{ label: 'ok', agent: 'claude' }] }, { dir, writeFile }).ok).toBe(false);
    expect(seatLaunches({ workspaceId: 'ws-1', seats: [{ label: 'ok', agent: 'claude', brief: 'x'.repeat(17 * 1024) }] }, { dir, writeFile }).ok).toBe(false);
    expect(written).toEqual([]);
  });
});
