import { describe, it, expect } from 'vitest';
import { MAX_PROGRAM_STATUS_RECORDS, ProgramStatusStore, parseProgramStatus } from '../programStatus';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('parseProgramStatus (OSC 7501)', () => {
  it('reads a report, ignoring unknown keys and skipping malformed pairs', () => {
    expect(parseProgramStatus('state=blocked:kind=permission:app=codex:future=1:noequals:BAD=x:progress=40')).toEqual({
      state: 'blocked', kind: 'permission', app: 'codex', progress: 40,
    });
    expect(parseProgramStatus(' state = working : progress=7 ')).toEqual({ state: 'working', progress: 7 });
    // The last of a repeated key wins.
    expect(parseProgramStatus('state=idle:state=done')).toEqual({ state: 'done' });
  });

  it('drops a report with no state or one it does not know', () => {
    expect(parseProgramStatus('app=codex')).toBeNull();
    expect(parseProgramStatus('state=sleeping:app=codex')).toBeNull();
    expect(parseProgramStatus('state=WORKING')).toBeNull();
  });

  it('ignores the feature query (answered in a later release)', () => {
    expect(parseProgramStatus('?')).toBeNull();
  });

  it('treats an invalid kind, progress or app as absent, and keeps kind/progress to their states', () => {
    expect(parseProgramStatus('state=blocked:kind=coffee:progress=101:app=a!b')).toEqual({ state: 'blocked' });
    expect(parseProgramStatus('state=idle:kind=auth:progress=50')).toEqual({ state: 'idle' });
  });

  it('decodes title and msg, padding optional', () => {
    expect(parseProgramStatus(`state=working:title=${b64('Build')}:msg=${b64('Pushing image').replace(/=+$/, '')}`))
      .toEqual({ state: 'working', title: 'Build', msg: 'Pushing image' });
  });

  it('drops a report whose text is not strict base64 of UTF-8', () => {
    // A byte outside the value set is a malformed pair: skipped, not a drop.
    expect(parseProgramStatus('state=working:msg=@@@')).toEqual({ state: 'working' });
    expect(parseProgramStatus('state=working:msg=QQ=')).toBeNull(); // bad padding length
    expect(parseProgramStatus('state=working:msg=QR==')).toBeNull(); // non-zero trailing bits
    expect(parseProgramStatus('state=working:msg=A')).toBeNull(); // impossible length
    expect(parseProgramStatus(`state=working:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`)).toBeNull(); // not UTF-8
  });

  it('drops a report whose decoded text holds a control character, and strips invisible formatting', () => {
    expect(parseProgramStatus(`state=done:msg=${b64('line\nbreak')}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${b64('tab\there')}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${b64('c1\u009bhere')}`)).toBeNull();
    expect(parseProgramStatus(`state=done:title=${b64('a\u202eb\u200bc\u2066d')}`)).toEqual({ state: 'done', title: 'abcd' });
  });

  it('enforces every limit by dropping the whole report', () => {
    expect(parseProgramStatus(`state=done:title=${b64('x'.repeat(192))}`)).not.toBeNull();
    expect(parseProgramStatus(`state=done:title=${b64('x'.repeat(193))}`)).toBeNull();
    expect(parseProgramStatus(`state=done:msg=${b64('x'.repeat(2048))}`)).not.toBeNull();
    expect(parseProgramStatus(`state=done:msg=${b64('x'.repeat(2049))}`)).toBeNull();
    expect(parseProgramStatus(`state=done:${'k'.repeat(17)}=1`)).toBeNull();
    expect(parseProgramStatus(`state=done:app=${'a'.repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=done:pad=${'x'.repeat(4096)}`)).toBeNull();
  });

  it('validates ids and drops a report whose id does not match the grammar', () => {
    expect(parseProgramStatus('state=working:id=build/test')).toEqual({ state: 'working', id: 'build/test' });
    expect(parseProgramStatus('state=working:id=a//b')).toBeNull();
    expect(parseProgramStatus(`state=working:id=${'s'.repeat(33)}`)).toBeNull();
    expect(parseProgramStatus(`state=working:id=${Array(9).fill('s').join('/')}`)).toBeNull();
    expect(parseProgramStatus(`state=working:id=${Array(5).fill('s'.repeat(30)).join('/')}`)).toBeNull(); // > 128 bytes
  });
});

describe('ProgramStatusStore', () => {
  it('replaces a record whole and clears an id with its descendants', () => {
    const store = new ProgramStatusStore();
    store.apply({ state: 'working', app: 'deploy' }, 1);
    store.apply({ state: 'working', id: 'eu' }, 2);
    store.apply({ state: 'blocked', id: 'eu/west' }, 3);
    store.apply({ state: 'working', id: 'europe' }, 4);
    store.apply({ state: 'idle' }, 5);
    expect(store.root()).toEqual({ state: 'idle', updatedAt: 5, stateSince: 5 });
    // A repeat of the same state moves `updatedAt` only.
    store.apply({ state: 'idle' }, 5.5);
    expect(store.root()).toEqual({ state: 'idle', updatedAt: 5.5, stateSince: 5 });
    store.apply({ state: 'clear', id: 'eu' }, 6);
    expect(store.size).toBe(2); // root and `europe`, which is not beneath `eu`
    store.apply({ state: 'clear' }, 7);
    expect(store.size).toBe(0);
  });

  it('drops working and blocked records, keeping done and error', () => {
    const store = new ProgramStatusStore();
    store.apply({ state: 'working' }, 1);
    store.apply({ state: 'blocked', id: 'a' }, 1);
    store.apply({ state: 'done', id: 'b' }, 1);
    store.apply({ state: 'error', id: 'c' }, 1);
    store.dropTransient();
    expect(store.root()).toBeUndefined();
    expect(store.size).toBe(2);
  });

  it('evicts the least recently updated record past the cap', () => {
    const store = new ProgramStatusStore();
    store.apply({ state: 'working' }, 0);
    for (let i = 0; i < MAX_PROGRAM_STATUS_RECORDS - 1; i++) store.apply({ state: 'working', id: `r${i}` }, i);
    store.apply({ state: 'idle' }, 999); // the root is now the most recent
    store.apply({ state: 'working', id: 'extra' }, 1000);
    expect(store.size).toBe(MAX_PROGRAM_STATUS_RECORDS);
    expect(store.root()?.state).toBe('idle');
  });
});
