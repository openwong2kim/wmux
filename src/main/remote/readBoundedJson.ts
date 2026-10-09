/**
 * Read a response body from a remote host as JSON, at most `maxBytes` of it.
 *
 * `res.json()` buffers whatever the peer sends before parsing. This counts
 * bytes as they arrive (a `Content-Length` header is only an early refusal,
 * never trusted as the count) and cancels the body the moment it passes the
 * cap, so a reply costs at most `maxBytes` of main-process heap.
 *
 * Throws on an oversized or non-JSON body; callers already treat a throw from
 * `res.json()` as "not a usable answer".
 */
export class RemoteBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = 'RemoteBodyTooLargeError';
  }
}

export async function readBoundedJson(res: Response, maxBytes: number): Promise<unknown> {
  const body = res.body;
  // A body-less response (or a test double without a stream) has nothing to
  // bound; `json()` reports it the same way it always did.
  if (!body) return res.json();
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await body.cancel().catch(() => { /* already closed */ });
    throw new RemoteBodyTooLargeError(maxBytes);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => { /* already closed */ });
        throw new RemoteBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}
