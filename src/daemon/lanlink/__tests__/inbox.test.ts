import { describe, it, expect } from 'vitest';
import { isInboxFile, type InboxFile } from '../../../shared/lanlink';

function validFile(): InboxFile {
  return {
    version: 1,
    nextSeq: 2,
    records: [
      { id: 'a', seq: 1, origin: 'remote', peerName: 'P', text: 'hi', receivedAt: 1 },
      { id: 'b', seq: 2, origin: 'remote', peerName: 'P', text: 'yo', receivedAt: 2 },
    ],
  };
}

describe('isInboxFile — #269 array-reject + row validation', () => {
  it('accepts a well-formed inbox file', () => {
    expect(isInboxFile(validFile())).toBe(true);
  });

  it('accepts an empty inbox', () => {
    expect(isInboxFile({ version: 1, nextSeq: 0, records: [] })).toBe(true);
  });

  it('rejects an ARRAY container (the #269 bug: typeof [] === "object")', () => {
    // A JSON array is valid JSON but NOT a healthy inbox file; passing it would
    // defeat .bak recovery. This is the exact codex P1 trap from #269.
    expect(isInboxFile([])).toBe(false);
    expect(
      isInboxFile([
        { id: 'a', seq: 1, origin: 'remote', peerName: 'P', text: 'x', receivedAt: 1 },
      ]),
    ).toBe(false);
  });

  it('rejects null / non-object / wrong version', () => {
    expect(isInboxFile(null)).toBe(false);
    expect(isInboxFile('nope')).toBe(false);
    expect(isInboxFile(42)).toBe(false);
    expect(isInboxFile({ version: 2, nextSeq: 0, records: [] })).toBe(false);
  });

  it('rejects a bad nextSeq (negative / non-integer / non-number)', () => {
    expect(isInboxFile({ version: 1, nextSeq: -1, records: [] })).toBe(false);
    expect(isInboxFile({ version: 1, nextSeq: 1.5, records: [] })).toBe(false);
    expect(isInboxFile({ version: 1, nextSeq: 'x', records: [] })).toBe(false);
  });

  it('rejects when records is not an array', () => {
    expect(isInboxFile({ version: 1, nextSeq: 0, records: {} })).toBe(false);
  });

  it('rejects a malformed record row', () => {
    const f = validFile();
    // wrong origin
    expect(isInboxFile({ ...f, records: [{ ...f.records[0], origin: 'local' }] })).toBe(false);
    // missing id
    expect(
      isInboxFile({
        ...f,
        nextSeq: 1,
        records: [{ seq: 1, origin: 'remote', peerName: 'P', text: 'x', receivedAt: 1 }],
      }),
    ).toBe(false);
    // non-string text
    expect(isInboxFile({ ...f, records: [{ ...f.records[0], text: 123 }] })).toBe(false);
    // empty id
    expect(isInboxFile({ ...f, nextSeq: 1, records: [{ ...f.records[0], id: '' }] })).toBe(false);
  });

  it('rejects a rewound / duplicate seq (replay defense)', () => {
    const f = validFile();
    expect(isInboxFile({ ...f, records: [f.records[0], { ...f.records[1], seq: 1 }] })).toBe(false);
  });

  it('rejects a seq greater than nextSeq', () => {
    const f = validFile();
    expect(
      isInboxFile({ ...f, nextSeq: 1, records: [f.records[0], { ...f.records[1], seq: 5 }] }),
    ).toBe(false);
  });
});
