// Config-driven first-party client names (issue #636).
//
// Two things are under test and they are deliberately separate concerns:
//   - `readConfiguredFirstPartyClients` only READS. Every malformed shape must
//     degrade to `[]` (compiled defaults only) and must never throw, because it
//     runs on the boot path.
//   - `setConfiguredFirstPartyClients` is the only AUTHORISATION gate. The
//     denylist is enforced there rather than in the reader precisely so a
//     different caller cannot route around it — so it is tested directly, not
//     just through the reader.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_PLUGIN_NAME_LEN } from '../../../shared/rpc';
import { readConfiguredFirstPartyClients } from '../firstPartyConfig';
import {
  FIRST_PARTY_CLIENT_NAMES,
  NON_IDENTIFYING_CLIENT_NAMES,
  __resetConfiguredFirstPartyClientsForTests,
  getConfiguredFirstPartyClients,
  isFirstPartyClient,
  setConfiguredFirstPartyClients,
} from '../firstParty';

const tmpDirs: string[] = [];

function writeConfig(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fpconfig-test-'));
  tmpDirs.push(dir);
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, contents, 'utf-8');
  return p;
}

afterEach(() => {
  __resetConfiguredFirstPartyClientsForTests();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readConfiguredFirstPartyClients', () => {
  it('reads a well-formed mcp.firstPartyClients list', () => {
    const p = writeConfig(
      JSON.stringify({ mcp: { firstPartyClients: ['hermes-agent', 'aider'] } }),
    );
    expect(readConfiguredFirstPartyClients({ configPath: p })).toEqual([
      'hermes-agent',
      'aider',
    ]);
  });

  it('trims entries so stray whitespace still matches the reported clientName', () => {
    // PipeServer trims clientName when it builds RpcContext; an untrimmed
    // config entry would silently never match the name it was meant to allow.
    const p = writeConfig(
      JSON.stringify({ mcp: { firstPartyClients: ['  hermes-agent  '] } }),
    );
    expect(readConfiguredFirstPartyClients({ configPath: p })).toEqual([
      'hermes-agent',
    ]);
  });

  it('drops non-string and blank entries instead of failing the whole list', () => {
    const p = writeConfig(
      JSON.stringify({
        mcp: { firstPartyClients: ['hermes-agent', 42, null, '', '   ', { a: 1 }] },
      }),
    );
    expect(readConfiguredFirstPartyClients({ configPath: p })).toEqual([
      'hermes-agent',
    ]);
  });

  it.each([
    ['a missing file', null],
    ['invalid JSON', '{ not json'],
    ['a non-object root', '"a string"'],
    ['no mcp section', JSON.stringify({ version: 1 })],
    ['a non-object mcp section', JSON.stringify({ mcp: 'shadow' })],
    ['no firstPartyClients key', JSON.stringify({ mcp: { mode: 'enforce' } })],
    ['a non-array firstPartyClients', JSON.stringify({ mcp: { firstPartyClients: 'hermes' } })],
  ])('fails closed to [] on %s', (_label, contents) => {
    const p =
      contents === null
        ? path.join(os.tmpdir(), 'wmux-fpconfig-does-not-exist', 'config.json')
        : writeConfig(contents);
    expect(readConfiguredFirstPartyClients({ configPath: p })).toEqual([]);
  });

  it('strips __proto__ rather than polluting Object.prototype', () => {
    const p = writeConfig(
      '{"__proto__":{"polluted":true},"mcp":{"firstPartyClients":["hermes-agent"]}}',
    );
    expect(readConfiguredFirstPartyClients({ configPath: p })).toEqual([
      'hermes-agent',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('setConfiguredFirstPartyClients', () => {
  it('extends recognition without disturbing the compiled defaults', () => {
    expect(isFirstPartyClient('hermes-agent')).toBe(false);
    const res = setConfiguredFirstPartyClients(['hermes-agent']);
    expect(res.accepted).toEqual(['hermes-agent']);
    expect(res.rejected).toEqual([]);
    expect(isFirstPartyClient('hermes-agent')).toBe(true);
    // Compiled defaults still recognised, and the exported set is untouched.
    expect(isFirstPartyClient('claude-code')).toBe(true);
    expect(FIRST_PARTY_CLIENT_NAMES.has('hermes-agent')).toBe(false);
  });

  it('replaces the previous set rather than accumulating across calls', () => {
    setConfiguredFirstPartyClients(['hermes-agent']);
    setConfiguredFirstPartyClients(['aider']);
    expect(isFirstPartyClient('aider')).toBe(true);
    expect(isFirstPartyClient('hermes-agent')).toBe(false);
  });

  it('refuses every non-identifying name and reports why', () => {
    const names = [...NON_IDENTIFYING_CLIENT_NAMES];
    const res = setConfiguredFirstPartyClients(names);
    expect(res.accepted).toEqual([]);
    expect(res.rejected.map((r) => r.name).sort()).toEqual([...names].sort());
    for (const r of res.rejected) expect(r.reason).toBe('non-identifying');
    for (const n of names) expect(isFirstPartyClient(n)).toBe(false);
  });

  it('refuses `mcp` — the Python MCP SDK default that every unnamed client reports', () => {
    // The regression this whole feature exists to prevent: an operator reads
    // `mcp` out of the trust DB and pastes it into config, which would grant
    // recognition to every anonymous Python-SDK client at once.
    const res = setConfiguredFirstPartyClients(['mcp']);
    expect(res.accepted).toEqual([]);
    expect(isFirstPartyClient('mcp')).toBe(false);
  });

  it('refuses `wmux-cli`, which would silently widen the narrower CLI tier', () => {
    // The enforcer checks the first-party branch BEFORE the internal-CLI
    // branch, so configuring the CLI name would swap its curated allowlist for
    // the much larger first-party one.
    const res = setConfiguredFirstPartyClients(['wmux-cli']);
    expect(res.accepted).toEqual([]);
    expect(isFirstPartyClient('wmux-cli')).toBe(false);
  });

  it('applies the denylist case-insensitively', () => {
    const res = setConfiguredFirstPartyClients(['MCP', 'Unknown', 'WMUX-CLI']);
    expect(res.accepted).toEqual([]);
    expect(res.rejected).toHaveLength(3);
  });

  it('keeps good entries when the same list also contains refused ones', () => {
    const res = setConfiguredFirstPartyClients(['mcp', 'hermes-agent', 'unknown']);
    expect(res.accepted).toEqual(['hermes-agent']);
    expect(res.rejected.map((r) => r.name)).toEqual(['mcp', 'unknown']);
    expect(isFirstPartyClient('hermes-agent')).toBe(true);
  });

  it('trims, drops blanks, and de-duplicates', () => {
    const res = setConfiguredFirstPartyClients([
      ' hermes-agent ',
      'hermes-agent',
      '',
      '   ',
    ]);
    expect(res.accepted).toEqual(['hermes-agent']);
    expect(getConfiguredFirstPartyClients().size).toBe(1);
  });

  it('an empty list restores compiled-defaults-only recognition', () => {
    setConfiguredFirstPartyClients(['hermes-agent']);
    setConfiguredFirstPartyClients([]);
    expect(isFirstPartyClient('hermes-agent')).toBe(false);
    expect(isFirstPartyClient('claude-code')).toBe(true);
  });

  it('still requires an exact match — config entries are not prefixes or fuzzy', () => {
    setConfiguredFirstPartyClients(['hermes-agent']);
    for (const near of ['hermes', 'Hermes-Agent', 'hermes-agent-2', ' hermes-agent']) {
      expect(isFirstPartyClient(near)).toBe(false);
    }
  });

  it('matches a name the operator could only have seen truncated', () => {
    // The discover-and-configure flow this feature documents is: read the name
    // out of `wmux mcp clients`, paste it into config. PluginTrustStore
    // truncates at MAX_PLUGIN_NAME_LEN on write, so for a longer clientName the
    // ONLY value an operator can obtain is the truncated one — while RpcRouter
    // hands the enforcer the full string. Without clamping both sides the
    // documented flow silently cannot work for such a client.
    const full = 'a'.repeat(MAX_PLUGIN_NAME_LEN + 50);
    const asDisplayed = full.slice(0, MAX_PLUGIN_NAME_LEN);
    const res = setConfiguredFirstPartyClients([asDisplayed]);
    expect(res.accepted).toEqual([asDisplayed]);
    expect(isFirstPartyClient(full)).toBe(true);
  });

  it('clamps an over-long config entry so it is stored as it would be displayed', () => {
    const over = 'b'.repeat(MAX_PLUGIN_NAME_LEN + 10);
    const res = setConfiguredFirstPartyClients([over]);
    expect(res.accepted[0].length).toBe(MAX_PLUGIN_NAME_LEN);
    expect(isFirstPartyClient(over)).toBe(true);
  });

  it('clamping does not soften the denylist', () => {
    // A refused name must stay refused whatever its length.
    expect(setConfiguredFirstPartyClients(['mcp']).accepted).toEqual([]);
    expect(isFirstPartyClient('mcp')).toBe(false);
  });
});
