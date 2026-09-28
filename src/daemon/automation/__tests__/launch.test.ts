import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildExecArgs, PWSH_EXIT_TAIL } from '../../execWrapper';
import {
  buildAutomationCommand,
  buildAutomationEnv,
  permissionFlags,
  resolveAccountEnv,
  scrubAgentEnv,
} from '../launch';

describe('scheduled-run command line through the three wrapper shells', () => {
  const scoped = buildAutomationCommand('claude --model opus', 'claude', 'scoped', ['Read', 'Edit', 'mcp__wmux__pane_list']);

  it('bash -lc', () => {
    expect(buildExecArgs('/bin/bash', scoped)).toEqual([
      '-lc',
      'claude --model opus --allowedTools Read Edit mcp__wmux__pane_list',
    ]);
  });

  it('pwsh -Command (space-separated tools: a,b would be an array literal)', () => {
    expect(buildExecArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', scoped)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-Command',
      `claude --model opus --allowedTools Read Edit mcp__wmux__pane_list${PWSH_EXIT_TAIL}`,
    ]);
  });

  it('approval mode pins claude to its default permission mode in every wrapper', () => {
    const approval = buildAutomationCommand('claude --model opus', 'claude', 'approval', undefined);
    expect(buildExecArgs('/bin/zsh', approval)).toEqual(['-lc', 'claude --model opus --permission-mode default']);
    expect(buildExecArgs('pwsh', approval)?.[3]).toBe(`claude --model opus --permission-mode default${PWSH_EXIT_TAIL}`);
    expect(buildExecArgs('cmd.exe', approval)).toEqual(['/d', '/s', '/c', 'claude --model opus --permission-mode default']);
  });

  it('cmd /c', () => {
    expect(buildExecArgs('C:\\Windows\\System32\\cmd.exe', scoped)).toEqual([
      '/d',
      '/s',
      '/c',
      'claude --model opus --allowedTools Read Edit mcp__wmux__pane_list',
    ]);
  });

  it('fixed flag map for every agent × mode', () => {
    expect(buildAutomationCommand('claude', 'claude', 'approval', undefined)).toBe('claude --permission-mode default');
    expect(buildAutomationCommand('claude', 'claude', 'bypass', ['Read'])).toBe('claude --dangerously-skip-permissions');
    expect(buildAutomationCommand('codex', 'codex', 'approval', undefined)).toBe('codex');
    expect(buildAutomationCommand('codex -c model_reasoning_effort=high', 'codex', 'scoped', ['Read']))
      .toBe('codex -c model_reasoning_effort=high --sandbox workspace-write --ask-for-approval never');
    expect(buildAutomationCommand('codex', 'codex', 'bypass', undefined)).toBe('codex --dangerously-bypass-approvals-and-sandbox');
  });

  it('refuses any tool name that could reach a shell parser', () => {
    for (const bad of ['Read;rm -rf ~', 'Bash(rm:*)', '$(whoami)', '`id`', 'Read,Edit', 'A&calc', 'A|B', "Read'", 'Read"', '', '1Read', 'Read Edit']) {
      expect(() => permissionFlags('claude', 'scoped', [bad]), bad).toThrow();
    }
    expect(() => permissionFlags('claude', 'scoped', [])).toThrow();
  });

  it('every accepted command is plain words only', () => {
    for (const cmd of [scoped, buildAutomationCommand('codex', 'codex', 'scoped', undefined)]) {
      expect(cmd).toMatch(/^[A-Za-z0-9 ._=-]+$/);
    }
  });
});

describe('scheduled-run env', () => {
  it('scrubs agent-nesting markers and keeps the rest', () => {
    const out = scrubAgentEnv({
      PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', claude_config_dir: '/x',
      ANTHROPIC_MODEL: 'm', AI_AGENT: 'claude', HOME: '/h',
    });
    expect(out).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('stamps member id and CLAUDE_CODE_SANDBOXED; the account dir survives the scrub', () => {
    const env = buildAutomationEnv('auto-1', { PATH: '/bin', CLAUDE_CONFIG_DIR: '/inherited', WMUX_WORKSPACE_ID: 'ws' }, {
      CLAUDE_CONFIG_DIR: '/acct',
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/acct');
    expect(env.CLAUDE_CODE_SANDBOXED).toBe('1');
    expect(env.WMUX_MEMBER_ID).toBe('auto-1');
    expect(env.WMUX_WORKSPACE_ID).toBeUndefined();
  });

  it('resolves accounts.json read-only and refuses a missing/mismatched account', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-acct-'));
    const configDir = path.join(dir, 'claude-work');
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
      version: 1,
      accounts: [
        { id: 'a1', vendor: 'claude', configDir },
        { id: 'gone', vendor: 'claude', configDir: path.join(dir, 'nope') },
      ],
      bindings: {},
    }));
    expect(resolveAccountEnv(dir, 'claude', 'a1')).toEqual({ ok: true, env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(resolveAccountEnv(dir, 'codex', 'a1')).toEqual({ ok: false });
    expect(resolveAccountEnv(dir, 'claude', 'gone')).toEqual({ ok: false });
    expect(resolveAccountEnv(dir, 'claude', 'missing')).toEqual({ ok: false });
    expect(resolveAccountEnv(dir, 'claude', undefined)).toEqual({ ok: true, env: {} });
  });
});
