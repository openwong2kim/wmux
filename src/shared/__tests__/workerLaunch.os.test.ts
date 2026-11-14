// F15 — the marker main attaches and the renderer takes off again. Both
// processes handle this string, so the contract is tested once, here.

import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  FANOUT_WORKER_ALLOWED_TOOLS,
  FANOUT_WORKER_DISALLOWED_TOOLS,
  applyWorkerPermissionFlags,
  deniedWorkerReportTools,
  workerLaunchFlags,
  toolRuleCovers,
  MODEL_ENV_MARKER,
  WORKER_GATEWAY_ENV,
  WORKER_MODEL_ENV,
  isSimpleLaunchCommand,
  reattachModelEnvMarker,
  shellSupportsModelEnvMarker,
  splitModelEnvMarker,
  workerModeRefusal,
  FANOUT_WORKER_PERMISSION_MODES,
} from '../workerLaunch';
import { FANOUT_AGENTS } from '../fanoutPreset';
import { promptFileArgument } from '../promptFileArgument';
import { AGENT_ROWS, agentRow } from '../agentIdentity';

const CODEX_MANUAL_FLAGS = '-a on-request -s read-only -c approvals_reviewer=user';
const GROK_MANUAL_FLAGS = '--permission-mode default';

describe('MODEL_ENV_MARKER', () => {
  it('unsets the model in the SAME shell, so an aliased launcher still resolves', () => {
    // `env -u VAR claude` execs a binary; `claude migrate-installer` leaves many
    // machines with only an alias, and that form dies before claude ever runs.
    expect(MODEL_ENV_MARKER.startsWith('env ')).toBe(false);
    expect(MODEL_ENV_MARKER).toContain(`unset ${WORKER_MODEL_ENV}`);
    expect(MODEL_ENV_MARKER.endsWith('; ')).toBe(true);
  });

  it('stands down when a gateway is routing claude', () => {
    // A gateway needs its own model name; unsetting it makes claude ask that
    // endpoint for a default claude-* model it does not serve.
    expect(MODEL_ENV_MARKER).toContain(`-n "$${WORKER_GATEWAY_ENV}"`);
  });

  // What a model-less worker's shell keeps, run through the marker itself.
  const modelAfterMarker = (env: Record<string, string>): string =>
    spawnSync('sh', ['-c', `${MODEL_ENV_MARKER}printf %s "$${WORKER_MODEL_ENV}"`], {
      env: { PATH: process.env.PATH ?? '', [WORKER_MODEL_ENV]: 'provider-model', ...env },
      encoding: 'utf8',
    }).stdout;

  it.skipIf(process.platform === 'win32')('keeps the model on Bedrock or Vertex, which set no base URL', () => {
    expect(modelAfterMarker({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('provider-model');
    expect(modelAfterMarker({ CLAUDE_CODE_USE_VERTEX: '1' })).toBe('provider-model');
    expect(modelAfterMarker({ [WORKER_GATEWAY_ENV]: 'https://gateway.example' })).toBe('provider-model');
    expect(modelAfterMarker({})).toBe('');
  });
});

describe('splitModelEnvMarker', () => {
  it('round-trips the exact marker', () => {
    const cmd = `${MODEL_ENV_MARKER}claude "$(cat '/m/p.md')"`;
    expect(splitModelEnvMarker(cmd)).toEqual({
      marker: MODEL_ENV_MARKER,
      command: "claude \"$(cat '/m/p.md')\"",
    });
  });

  it('leaves a command that never carried one untouched', () => {
    expect(splitModelEnvMarker('claude --model opus')).toEqual({ marker: '', command: 'claude --model opus' });
    expect(splitModelEnvMarker('unset SOMETHING_ELSE; claude').marker).toBe('');
  });
});

describe('isSimpleLaunchCommand', () => {
  it('accepts a launcher with flags', () => {
    expect(isSimpleLaunchCommand('claude')).toBe(true);
    expect(isSimpleLaunchCommand('/opt/bin/claude --dangerously-skip-permissions')).toBe(true);
  });

  it('rejects anything the marker would change the meaning of', () => {
    for (const cmd of ['claude && echo', 'claude; echo', 'a | claude', 'claude `x`', 'claude $(x)', 'FOO=1 claude', 'claude\necho']) {
      expect(isSimpleLaunchCommand(cmd)).toBe(false);
    }
  });
});

describe('shellSupportsModelEnvMarker', () => {
  it('accepts the Bourne family, and an absent shell (the platform default)', () => {
    for (const sh of [undefined, '/bin/zsh', '/bin/bash', '/usr/bin/sh', '/bin/dash']) {
      expect(shellSupportsModelEnvMarker(sh)).toBe(true);
    }
  });

  it('refuses a shell that cannot run it — fish has no `unset` at all', () => {
    for (const sh of ['/opt/homebrew/bin/fish', '/usr/bin/pwsh', 'C:\\pwsh.exe', '/usr/bin/nu', '/bin/tcsh']) {
      expect(shellSupportsModelEnvMarker(sh)).toBe(false);
    }
  });
});

describe('reattachModelEnvMarker', () => {
  it('puts the marker back on a command that still names no model', () => {
    const r = reattachModelEnvMarker(MODEL_ENV_MARKER, 'claude "$(cat \'/m/p.md\')"', '/bin/zsh');
    expect(r.command.startsWith(MODEL_ENV_MARKER)).toBe(true);
    expect(r.dropped).toBeUndefined();
  });

  it('drops it once the role binding pinned a model — the flag beats the env', () => {
    const r = reattachModelEnvMarker(MODEL_ENV_MARKER, 'codex --model o3 "$(cat \'/m/p.md\')"', '/bin/zsh');
    expect(r.command).toBe('codex --model o3 "$(cat \'/m/p.md\')"');
    expect(r.dropped).toBe('model-bound');
  });

  it('drops it on a shell whose grammar it is not written in', () => {
    const r = reattachModelEnvMarker(MODEL_ENV_MARKER, 'claude', '/opt/homebrew/bin/fish');
    expect(r.command).toBe('claude');
    expect(r.dropped).toBe('shell');
  });

  it('does not invent one where main attached none', () => {
    expect(reattachModelEnvMarker('', 'claude', '/bin/zsh')).toEqual({ command: 'claude' });
  });

  it('is not fooled by a prompt path that reads like a flag', () => {
    // The quoted argument is one token; a whitespace split would read its words.
    const r = reattachModelEnvMarker(MODEL_ENV_MARKER, 'claude "$(cat \'/m/--model opus/p.md\')"', undefined);
    expect(r.command.startsWith(MODEL_ENV_MARKER)).toBe(true);
  });
});

// Fan-out worker launch flags. The flags must land AFTER the prompt argument
// (the list flags are variadic and would swallow it), exactly once, only on a
// claude launch, and never by editing text inside a quoted argument.
describe('applyWorkerPermissionFlags', () => {
  const PROMPT = `"$(cat '/tmp/meta/task one/prompt.md')"`;
  const LISTS = `--allowedTools "${FANOUT_WORKER_ALLOWED_TOOLS.join(',')}" --disallowedTools "${FANOUT_WORKER_DISALLOWED_TOOLS.join(',')}"`;
  /** wmux's lists with the launcher's own deny rules after wmux's. */
  const listsDenying = (...own: string[]): string =>
    `--allowedTools "${FANOUT_WORKER_ALLOWED_TOOLS.join(',')}" --disallowedTools "${[...FANOUT_WORKER_DISALLOWED_TOOLS, ...own].join(',')}"`;
  const modeFlag = {
    auto: '--permission-mode auto',
    acceptEdits: '--permission-mode acceptEdits',
    bypassPermissions: '--dangerously-skip-permissions',
    manual: '--permission-mode default',
  } as const;

  it('appends the mode and both tool lists after the prompt', () => {
    expect(applyWorkerPermissionFlags(`claude ${PROMPT}`, 'auto')).toBe(
      `claude ${PROMPT} --permission-mode auto ${LISTS}`,
    );
    expect(applyWorkerPermissionFlags(`claude ${PROMPT}`, 'bypassPermissions')).toBe(
      `claude ${PROMPT} --dangerously-skip-permissions ${LISTS}`,
    );
    expect(workerLaunchFlags('acceptEdits')).toBe(`--permission-mode acceptEdits ${LISTS}`);
  });

  it('never allows a tool it also denies, whatever extra rules are added', () => {
    const lists = (line: string): [string[], string[]] => [
      (line.match(/--allowedTools "([^"]*)"/)?.[1] ?? '').split(','),
      (line.match(/--disallowedTools "([^"]*)"/)?.[1] ?? '').split(','),
    ];
    for (const extra of [[], [FANOUT_WORKER_ALLOWED_TOOLS[0]], ['mcp__wmux__*']]) {
      const [allowed, denied] = lists(workerLaunchFlags('auto', extra));
      expect(allowed.filter((tool) => denied.some((rule) => toolRuleCovers(rule, tool)))).toEqual([]);
    }
    // The base lists alone are unchanged.
    expect(lists(workerLaunchFlags('auto'))[0]).toEqual([...FANOUT_WORKER_ALLOWED_TOOLS]);
  });

  it('replaces every spelling of a permission or tool-list flag a role binding put on the line', () => {
    const bound =
      `claude --model opus --dangerously-skip-permissions "--allow-dangerously-skip-permissions" ` +
      `--allowedTools "Bash(git *)" Edit --disallowed-tools=Read ${PROMPT} --permission-mode=plan`;
    const out = applyWorkerPermissionFlags(bound, 'acceptEdits');
    // The binding's own deny (Read) stays denied; its allow list does not stay.
    expect(out).toBe(`claude --model opus ${PROMPT} --permission-mode acceptEdits ${listsDenying('Read')}`);
  });

  it("keeps a launcher's own denied tools denied for its workers, in every form", () => {
    for (const own of [
      '--disallowedTools Bash PowerShell',
      '--disallowedTools=Bash,PowerShell',
      '--disallowedTools "Bash,PowerShell"',
      '--disallowedTools "Bash PowerShell"',
      '--disallowed-tools Bash,PowerShell',
      '--disallowed-tools=Bash --disallowedTools PowerShell',
    ]) {
      for (const mode of FANOUT_WORKER_PERMISSION_MODES) {
        const line = `claude ${own} ${PROMPT}`;
        expect(workerModeRefusal(line, mode)).toBeNull();
        expect(applyWorkerPermissionFlags(line, mode)).toBe(`claude ${PROMPT} ${modeFlag[mode]} ${listsDenying('Bash', 'PowerShell')}`);
      }
    }
    // A rule with an argument stays one rule, spaces and all.
    expect(applyWorkerPermissionFlags(`claude --disallowedTools "Bash(git push*),Edit" ${PROMPT}`, 'auto')).toBe(
      `claude ${PROMPT} --permission-mode auto ${listsDenying('Bash(git push*)', 'Edit')}`,
    );
    // The allow list and the permission mode are still replaced.
    expect(applyWorkerPermissionFlags(`claude --allowedTools Bash --permission-mode bypassPermissions --disallowedTools Edit ${PROMPT}`, 'auto')).toBe(
      `claude ${PROMPT} --permission-mode auto ${listsDenying('Edit')}`,
    );
  });

  it("does not repeat a launcher's deny that wmux already denies", () => {
    expect(applyWorkerPermissionFlags(`claude --disallowedTools mcp__wmux__fanout_start,Bash ${PROMPT}`, 'auto')).toBe(
      `claude ${PROMPT} --permission-mode auto ${listsDenying('Bash')}`,
    );
    // Nor one a wmux wildcard already covers.
    expect(applyWorkerPermissionFlags(`claude --disallowedTools mcp__wmux__browser_click ${PROMPT}`, 'auto')).toBe(
      `claude ${PROMPT} --permission-mode auto ${LISTS}`,
    );
  });

  it('never takes a quoted sentence after a deny flag for tool rules, and refuses the line', () => {
    // The sentence is not made into rules; only the deny flag's own rule is carried.
    const line = `claude --disallowedTools Bash "Read the README first"`;
    expect(applyWorkerPermissionFlags(line, 'auto')).toBe(`claude "Read the README first" --permission-mode auto ${listsDenying('Bash')}`);
    // claude reads every word up to the next flag as a rule, so such a line is refused rather than guessed at.
    expect(workerModeRefusal(line, 'auto')).toContain('was not started');
  });

  it('carries every rule of a deny list and its quoted space form, * included; only the prompt argument may follow', () => {
    const own = `claude --disallowedTools Read "* Bash"`;
    expect(workerModeRefusal(`${own} ${PROMPT}`, 'auto')).toBeNull();
    expect(applyWorkerPermissionFlags(`${own} ${PROMPT}`, 'auto')).toBe(
      // Bash is not repeated: the `*` before it already covers it.
      `claude ${PROMPT} --permission-mode auto --disallowedTools "${[...FANOUT_WORKER_DISALLOWED_TOOLS, 'Read', '*'].join(',')}"`,
    );
    // The prompt argument exactly as main builds it may follow a deny list, on either platform.
    for (const [platform, file] of [['win32', 'C:\\p\\task one\\prompt.md'], ['linux', '/tmp/p/task one/prompt.md'], ['darwin', '/tmp/p/prompt.md']] as const) {
      expect(workerModeRefusal(`claude --disallowedTools Bash ${promptFileArgument(file, platform)}`, 'auto')).toBeNull();
    }
    // Any other word after the rules is a deny wmux cannot carry, a launcher's own `$(…)` included.
    expect(workerModeRefusal(`claude --disallowedTools Read "rm -rf" ${PROMPT}`, 'auto')).toContain('was not started');
    expect(workerModeRefusal(`claude --disallowedTools Read "$(printf Bash)" ${PROMPT}`, 'auto')).toContain('was not started');
    // Even one of the prompt's own shape: wmux's prompt is the last one, appended after the launcher.
    expect(workerModeRefusal(`claude --disallowedTools Read "$(cat '/tmp/denies')" ${PROMPT}`, 'auto')).toContain('was not started');
    expect(workerModeRefusal(`claude --disallowedTools Read ${PROMPT}`, 'auto')).toBeNull();
    expect(workerModeRefusal(`claude --disallowedTools Read --model opus ${PROMPT}`, 'auto')).toBeNull();
  });

  it("a launcher's deny that covers a reporting tool takes it off the allow list, and is named", () => {
    const allowed = (line: string): string[] => (line.match(/--allowedTools "([^"]*)"/)?.[1] ?? '').split(',').filter(Boolean);
    const one = applyWorkerPermissionFlags(`claude --disallowedTools mcp__wmux__ledger_update ${PROMPT}`, 'auto');
    expect(allowed(one)).toEqual(FANOUT_WORKER_ALLOWED_TOOLS.filter((t) => t !== 'mcp__wmux__ledger_update'));
    expect(deniedWorkerReportTools(one)).toEqual(['mcp__wmux__ledger_update']);
    // A server's rule denies every tool of it.
    const all = applyWorkerPermissionFlags(`claude --disallowedTools mcp__wmux ${PROMPT}`, 'auto');
    expect(allowed(all)).toEqual([]);
    // No allow list at all rather than an empty word, and applying again changes nothing.
    expect(all).not.toContain('--allowedTools');
    expect(applyWorkerPermissionFlags(all, 'auto')).toBe(all);
    expect(deniedWorkerReportTools(all)).toEqual([...FANOUT_WORKER_ALLOWED_TOOLS]);
    // A line wmux gave no worker lists to (a codex or grok line) is not read as one.
    expect(deniedWorkerReportTools(`grok --permission-mode default --disallowedTools mcp__wmux ${PROMPT}`)).toEqual([]);
    expect(toolRuleCovers('mcp__wmux', 'mcp__wmux__ledger_update')).toBe(true);
    expect(toolRuleCovers('mcp__wmux__ledger_update', 'mcp__wmux__ledger_update_x')).toBe(false);
    expect(toolRuleCovers('mcp__wmuxx', 'mcp__wmux__ledger_update')).toBe(false);
    // Tool-name globs anywhere in the name, and `*` alone (every tool).
    expect(toolRuleCovers('mcp__wmux__*update', 'mcp__wmux__ledger_update')).toBe(true);
    expect(toolRuleCovers('mcp__wmux__*update', 'mcp__wmux__task_push')).toBe(false);
    expect(toolRuleCovers('Bash(git *)', 'Bash')).toBe(false);
    const glob = applyWorkerPermissionFlags(`claude --disallowedTools 'mcp__wmux__*update' ${PROMPT}`, 'auto');
    expect(deniedWorkerReportTools(glob)).toEqual(['mcp__wmux__ledger_update']);
    const every = applyWorkerPermissionFlags(`claude --disallowedTools "*" ${PROMPT}`, 'auto');
    expect(workerModeRefusal(`claude --disallowedTools "*" ${PROMPT}`, 'auto')).toBeNull();
    expect(every).toBe(`claude ${PROMPT} --permission-mode auto --disallowedTools "${[...FANOUT_WORKER_DISALLOWED_TOOLS, '*'].join(',')}"`);
    expect(deniedWorkerReportTools(every)).toEqual([...FANOUT_WORKER_ALLOWED_TOOLS]);
    // wmux's own lists deny none of them.
    expect(deniedWorkerReportTools(applyWorkerPermissionFlags(`claude ${PROMPT}`, 'auto'))).toEqual([]);
  });

  it('refuses a launch whose own deny rule cannot be quoted on the worker line, rather than dropping it', () => {
    for (const rule of [
      `'Bash(echo "x")'`, `'Bash(rm $HOME)'`, `'Bash(a\`b)'`, `'Bash(a\\b)'`, `'Bash(rm !(*.keep))'`, `'Bash(echo %TEMP%)'`, `'Bash(echo it''s)'`,
      // A backslash the words drop (bash keeps it before q inside double quotes).
      `"Bash(echo \\q)"`,
      // A value that is no tool rule: claude would read it as one, so it cannot just be dropped.
      `"rm -rf"`,
    ]) {
      const line = `claude --disallowedTools ${rule} ${PROMPT}`;
      for (const mode of FANOUT_WORKER_PERMISSION_MODES) {
        const refusal = workerModeRefusal(line, mode);
        expect(refusal).toContain('was not started');
        // The refusal does not repeat the rule.
        expect(refusal).not.toContain('Bash(');
      }
      // Never written into the quoted list either.
      expect(applyWorkerPermissionFlags(line, 'auto').endsWith(`--permission-mode auto ${LISTS}`)).toBe(true);
    }
  });

  it('leaves the manual ask path of codex and grok as it was, own deny flags included', () => {
    expect(applyWorkerPermissionFlags(`grok --disallowedTools Bash ${PROMPT}`, 'manual')).toBe(`grok ${GROK_MANUAL_FLAGS} --disallowedTools Bash ${PROMPT}`);
    expect(workerModeRefusal(`grok --disallowedTools 'Bash(echo "x")' ${PROMPT}`, 'manual')).toBeNull();
    expect(applyWorkerPermissionFlags(`codex --disallowedTools Bash ${PROMPT}`, 'manual')).toBe(`codex ${CODEX_MANUAL_FLAGS} --disallowedTools Bash ${PROMPT}`);
  });

  it('never edits a flag spelled inside a quoted argument', () => {
    const line = `claude --append-system-prompt "never use --permission-mode auto or --dangerously-skip-permissions" ${PROMPT}`;
    expect(applyWorkerPermissionFlags(line, 'auto')).toBe(`${line} --permission-mode auto ${LISTS}`);
  });

  it('leaves the quoted prompt path byte-for-byte intact', () => {
    const spaced = `claude "$(cat '/tmp/a  b/prompt.md')"`;
    expect(applyWorkerPermissionFlags(spaced, 'auto').startsWith(spaced + ' ')).toBe(true);
  });

  it("manual makes claude ask: a mode of the line's own that does not ask is replaced, and the tool lists still apply", () => {
    for (const own of ['--permission-mode auto', '--permission-mode=acceptEdits', '--permission-mode dontAsk', '--permission-mode bypassPermissions', '--dangerously-skip-permissions', '--permission-mode plan --dangerously-skip-permissions', '--permission-mode plan --permission-mode auto']) {
      expect(applyWorkerPermissionFlags(`claude ${own} ${PROMPT}`, 'manual')).toBe(`claude ${PROMPT} --permission-mode default ${LISTS}`);
    }
  });

  it("manual keeps a mode of the line's own that already asks: a resumed plan worker stays in plan", () => {
    for (const own of ['--permission-mode plan', '--permission-mode=plan', '--permission-mode default', '--permission-mode manual']) {
      expect(applyWorkerPermissionFlags(`claude --resume 0b6f ${own}`, 'manual')).toBe(`claude --resume 0b6f ${own} ${LISTS}`);
    }
    // Any other worker mode still replaces it.
    expect(applyWorkerPermissionFlags('claude --resume 0b6f --permission-mode plan', 'acceptEdits')).toBe(`claude --resume 0b6f --permission-mode acceptEdits ${LISTS}`);
  });

  it('each mode gives claude its own permission flag', () => {
    const flags = {
      auto: '--permission-mode auto',
      acceptEdits: '--permission-mode acceptEdits',
      bypassPermissions: '--dangerously-skip-permissions',
      manual: '--permission-mode default',
    } as const;
    expect(Object.keys(flags).sort()).toEqual([...FANOUT_WORKER_PERMISSION_MODES].sort());
    for (const mode of FANOUT_WORKER_PERMISSION_MODES) {
      expect(applyWorkerPermissionFlags(`claude ${PROMPT}`, mode)).toBe(`claude ${PROMPT} ${flags[mode]} ${LISTS}`);
      expect(workerModeRefusal(`claude ${PROMPT}`, mode)).toBeNull();
    }
  });

  it('manual makes codex ask: every permission choice on its line goes, and its ask flags go before the prompt', () => {
    expect(agentRow('codex')?.askMode?.flags).toBe(CODEX_MANUAL_FLAGS);
    const trust = `-c 'projects={"/w"={trust_level="trusted"}}'`;
    for (const own of ['-a never -s workspace-write', '--ask-for-approval=never --sandbox danger-full-access', '--yolo', '--dangerously-bypass-approvals-and-sandbox', '-c approval_policy=never -c sandbox_mode=workspace-write', `-c 'sandbox_permissions=["disk-full-read-access"]'`, `-c 'approvals_reviewer="auto_review"'`, '--config approvals_reviewer=guardian_subagent', '--approve-for-me', '']) {
      const line = `codex ${trust} ${own} ${PROMPT}`.replace(/  +/g, ' ');
      expect(applyWorkerPermissionFlags(line, 'manual')).toBe(`codex ${CODEX_MANUAL_FLAGS} ${trust} ${PROMPT}`);
      expect(workerModeRefusal(line, 'manual')).toBeNull();
    }
    // The other modes still leave a codex line as it is (a separate item).
    expect(applyWorkerPermissionFlags(`codex -a never ${PROMPT}`, 'auto')).toBe(`codex -a never ${PROMPT}`);
  });

  it('manual makes grok ask: its permission mode and always-approve go, and its ask mode goes before the prompt', () => {
    expect(agentRow('grok')?.askMode?.flags).toBe(GROK_MANUAL_FLAGS);
    for (const own of ['--permission-mode bypassPermissions', '--permission-mode=auto', '--always-approve', '--permission-mode dontAsk --always-approve', '']) {
      const line = `grok ${own} ${PROMPT}`.replace(/  +/g, ' ');
      expect(applyWorkerPermissionFlags(line, 'manual')).toBe(`grok ${GROK_MANUAL_FLAGS} ${PROMPT}`);
      expect(workerModeRefusal(line, 'manual')).toBeNull();
    }
    expect(applyWorkerPermissionFlags(`grok --always-approve ${PROMPT}`, 'auto')).toBe(`grok --always-approve ${PROMPT}`);
  });

  it('manual is taken exactly for the agents whose row declares how to make them ask (claude, codex, grok)', () => {
    const asks = AGENT_ROWS.filter((r) => r.permissions === 'permission-mode' || r.askMode).map((r) => r.slug).sort();
    expect(asks).toEqual(['claude', 'codex', 'grok']);
    for (const row of AGENT_ROWS) {
      const stem = row.launcher ?? row.slug;
      expect(workerModeRefusal(`${stem} ${PROMPT}`, 'manual') === null).toBe(asks.includes(row.slug));
    }
  });

  it('manual is refused for every agent but claude, codex and grok (agy included), and for a wrapped line; the other modes are never refused', () => {
    const agents = FANOUT_AGENTS.map((a) => a.stem);
    expect(agents).toEqual(expect.arrayContaining(['claude', 'codex', 'grok', 'agy']));
    expect(workerModeRefusal(`agy ${PROMPT}`, 'manual')).toContain('`agy`');
    for (const stem of agents.filter((a) => a !== 'claude' && a !== 'codex' && a !== 'grok')) {
      expect(workerModeRefusal(`${stem} ${PROMPT}`, 'manual')).toContain(`\`${stem}\``);
      for (const mode of FANOUT_WORKER_PERMISSION_MODES.filter((m) => m !== 'manual')) expect(workerModeRefusal(`${stem} ${PROMPT}`, mode)).toBeNull();
    }
    for (const line of [`env FOO=1 claude ${PROMPT}`, `sh -c 'claude hi'`]) expect(workerModeRefusal(line, 'manual')).not.toBeNull();
    // A quoted Windows path keeps its backslashes, and its extension is dropped.
    expect(workerModeRefusal(`'C:\\tools\\claude.exe' ${PROMPT}`, 'manual')).toBeNull();
  });

  it('does not touch a non-claude launch or a wrapped one', () => {
    for (const line of [`codex --model o3 ${PROMPT}`, `env FOO=1 claude ${PROMPT}`, `sh -c 'claude hi'`]) {
      expect(applyWorkerPermissionFlags(line, 'auto')).toBe(line);
    }
  });

  it('allows only reporting tools and denies the ones that reach other agents', () => {
    expect(FANOUT_WORKER_ALLOWED_TOOLS).toEqual([
      'mcp__wmux__ledger_update',
      'mcp__wmux__task_push',
      'mcp__wmux__task_fetch',
      'mcp__wmux__channel_read',
      'mcp__wmux__channel_unread',
      'mcp__wmux__channel_ack',
      'mcp__wmux__a2a_task_query',
      'mcp__wmux__a2a_whoami',
    ]);
    // A post can pin a mention into another agent's prompt.
    expect(FANOUT_WORKER_ALLOWED_TOOLS).not.toContain('mcp__wmux__channel_post');
    expect(FANOUT_WORKER_ALLOWED_TOOLS).not.toContain('mcp__wmux');
    for (const t of ['mcp__wmux__fanout_start', 'mcp__wmux__terminal_send', 'mcp__wmux__send_message', 'mcp__wmux__browser_*']) {
      expect(FANOUT_WORKER_DISALLOWED_TOOLS).toContain(t);
    }
  });
});
