import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginIdentityRecord } from '../../../shared/rpc';
import { ALL_RPC_METHODS } from '../../../shared/rpc';
import { LIVE_WRITE_RPC_METHODS } from '../../../shared/liveWriteScope';
import { FIRST_PARTY_METHODS } from '../firstParty';
import { CAPABILITY_EFFECT, CAPABILITY_RISK_CLASS, METHOD_CAPABILITY } from '../methodCapabilityMap';
import { listKnownCapabilities } from '../permissionGrammar';
import { check } from '../PermissionEnforcer';

/**
 * browser.upload.cdp is opted in by hand on every list, because several of
 * the gates allow what they do not name. Each list is asserted here, plus the
 * two facts that only the source shows: it is registered leased, and a
 * protected pane is refused it outright.
 */

const METHOD = 'browser.upload.cdp';
const BROWSER_RPC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'pipe', 'handlers', 'browser.rpc.ts'),
  'utf8',
);

describe('browser.upload.cdp is on every list', () => {
  it('is an RPC method the first-party client may call', () => {
    expect(ALL_RPC_METHODS).toContain(METHOD);
    expect(FIRST_PARTY_METHODS.has(METHOD)).toBe(true);
  });

  it('is gated as a live write', () => {
    expect(LIVE_WRITE_RPC_METHODS.has(METHOD)).toBe(true);
  });

  it('needs its own capability, a known, browser-class write', () => {
    expect(METHOD_CAPABILITY[METHOD]).toMatchObject({ capability: 'browser.upload', riskClass: 'browser' });
    expect(listKnownCapabilities()).toContain('browser.upload');
    expect(CAPABILITY_RISK_CLASS['browser.upload']).toBe('browser');
    expect(CAPABILITY_EFFECT['browser.upload']).toBe('write');
  });

  it('is registered leased, never on the bare router', () => {
    expect(BROWSER_RPC).toContain(`registerLeased('${METHOD}'`);
    expect(BROWSER_RPC).not.toContain(`router.register('${METHOD}'`);
  });

  it('is refused outright on a protected pane', () => {
    const denied = BROWSER_RPC.slice(
      BROWSER_RPC.indexOf('const PROTECTED_DENIED_METHODS'),
      BROWSER_RPC.indexOf(']);', BROWSER_RPC.indexOf('const PROTECTED_DENIED_METHODS')),
    );
    expect(denied).toContain(`['${METHOD}',`);
  });
});

describe('browser.upload.cdp for a plugin', () => {
  const plugin = (status: PluginIdentityRecord['status'], declaredCapabilities: string[]): PluginIdentityRecord => ({
    name: 'p1',
    status,
    firstSeen: 1,
    lastSeen: 2,
    declaredCapabilities,
  });
  const ask = (trust: PluginIdentityRecord) =>
    check({ method: METHOD, params: {}, ctx: { origin: 'local', clientName: 'p1' }, trust });

  it('is refused to a trusted plugin holding every other browser capability', () => {
    const out = ask(plugin('trusted', [
      'browser.navigate', 'browser.click', 'browser.type', 'browser.screenshot',
      'browser.evaluate', 'browser.read', 'browser.cookies', 'browser.emulate',
    ]));
    if (out.kind !== 'reject' || out.rejection.reason !== 'capability-not-declared') {
      throw new Error(`expected capability-not-declared, got ${JSON.stringify(out)}`);
    }
    expect(out.rejection.capability).toBe('browser.upload');
  });

  it('is refused to a plugin that is not trusted, whatever it declared', () => {
    expect(ask(plugin('unconfirmed', ['browser.upload'])).kind).toBe('reject');
    expect(ask(plugin('denied', ['browser.upload'])).kind).toBe('reject');
  });

  it('is allowed to a trusted plugin that declared browser.upload', () => {
    expect(ask(plugin('trusted', ['browser.upload']))).toEqual({ kind: 'allow' });
  });
});
