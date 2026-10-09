import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boundSessionLives, clearResumeCache, RESUME_CACHE_MS } from '../resumeAvailable';

let config: string;
let cwd: string;
const name = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');
const project = (dir: string) => path.join(config, 'projects', name(dir));
const transcript = (dir: string, id: string, body: string, at?: number) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, body);
  if (at !== undefined) fs.utimesSync(file, at / 1000, at / 1000);
};

beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-config-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-cwd-'));
  clearResumeCache();
});
afterEach(() => {
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('boundSessionLives', () => {
  const id = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
  it('needs a non-empty transcript inside the account root and an existing folder, cached for the resume window', async () => {
    const env = { CLAUDE_CONFIG_DIR: config };
    const file = path.join(project(cwd), `${id}.jsonl`);
    const binding = { agent: 'claude', sessionId: id, cwd, transcriptPath: file };
    expect(await boundSessionLives(binding, env, { now: 0 })).toBe(false);
    transcript(project(cwd), id, '{"type":"user"}\n');
    // The miss is cached; a fresh check (a launch) and a later window see the record.
    expect(await boundSessionLives(binding, env, { now: 1 })).toBe(false);
    expect(await boundSessionLives(binding, env, { now: 1, fresh: true })).toBe(true);
    expect(await boundSessionLives(binding, env, { now: RESUME_CACHE_MS + 1 })).toBe(true);
    // A record deleted inside the window: the cache still says yes, a fresh check does not.
    fs.rmSync(file);
    expect(await boundSessionLives(binding, env, { now: RESUME_CACHE_MS + 2 })).toBe(true);
    expect(await boundSessionLives(binding, env, { now: RESUME_CACHE_MS + 2, fresh: true })).toBe(false);
    transcript(project(cwd), id, '{"type":"user"}\n');
    // A missing path or a gone folder never counts.
    expect(await boundSessionLives({ ...binding, transcriptPath: undefined }, env, { fresh: true })).toBe(false);
    expect(await boundSessionLives({ ...binding, cwd: path.join(cwd, 'gone') }, env, { fresh: true })).toBe(false);
  });

  it('accepts only the projects root of the account the launch uses', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-other-'));
    try {
      const dir = path.join(other, 'projects', name(cwd));
      transcript(dir, id, '{"type":"user"}\n');
      const binding = { agent: 'claude', sessionId: id, cwd, transcriptPath: path.join(dir, `${id}.jsonl`) };
      expect(await boundSessionLives(binding, { CLAUDE_CONFIG_DIR: other }, { fresh: true })).toBe(true);
      // The configured account is `config`: a transcript in another root is not its conversation.
      expect(await boundSessionLives(binding, { CLAUDE_CONFIG_DIR: config }, { fresh: true })).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
