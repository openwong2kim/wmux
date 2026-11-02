// Hermes's readiness answer as the bot profile reads it, and the one fix the
// profile offers for each reason.
import { describe, expect, it } from 'vitest';
import { HERMES_MCP_FIX_COMMAND } from '../../../../shared/hermesEngine';
import { hermesReadinessView, myHermesReadinessView, readHermesReadiness } from '../botsHermes';

describe('readHermesReadiness', () => {
  it('reads anything unreadable as unknown, and an unknown reason as unknown', () => {
    expect(readHermesReadiness(null)).toEqual({ ready: false, reason: 'unknown' });
    expect(readHermesReadiness('ready')).toEqual({ ready: false, reason: 'unknown' });
    expect(readHermesReadiness({ ready: 'yes' })).toEqual({ ready: false, reason: 'unknown' });
    expect(readHermesReadiness({ ready: false, reason: 'on-fire' })).toEqual({ ready: false, reason: 'unknown' });
  });

  it('keeps a known reason, and trims and caps the version and message', () => {
    expect(readHermesReadiness({ ready: true, version: ' 0.22.5 \n', message: 'ignored' })).toEqual({ ready: true, version: '0.22.5' });
    const r = readHermesReadiness({ ready: false, reason: 'unknown', version: `  ${'9'.repeat(80)}`, message: `  ${'x'.repeat(400)}  ` });
    expect(r.version).toHaveLength(40);
    expect(r.message).toHaveLength(300);
    expect(readHermesReadiness({ ready: false, reason: 'outdated', version: '0.21.0', message: '   ' })).toEqual({ ready: false, reason: 'outdated', version: '0.21.0' });
  });
});

describe('hermesReadinessView', () => {
  it('maps each reason to its line and its one fix', () => {
    const fixes = (['not-installed', 'outdated', 'unsupported', 'not-set-up', 'mcp-missing', 'config-mismatch', 'unknown'] as const)
      .map((reason) => [reason, hermesReadinessView({ ready: false, reason }).fix]);
    expect(Object.fromEntries(fixes)).toEqual({
      'not-installed': 'install', outdated: 'recheck', unsupported: 'recheck', 'not-set-up': 'setup',
      'mcp-missing': 'recheck', 'config-mismatch': 'recheck', unknown: 'recheck',
    });
    expect(hermesReadinessView({ ready: false, reason: 'mcp-missing' }).command).toBe(HERMES_MCP_FIX_COMMAND);
    expect(hermesReadinessView({ ready: false, reason: 'unsupported', version: '0.23.1' }).vars).toEqual({ version: '0.23.1', tested: '0.22.x' });
    expect(hermesReadinessView({ ready: false, reason: 'outdated', version: '0.21.0' }).vars).toEqual({ version: '0.21.0', min: '0.22.5' });
    // Only an unknown answer carries its raw detail.
    expect(hermesReadinessView({ ready: false, reason: 'unknown', message: 'spawn EACCES' }).detail).toBe('spawn EACCES');
    expect(hermesReadinessView({ ready: false, reason: 'config-mismatch', message: 'x' }).detail).toBeUndefined();
  });

  it('a ready answer has no fix and names the version when known', () => {
    expect(hermesReadinessView({ ready: true, version: '0.22.6' })).toEqual({ key: 'botsPage.hermes.ready', vars: { version: '0.22.6' } });
    expect(hermesReadinessView({ ready: true })).toEqual({ key: 'botsPage.hermes.readyNoVersion', vars: {} });
  });
});

describe('myHermesReadinessView', () => {
  it('names the config file of the profile that has the wmux MCP server', () => {
    expect(myHermesReadinessView({ ready: false, reason: 'wmux-mcp', notices: [] })).toEqual({ key: 'botsPage.myHermes.wmuxMcp', vars: { file: '~/.hermes/config.yaml' } });
    expect(myHermesReadinessView({ ready: false, reason: 'wmux-mcp', notices: [] }, 'coder').vars).toEqual({ file: '~/.hermes/profiles/coder/config.yaml' });
  });
});
