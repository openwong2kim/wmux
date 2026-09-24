// F15 — the marker main attaches and the renderer takes off again. Both
// processes handle this string, so the contract is tested once, here.

import { describe, it, expect } from 'vitest';
import {
  FANOUT_WORKER_ALLOWED_TOOLS,
  FANOUT_WORKER_DISALLOWED_TOOLS,
  applyWorkerPermissionFlags,
  workerLaunchFlags,
  MODEL_ENV_MARKER,
  WORKER_GATEWAY_ENV,
  WORKER_MODEL_ENV,
  isSimpleLaunchCommand,
  reattachModelEnvMarker,
  shellSupportsModelEnvMarker,
  splitModelEnvMarker,
} from '../workerLaunch';

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

  it('appends the mode and both tool lists after the prompt', () => {
    expect(applyWorkerPermissionFlags(`claude ${PROMPT}`, 'auto')).toBe(
      `claude ${PROMPT} --permission-mode auto ${LISTS}`,
    );
    expect(applyWorkerPermissionFlags(`claude ${PROMPT}`, 'bypassPermissions')).toBe(
      `claude ${PROMPT} --dangerously-skip-permissions ${LISTS}`,
    );
    expect(workerLaunchFlags('acceptEdits')).toBe(`--permission-mode acceptEdits ${LISTS}`);
  });

  it('replaces every spelling of a permission or tool-list flag a role binding put on the line', () => {
    const bound =
      `claude --model opus --dangerously-skip-permissions "--allow-dangerously-skip-permissions" ` +
      `--allowedTools "Bash(git *)" Edit --disallowed-tools=Read ${PROMPT} --permission-mode=plan`;
    const out = applyWorkerPermissionFlags(bound, 'acceptEdits');
    expect(out).toBe(`claude --model opus ${PROMPT} --permission-mode acceptEdits ${LISTS}`);
  });

  it('never edits a flag spelled inside a quoted argument', () => {
    const line = `claude --append-system-prompt "never use --permission-mode auto or --dangerously-skip-permissions" ${PROMPT}`;
    expect(applyWorkerPermissionFlags(line, 'auto')).toBe(`${line} --permission-mode auto ${LISTS}`);
  });

  it('leaves the quoted prompt path byte-for-byte intact', () => {
    const spaced = `claude "$(cat '/tmp/a  b/prompt.md')"`;
    expect(applyWorkerPermissionFlags(spaced, 'auto').startsWith(spaced + ' ')).toBe(true);
  });

  it("manual adds no permission flag and keeps the line's own, but still applies the tool lists", () => {
    const line = `claude --permission-mode plan ${PROMPT}`;
    expect(applyWorkerPermissionFlags(line, 'manual')).toBe(`${line} ${LISTS}`);
  });

  it('does not touch a non-claude launch or a wrapped one', () => {
    for (const line of [`codex --model o3 ${PROMPT}`, `env FOO=1 claude ${PROMPT}`, `sh -c 'claude hi'`]) {
      expect(applyWorkerPermissionFlags(line, 'auto')).toBe(line);
    }
  });

  it('allows only reporting tools and denies the ones that reach other agents', () => {
    expect(FANOUT_WORKER_ALLOWED_TOOLS).toEqual([
      'mcp__wmux__ledger_update',
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
