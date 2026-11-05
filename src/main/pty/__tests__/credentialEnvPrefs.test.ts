import { afterEach, describe, expect, it } from 'vitest';
import {
  credentialEnvFilePrefs,
  setCredentialEnvPrefsStoreForTests,
  setWithholdCredentialsFromAgents,
  withholdCredentialsFromAgents,
} from '../credentialEnvPrefs';

function memFs(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set('/p.json', initial);
  return {
    files,
    readFileSync: ((f: string) => {
      const v = files.get(f);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    }) as never,
    writeFileSync: ((f: string, d: string) => { files.set(f, d); }) as never,
    mkdirSync: (() => undefined) as never,
  };
}

afterEach(() => setCredentialEnvPrefsStoreForTests(null));

describe('credentialEnvFilePrefs', () => {
  it('defaults to withholding when the file is missing or broken', () => {
    expect(credentialEnvFilePrefs('/p.json', memFs()).load().withholdFromAgents).toBe(true);
    expect(credentialEnvFilePrefs('/p.json', memFs('{not json')).load().withholdFromAgents).toBe(true);
    expect(credentialEnvFilePrefs('/p.json', memFs('{}')).load().withholdFromAgents).toBe(true);
  });

  it('reads an explicit off', () => {
    expect(credentialEnvFilePrefs('/p.json', memFs('{"withholdFromAgents":false}')).load().withholdFromAgents).toBe(false);
  });

  it('saves the choice and stores no env values', () => {
    const fs = memFs();
    const store = credentialEnvFilePrefs('/p.json', fs);
    store.save({ withholdFromAgents: false });
    expect(store.load().withholdFromAgents).toBe(false);
    expect(JSON.parse(fs.files.get('/p.json') ?? 'null')).toEqual({ withholdFromAgents: false });
  });
});

describe('withholdCredentialsFromAgents', () => {
  it('follows the store in both states', () => {
    setCredentialEnvPrefsStoreForTests(credentialEnvFilePrefs('/p.json', memFs()));
    expect(withholdCredentialsFromAgents()).toBe(true);
    expect(setWithholdCredentialsFromAgents(false).withholdFromAgents).toBe(false);
    expect(withholdCredentialsFromAgents()).toBe(false);
    setWithholdCredentialsFromAgents(true);
    expect(withholdCredentialsFromAgents()).toBe(true);
  });

  it('fails closed when the store throws', () => {
    setCredentialEnvPrefsStoreForTests({ load: () => { throw new Error('boom'); }, save: () => undefined });
    expect(withholdCredentialsFromAgents()).toBe(true);
  });
});
