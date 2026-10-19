import { describe, expect, it } from 'vitest';
import { BLOCKED_HOST_LOG_LIMIT, BlockedHostLog } from '../BlockedHostLog';

// The per-profile list of hosts the protected proxy refused recently (#2063).

function clockLog(limit?: number) {
  let t = 1_000;
  const log = new BlockedHostLog(limit, () => t);
  return { log, tick: (ms = 1) => { t += ms; } };
}

describe('BlockedHostLog', () => {
  it('records a refusal with its count and when it was last seen, newest first', () => {
    const { log, tick } = clockLog();
    log.record('cdn.example.com', 443);
    tick(10);
    log.record('api.example.com', 8443);
    tick(10);
    log.record('cdn.example.com', 443);
    expect(log.list()).toEqual([
      { host: 'cdn.example.com', port: 443, lastSeen: 1_020, count: 2 },
      { host: 'api.example.com', port: 8443, lastSeen: 1_010, count: 1 },
    ]);
  });

  it('counts every spelling of one host as one entry, and each port apart', () => {
    const { log } = clockLog();
    log.record('CDN.Example.com.', 443);
    log.record('cdn.example.com', 443);
    log.record('cdn.example.com', 80);
    expect(log.list().map((e) => `${e.host}:${e.port}:${e.count}`)).toEqual(['cdn.example.com:80:1', 'cdn.example.com:443:2']);
  });

  it('ignores what is not a valid host or port', () => {
    const { log } = clockLog();
    log.record('', 443);
    log.record('bad host', 443);
    log.record('a.test', 0);
    log.record('a.test', 70_000);
    expect(log.list()).toEqual([]);
  });

  it(`keeps at most ${BLOCKED_HOST_LOG_LIMIT} entries, dropping the least recently refused`, () => {
    const { log, tick } = clockLog();
    for (let i = 0; i < BLOCKED_HOST_LOG_LIMIT; i++) {
      log.record(`h${i}.test`, 443);
      tick();
    }
    // h0 is refused again, so h1 is now the least recently seen.
    log.record('h0.test', 443);
    tick();
    log.record('new.test', 443);
    const hosts = log.list().map((e) => e.host);
    expect(hosts).toHaveLength(BLOCKED_HOST_LOG_LIMIT);
    expect(hosts[0]).toBe('new.test');
    expect(hosts).toContain('h0.test');
    expect(hosts).not.toContain('h1.test');
  });

  it('clears, and hands out copies', () => {
    const { log } = clockLog();
    log.record('a.test', 443);
    log.list()[0].count = 99;
    expect(log.list()[0].count).toBe(1);
    log.clear();
    expect(log.list()).toEqual([]);
  });
});
