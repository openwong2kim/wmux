import { describe, expect, it } from 'vitest';
import { Calls, Lines, isReplayAnswer, mayHaveRun, peek } from '../shimHandover';

const b = (s: string) => Buffer.from(s);

function allLines(chunks: string[]): { out: string[]; rest: string } {
  const lines = new Lines();
  const out: string[] = [];
  for (const c of chunks) lines.push(b(c), (l) => out.push(l.toString()));
  return { out, rest: lines.takeRest().toString() };
}

describe('shimHandover (the rules of core/wmux-native/src/mcp_shim/handover.rs)', () => {
  it('lines split across chunks keep their newlines', () => {
    const { out, rest } = allLines(['{"a":1}\n{"b"', ':2}\n\n{"c":', '3}']);
    expect(out).toEqual(['{"a":1}\n', '{"b":2}\n', '\n']);
    expect(rest).toBe('{"c":3}');
  });

  it('reads the top level only, ids compared as values', () => {
    const line = b('{"jsonrpc":"2.0","result":{"id":9,"method":"x"},"id":4}');
    expect(peek(line)).toEqual([{ id: '4', method: undefined, error: false }]);
    expect(peek(b('{"id":"a\\u0062","method":"tools/call"}'))[0]).toMatchObject({ id: '"ab"', method: 'tools/call' });
    expect(peek(b('{"id":1,"error":{"code":1}}'))[0].error).toBe(true);
    expect(peek(b('{"id":1.0}'))[0].id).toBe(peek(b('{"id":1}'))[0].id);
    expect(peek(b('{"id":null}'))[0].id).toBeUndefined();
    expect(peek(b('{"id":1,"id":2}'))[0].id).toBe('2');
  });

  it('a batch is one message per object; junk is none', () => {
    expect(peek(b('[{"id":1,"method":"a"},7,{"id":2,"method":"b"}]')).map((p) => p.id)).toEqual(['1', '2']);
    for (const junk of ['not json', '{"id":1', '"str"', '']) expect(peek(b(junk))).toEqual([]);
  });

  const INIT = '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n';
  const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}\n';

  it('a handover answers what is in flight and replays the initialize', () => {
    const c = new Calls();
    c.sent(b(INIT));
    expect(c.answered(b('{"jsonrpc":"2.0","id":0,"result":{}}\n'))).toBe(true);
    c.sent(b(INITIALIZED));
    c.sent(b('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'));
    c.sent(b('{"jsonrpc":"2.0","id":2,"method":"tools/call"}\n'));
    c.sent(b('{"jsonrpc":"2.0","method":"notifications/cancelled"}\n'));
    c.sent(b('{"jsonrpc":"2.0","id":9,"result":{}}\n')); // the host answering the server
    expect(c.answered(b('{"jsonrpc":"2.0","id":1,"result":{}}\n'))).toBe(true);
    expect(c.answered(b('{"jsonrpc":"2.0","id":5,"method":"roots/list"}\n'))).toBe(true);
    const { ids, replay } = c.handOver();
    expect(ids).toEqual(['2']);
    expect(replay.map(String)).toEqual([
      '{"jsonrpc":"2.0","id":"wmux-shim-replay","method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n',
      INITIALIZED,
    ]);
    // After the handover the broker's lines are dropped, the host's untracked.
    expect(c.answered(b('{"jsonrpc":"2.0","id":2,"result":{}}\n'))).toBe(false);
    c.sent(b('{"jsonrpc":"2.0","id":3,"method":"ping"}\n'));
    expect(c.handOver()).toEqual({ ids: [], replay: [] });
  });

  it('an unanswered or failed initialize is not replayed', () => {
    let c = new Calls();
    c.sent(b(INIT));
    expect(c.handOver()).toEqual({ ids: ['0'], replay: [] });
    c = new Calls();
    c.sent(b(INIT));
    c.answered(b('{"jsonrpc":"2.0","id":0,"error":{"code":-1,"message":"no"}}\n'));
    c.sent(b(INITIALIZED));
    expect(c.handOver()).toEqual({ ids: [], replay: [] });
  });

  it('a repeated id is owed once per request', () => {
    const c = new Calls();
    c.sent(b('{"id":1,"method":"a"}\n'));
    c.sent(b('{"id":1,"method":"b"}\n'));
    c.answered(b('{"id":1,"result":0}\n'));
    expect(c.handOver().ids).toEqual(['1']);
  });

  it('the error frame is the native one, byte for byte, and the replay answer is told apart', () => {
    expect(mayHaveRun('"a"')).toBe(
      '{"jsonrpc":"2.0","id":"a","error":{"code":-32000,"message":"The wmux MCP broker stopped while this call was in flight. '
      + 'It may have run; it was not retried. Later calls go to a new wmux MCP server."}}\n',
    );
    expect(isReplayAnswer(b('{"jsonrpc":"2.0","id":"wmux-shim-replay","result":{}}\n'))).toBe(true);
    expect(isReplayAnswer(b('{"jsonrpc":"2.0","id":"wmux-shim-replay","method":"x"}\n'))).toBe(false);
    expect(isReplayAnswer(b('{"jsonrpc":"2.0","id":0,"result":{}}\n'))).toBe(false);
  });
});
