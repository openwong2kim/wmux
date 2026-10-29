// The A2A route table's dispatch: a route registered with `when` exists only
// while its check holds, and is an unknown path otherwise.
import type http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { A2aRouteTable } from '../routes';

const PEER = { peerId: 'p', hostId: '11111111-1111-4111-8111-111111111111', name: 'A' };

/** What the table answered, through the slice of a response it writes. */
async function answer(table: A2aRouteTable, method: string, pathname: string): Promise<{ status: number; body: unknown }> {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(payload?: string) {
      out.body = payload === undefined ? undefined : JSON.parse(payload);
    },
  } as unknown as http.ServerResponse;
  const req = { method } as http.IncomingMessage;
  await table.handle(req, res, new URL(pathname, 'https://a2a.invalid'), pathname, PEER);
  return out;
}

describe('A2aRouteTable — a route that exists only while a check holds', () => {
  it('off, answers exactly what a path never registered answers; on, reaches its handler', async () => {
    let on = false;
    const handler = vi.fn(({ res }: { res: http.ServerResponse }) => {
      res.writeHead(200);
      res.end('{"ok":true}');
    });
    const table = new A2aRouteTable().add('PUT', '/api/a2a/continue/:continueId/:sha256', handler, { when: () => on });

    const unknown = await answer(table, 'PUT', '/api/a2a/nowhere/x/y');
    expect(unknown).toEqual({ status: 404, body: { ok: false, error: 'bad-request', message: 'not found' } });
    expect(await answer(table, 'PUT', '/api/a2a/continue/x/y')).toEqual(unknown);
    // Not even a 405 for another method: the path is not there at all.
    expect(await answer(table, 'GET', '/api/a2a/continue/x/y')).toEqual(unknown);
    expect(handler).not.toHaveBeenCalled();

    on = true;
    expect(await answer(table, 'PUT', '/api/a2a/continue/x/y')).toEqual({ status: 200, body: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ params: { continueId: 'x', sha256: 'y' }, peer: PEER });
  });
});
