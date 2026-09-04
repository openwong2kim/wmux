// F15 — the marker main attaches and the renderer takes off again. Both
// processes handle this string, so the contract is tested once, here.

import { describe, it, expect } from 'vitest';
import {
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
