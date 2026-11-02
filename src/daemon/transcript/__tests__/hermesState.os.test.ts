import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { findHermesSession, hermesHome, hermesPromptState, HERMES_PAGE_ROWS, readHermesHistory, withHermesDb } from '../hermesState';
import { addMessage, addSession, hermesFixture, HERMES_SCHEMAS } from './hermesFixture';

const open: DatabaseSync[] = [];
afterEach(() => { for (const db of open.splice(0)) { try { db.close(); } catch { /* closed */ } } });
const fixture = (schema: keyof typeof HERMES_SCHEMAS) => {
  const made = hermesFixture(schema);
  open.push(made.writer);
  return made;
};
const files = (dir: string) => fs.readdirSync(dir).sort();

// The idle prompt as Hermes v0.19.0 drew it in a wmux pane (captured live).
const RULE = '─'.repeat(80);
const screen = (prompt: string[]) => [
  'Welcome to Hermes Agent! Type your message or /help for commands.',
  '',
  ' ⚕ glm-5.2 │ ctx -- │ [░░░░░░░░░░] -- │ 2s │ ⏲ 0s ',
  RULE, ...prompt, RULE, '', '',
];

describe('hermesHome', () => {
  it('follows HERMES_HOME, else the platform default', () => {
    expect(hermesHome({ HERMES_HOME: '/srv/hermes' }, 'darwin', '/Users/u')).toBe('/srv/hermes');
    expect(hermesHome({}, 'darwin', '/Users/u')).toBe('/Users/u/.hermes');
    expect(hermesHome({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u')).toBe('C:\\Users\\u\\AppData\\Local\\hermes');
  });
});

for (const schema of Object.keys(HERMES_SCHEMAS) as Array<keyof typeof HERMES_SCHEMAS>) {
  describe(`Hermes ${schema} state.db`, () => {
    it('reads the live database without creating anything beside it', () => {
      const { home, db, writer } = fixture(schema);
      addSession(writer, { id: '20261029_053840_ec122e', cwd: '/w/proj', startedAt: 1_000_000 });
      // Hermes is running: it holds the database, so both sidecars exist.
      expect(files(home)).toEqual(['state.db', 'state.db-shm', 'state.db-wal']);
      expect(withHermesDb(db, (conn) => findHermesSession(conn, ['/w/proj'], 0)?.id)).toBe('20261029_053840_ec122e');
      expect(files(home)).toEqual(['state.db', 'state.db-shm', 'state.db-wal']);
    });

    it('reads a closed database as is, and refuses a half-open one', () => {
      const { home, db, writer } = fixture(schema);
      addSession(writer, { id: 's1', cwd: '/w/proj', startedAt: 1_000_000 });
      writer.close();
      // The last connection checkpointed and removed the sidecars.
      expect(files(home)).toEqual(['state.db']);
      expect(withHermesDb(db, (conn) => findHermesSession(conn, ['/w/proj'], 0)?.id)).toBe('s1');
      expect(files(home)).toEqual(['state.db']);
      // A WAL with no index (a crash leftover) would need recovery, which writes.
      fs.writeFileSync(`${db}-wal`, '');
      expect(withHermesDb(db, () => 'read')).toBeNull();
      expect(files(home)).toEqual(['state.db', 'state.db-wal']);
      expect(withHermesDb(path.join(home, 'missing.db'), () => 'read')).toBeNull();
    });

    it('binds the newest CLI session started in the pane folder since its launch', () => {
      const { db, writer } = fixture(schema);
      addSession(writer, { id: 'before-launch', cwd: '/w/proj', startedAt: 1_000 });
      addSession(writer, { id: 'tui', source: 'tui', cwd: null, startedAt: 6_000 });
      addSession(writer, { id: 'elsewhere', cwd: '/w/other', startedAt: 7_000 });
      addSession(writer, { id: 'first', cwd: '/w/proj', startedAt: 5_000 });
      const bound = () => withHermesDb(db, (conn) => findHermesSession(conn, ['/w/proj', '/private/w/proj'], 4_000));
      expect(bound()).toEqual({ id: 'first', startedAt: 5_000 });
      // `/new` starts a newer session in the same process.
      addSession(writer, { id: 'after-new', cwd: '/private/w/proj', startedAt: 8_000 });
      expect(bound()?.id).toBe('after-new');
    });

    it('turns the active rows into the conversation, and a rewind into a new history', () => {
      const { db, writer } = fixture(schema);
      addSession(writer, { id: 's1', cwd: '/w/proj', startedAt: 1_000 });
      addMessage(writer, { session: 's1', role: 'system', content: 'You are Hermes.' });
      addMessage(writer, { session: 's1', role: 'user', content: 'list the files', at: 2_000 });
      addMessage(writer, { session: 's1', role: 'assistant', content: 'Looking.', at: 3_000,
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{"command": "ls"}' } }] });
      addMessage(writer, { session: 's1', role: 'tool', content: 'a.txt\nb.txt', toolCallId: 'call_1', toolName: 'terminal', at: 4_000 });
      const read = () => withHermesDb(db, (conn) => readHermesHistory(conn, 's1'))!;
      const open = read();
      expect(open.turnOpen).toBe(true);
      addMessage(writer, { session: 's1', role: 'assistant', content: '\u0000json:[{"type":"text","text":"Two files."}]', at: 5_000 });
      addMessage(writer, { session: 's1', role: 'user', content: 'Continuing.', displayKind: 'auto_continue', at: 6_000 });
      addMessage(writer, { session: 's1', role: 'assistant', content: 'Done.', at: 7_000 });
      const history = read();
      expect(history.turnOpen).toBe(false);
      expect(history.truncatedHead).toBe(false);
      expect(history.rawEpoch).toBe(open.rawEpoch);
      expect(history.events.map((e) => [e.kind, 'text' in e ? e.text : 'label' in e ? e.label : e.toolUseId])).toEqual([
        ['user_text', 'list the files'],
        ['assistant_text', 'Looking.'],
        ['tool_use', 'call_1'],
        ['tool_result', 'call_1'],
        ['assistant_text', 'Two files.'],
        ['meta', 'auto_continue'],
        ['assistant_text', 'Done.'],
      ]);
      const call = history.events[2];
      expect(call).toMatchObject({ kind: 'tool_use', name: 'terminal', argSummary: '{"command": "ls"}', ts: 3_000 });
      expect(history.events[3]).toMatchObject({ kind: 'tool_result', ok: true, output: { inline: 'a.txt\nb.txt' } });
      // Undo takes the last exchange back (active = 0): the rows shown are no longer true.
      writer.exec("UPDATE messages SET active = 0 WHERE session_id = 's1' AND timestamp >= 6");
      const rewound = read();
      expect(rewound.rawEpoch).not.toBe(history.rawEpoch);
      expect(rewound.events.at(-1)).toMatchObject({ kind: 'assistant_text', text: 'Two files.' });
    });

    it('keeps the newest rows when the session is longer than a page', () => {
      const { db, writer } = fixture(schema);
      addSession(writer, { id: 's1', cwd: '/w/proj', startedAt: 1_000 });
      for (let i = 0; i <= HERMES_PAGE_ROWS; i++) addMessage(writer, { session: 's1', role: i % 2 ? 'assistant' : 'user', content: `row ${i}` });
      const history = withHermesDb(db, (conn) => readHermesHistory(conn, 's1'))!;
      expect(history.truncatedHead).toBe(true);
      expect(history.events).toHaveLength(HERMES_PAGE_ROWS);
      expect(history.events.at(-1)).toMatchObject({ text: `row ${HERMES_PAGE_ROWS}` });
    });
  });
}

describe('hermesPromptState', () => {
  it('reads the classic REPL prompt states', () => {
    expect(hermesPromptState(screen(['❯ ']))).toBe('idle-empty');
    expect(hermesPromptState(screen(['❯ wmux paste probe line one', 'line two']))).toBe('idle-typed');
    expect(hermesPromptState(screen(['⚕ ❯ ']))).toBe('running');
    // As captured mid-turn: the running placeholder follows the prompt.
    expect(hermesPromptState(screen(['⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel']))).toBe('running');
    expect(hermesPromptState(screen(['⠙ ❯ ']))).toBe('running');
    expect(hermesPromptState(screen(['⚠ ❯ ']))).toBe('dialog');
    expect(hermesPromptState(screen(['🔐 ❯ ']))).toBe('dialog');
    // Another skin's symbol, a profile prefix, a shell prompt, nothing to read.
    expect(hermesPromptState(screen(['⚔ ']))).toBe('unknown');
    expect(hermesPromptState(screen(['coder ❯ ']))).toBe('unknown');
    expect(hermesPromptState(['Goodbye! ⚕', 'u@host proj %'])).toBe('unknown');
    expect(hermesPromptState(null)).toBe('unknown');
  });
});
