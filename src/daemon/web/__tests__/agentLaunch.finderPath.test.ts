import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A daemon started by an app launched from Finder inherits launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin). The phone's "start Codex/Claude" probe ran
// `claude --help` / `codex --help` with that PATH, got exit 127, and reported
// agent-not-installed. These run the real probe under that PATH.
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const CLAUDE_HELP = "Claude Code\n --model <model> alias 'sonnet'";
const CODEX_HELP = 'Codex CLI\n --model <MODEL>\n --config <key=value>';

function fakeBin(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe.skipIf(process.platform === 'win32')('agent probe under a Finder-launched PATH', () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: process.env.SHELL };
  let home: string;

  beforeEach(() => {
    vi.resetModules(); // helpCache and the login-shell cache are module-level
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-agent-path-'));
    process.env.PATH = LAUNCHD_PATH;
    process.env.HOME = home;
    process.env.SHELL = path.join(home, 'missing', 'zsh'); // login-shell probe fails → static fallbacks only
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const probe = async () => {
    const { installedAgentLaunchOptions } = await import('../agentLaunch');
    const options = await installedAgentLaunchOptions({ CODEX_HOME: path.join(home, '.codex') });
    return options.map((option) => option.agent);
  };

  it('finds agents installed in ~/.local/bin', async () => {
    fakeBin(path.join(home, '.local', 'bin'), 'claude', `printf '%s' "${CLAUDE_HELP}"`);
    fakeBin(path.join(home, '.local', 'bin'), 'codex', `printf '%s' "${CODEX_HELP}"`);
    expect(await probe()).toEqual(['claude', 'codex']);
  });

  it('finds an agent only the login shell PATH knows about (npm prefix set in an rc file)', async () => {
    const npmBin = path.join(home, '.local', 'node', 'bin');
    fakeBin(npmBin, 'codex', `printf '%s' "${CODEX_HELP}"`);
    // Stands in for zsh: prints rc noise, then runs the `-ilc` command with the rc's PATH.
    fakeBin(path.join(home, 'shell'), 'zsh', `echo 'rc noise'\nPATH="${npmBin}:$PATH"; export PATH\neval "$2"`);
    process.env.SHELL = path.join(home, 'shell', 'zsh');
    expect(await probe()).toContain('codex');

    const { withAgentExecPath } = await import('../../../shared/execEnv');
    const entries = (withAgentExecPath({ PATH: LAUNCHD_PATH }).PATH ?? '').split(':');
    expect(entries.slice(0, 4)).toEqual(LAUNCHD_PATH.split(':')); // an existing PATH still wins
    expect(entries).toContain(npmBin);
  });
});
