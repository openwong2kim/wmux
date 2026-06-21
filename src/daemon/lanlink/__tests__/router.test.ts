import { describe, it, expect } from 'vitest';
import { ACCEPTED_KINDS, admitKind, isAcceptedKind, RouterError } from '../router';

describe('router — inbound message-kind allow-list', () => {
  it('accepts exactly msg.text and state.update', () => {
    expect([...ACCEPTED_KINDS]).toEqual(['msg.text', 'state.update']);
    expect(admitKind('msg.text')).toBe('msg.text');
    expect(admitKind('state.update')).toBe('state.update');
  });

  it('rejects a2a.task.send, control methods, and any execute/spawn kind', () => {
    for (const k of [
      'a2a.task.send',
      'a2a.task.update',
      'execute',
      'spawn',
      'daemon.inbox.poll',
      'lanlink.status',
      'lanlink.configure',
      'lanlink.pair.begin',
      'lanlink.peers.remove',
    ]) {
      expect(() => admitKind(k)).toThrow(RouterError);
    }
  });

  it('rejects prototype-chain keys (C20 — never an object-map index)', () => {
    for (const k of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']) {
      expect(isAcceptedKind(k)).toBe(false);
      expect(() => admitKind(k)).toThrow(RouterError);
    }
  });

  it('rejects non-strings', () => {
    for (const k of [null, undefined, 1, {}, [], true]) {
      expect(isAcceptedKind(k)).toBe(false);
      expect(() => admitKind(k)).toThrow(RouterError);
    }
  });

  it('drift-lock: no accepted kind carries an execute/spawn/send/task substring', () => {
    for (const k of ACCEPTED_KINDS) {
      expect(/execute|spawn|send|task|exec|run/i.test(k)).toBe(false);
    }
  });
});
