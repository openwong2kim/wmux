// The published notice codes (shared/phoneRoomNotices.ts) against the
// desktop's English templates and the contract's table: a code the desktop
// words but the table lacks, or a table row the code does not list, fails.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHONE_ROOM_NOTICE_CODES } from '../phoneRoomNotices';
import { en } from '../../renderer/i18n/locales/en';
import { noticeText } from '../../renderer/components/Room/roomFormat';

const EN = en as Readonly<Record<string, string>>;
const codes = Object.entries(PHONE_ROOM_NOTICE_CODES);

/** A known value for the args the desktop words (roomFormat.ts NOTICE_WORDS). */
const WORD_VALUES: Readonly<Record<string, string>> = {
  status: 'completed', by: 'owner', where: 'folder', limit: 'turns_hour', kind: 'research', hop: 'dispatch', verdict: 'pass', cause: 'fetch', scope: 'bot',
};

function docSection(): string {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'phone-client-contract.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = doc.indexOf('#### Room card notice codes');
  expect(start).toBeGreaterThan(0);
  return doc.slice(start, doc.indexOf('\n#### ', start + 10));
}

describe('PHONE_ROOM_NOTICE_CODES', () => {
  it('names only templates the desktop has', () => {
    for (const [code, spec] of codes) {
      for (const key of [...spec.titles, ...(spec.more ?? [])]) expect(EN[key], `${code}: ${key}`).toBeTypeOf('string');
    }
  });

  it('accounts for every room.notice template the desktop has', () => {
    const listed = new Set(codes.flatMap(([, spec]) => [...spec.titles, ...(spec.more ?? [])]));
    const unlisted = Object.keys(EN).filter((key) => key.startsWith('room.notice.') && !listed.has(key));
    expect(unlisted).toEqual([]);
  });

  it('lists only codes the desktop words', () => {
    for (const [code, spec] of codes) {
      const args = Object.fromEntries(Object.entries(spec.args).map(([name, type]) => [name, type === 'number' ? 1 : WORD_VALUES[name] ?? 'x']));
      const worded = noticeText({ actor: { kind: 'system' }, notice: { code, args } }, (key) => key);
      expect(worded, code).not.toBeNull();
    }
  });
});

describe('docs/phone-client-contract.md — Room card notice codes', () => {
  const rows = new Map<string, string[]>();
  for (const line of docSection().split('\n')) {
    const m = /^\| `([^`]+)` \|(.*)$/.exec(line);
    if (m) rows.set(m[1], m[2].split(' | ').map((c) => c.trim()));
  }

  it('has one row per published code, and no other', () => {
    expect([...rows.keys()].sort()).toEqual(codes.map(([code]) => code).sort());
  });

  it('gives each code its args and the desktop\'s English titles', () => {
    for (const [code, spec] of codes) {
      const [args, titles] = rows.get(code) ?? [];
      const want = Object.entries(spec.args).map(([name, type]) => `\`${name}\` ${type}`).join(', ') || '—';
      expect(args, code).toBe(want);
      expect(titles, code).toBe(spec.titles.map((key) => `\`${EN[key]}\``).join('<br>'));
    }
  });
});
