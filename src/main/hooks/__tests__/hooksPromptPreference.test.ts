// hooksPromptPreference — the durable half of the install prompt's refusal.
//
// The property under test is not "a boolean round-trips": it is that every
// uncertain read resolves to ASK. A corrupt file that muted the prompt would be
// invisible — the user would simply never be offered hooks again and would have
// no way to know why.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadHooksPromptPreference,
  setHooksPromptSuppressed,
  getHooksPromptPreferencePath,
} from '../hooksPromptPreference';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hooks-prompt-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (text: string) => fs.writeFileSync(getHooksPromptPreferencePath(dir), text, 'utf-8');

describe('loadHooksPromptPreference', () => {
  it('asks when the file does not exist', () => {
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: false });
  });

  it('asks when the file is unparsable', () => {
    write('{ not json');
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: false });
  });

  it('asks when the file is JSON but not an object', () => {
    write('[true]');
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: false });
    write('"true"');
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: false });
    write('null');
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: false });
  });

  it('only a literal true suppresses — no truthy coercion', () => {
    for (const raw of ['{"suppressed":"true"}', '{"suppressed":1}', '{"suppressed":{}}']) {
      write(raw);
      expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: false });
    }
  });

  it('reads a stored refusal', () => {
    write('{"suppressed":true}');
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: true });
  });

  it('ignores unknown keys rather than resetting the file', () => {
    write('{"suppressed":true,"someFutureField":42}');
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: true });
  });
});

describe('setHooksPromptSuppressed', () => {
  it('round-trips and survives a fresh read (the restart case)', async () => {
    await expect(setHooksPromptSuppressed(true, dir)).resolves.toEqual({ suppressed: true });
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: true });
  });

  it('is reversible — the Settings "Ask again" path', async () => {
    await setHooksPromptSuppressed(true, dir);
    await expect(setHooksPromptSuppressed(false, dir)).resolves.toEqual({ suppressed: false });
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: false });
  });

  it('repairs a corrupt file instead of failing on it', async () => {
    write('{ not json');
    await setHooksPromptSuppressed(true, dir);
    expect(loadHooksPromptPreference(dir)).toEqual({ suppressed: true });
  });
});
