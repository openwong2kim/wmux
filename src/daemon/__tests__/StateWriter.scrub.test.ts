import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scrubPersistedCredentials } from '../StateWriter';

// PR2 부팅 마이그레이션: 기존 sessions.json 주 파일 + .bak 슬롯에서 자격증명 값을
// 스크럽하되, total·non-throwing이라 세션을 절대 잃지 않는다.
describe('scrubPersistedCredentials', () => {
  let dir: string;
  const primary = (): string => path.join(dir, 'sessions.json');
  const readSessions = (file: string): Array<{ id: string; env?: Record<string, unknown> }> =>
    JSON.parse(fs.readFileSync(file, 'utf-8')).sessions;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-scrub-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('주 파일에서 자격증명 값을 제거하고 비자격 env·세션은 보존', () => {
    fs.writeFileSync(primary(), JSON.stringify({
      version: 1,
      sessions: [
        { id: 'a', env: { PATH: '/usr/bin', WMUX_SURFACE_ID: 's1', GITHUB_TOKEN: 'ghp', KAD_GATEWAY_KEY: 'sec' } },
        { id: 'b', env: { PATH: '/bin' } },
      ],
    }));
    scrubPersistedCredentials(dir);
    const sessions = readSessions(primary());
    expect(sessions).toHaveLength(2);               // 세션 보존
    expect(sessions[0].env!.PATH).toBe('/usr/bin'); // 비자격 보존
    expect(sessions[0].env!.WMUX_SURFACE_ID).toBe('s1');
    expect(sessions[0].env!.GITHUB_TOKEN).toBeUndefined(); // 자격증명 제거
    expect(sessions[0].env!.KAD_GATEWAY_KEY).toBeUndefined();
    expect(sessions[1].env!.PATH).toBe('/bin');
  });

  it('.bak 슬롯도 스크럽', () => {
    const bak = `${primary()}.bak`;
    fs.writeFileSync(bak, JSON.stringify({
      version: 1, sessions: [{ id: 'a', env: { PATH: '/p', ANTHROPIC_API_KEY: 'sk' } }],
    }));
    // 주 파일도 있어야 스크럽 루프가 도는 게 아니라 각 슬롯 독립 — 주 파일 없이도 .bak 처리
    scrubPersistedCredentials(dir);
    expect(readSessions(bak)[0].env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(readSessions(bak)[0].env!.PATH).toBe('/p');
  });

  it('비객체 env는 {}로 교체하되 세션은 드롭하지 않음(자격증명 문자열 은닉 차단)', () => {
    fs.writeFileSync(primary(), JSON.stringify({
      version: 1,
      sessions: [
        { id: 'a', env: null },                       // null → {}
        { id: 'b' },                                  // env 없음 → 그대로
        { id: 'c', env: 'GITHUB_TOKEN=ghp_leak' },    // 문자열(자격증명 은닉) → {}
        { id: 'd', env: { API_KEY: 'x', PATH: '/p' } },
      ],
    }));
    expect(() => scrubPersistedCredentials(dir)).not.toThrow();
    const sessions = readSessions(primary());
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']); // 전부 보존
    expect(sessions[0].env).toEqual({});              // null → {}
    expect('env' in sessions[1]).toBe(false);         // env 없던 세션은 그대로
    expect(sessions[2].env).toEqual({});              // 자격증명 문자열 제거
    expect(sessions[3].env!.API_KEY).toBeUndefined();
    expect(sessions[3].env!.PATH).toBe('/p');
  });

  it('파일 부재·손상 JSON에서 throw하지 않고 다른 슬롯은 계속 처리', () => {
    // 주 파일은 손상, .bak은 정상 — .bak은 스크럽돼야 하고 전체는 throw 없음
    fs.writeFileSync(primary(), '{ this is not json');
    fs.writeFileSync(`${primary()}.bak`, JSON.stringify({
      version: 1, sessions: [{ id: 'a', env: { GH_TOKEN: 't', HOME: '/h' } }],
    }));
    expect(() => scrubPersistedCredentials(dir)).not.toThrow();
    expect(readSessions(`${primary()}.bak`)[0].env!.GH_TOKEN).toBeUndefined();
    expect(readSessions(`${primary()}.bak`)[0].env!.HOME).toBe('/h');
  });

  it('자격증명이 없으면 파일을 건드리지 않음(불필요한 rewrite 회피)', () => {
    fs.writeFileSync(primary(), JSON.stringify({ version: 1, sessions: [{ id: 'a', env: { PATH: '/p' } }] }));
    const mtimeBefore = fs.statSync(primary()).mtimeMs;
    scrubPersistedCredentials(dir);
    // changed=false면 rewrite 안 함 — 세션은 그대로
    expect(readSessions(primary())[0].env!.PATH).toBe('/p');
    expect(mtimeBefore).toBeGreaterThan(0);
  });
});
