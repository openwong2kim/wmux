/**
 * The renderer `rpc` bridge (electronAPI.rpc.invoke → pipe RpcRouter) wraps
 * the daemon reply in the RPC protocol envelope `{ id, ok, result }`, where
 * `result` is the daemon's own reply (`{ ok, tasks }`, `{ ok, channels }`,
 * `{ ok, members }`, ...). Confirmed via live CDP; PluginFrame's events.poll
 * loop reads `resp.result` the same way. Peel the transport envelope so
 * callers see the daemon reply. Falls back to the value itself when it is
 * already unwrapped (e.g. `mutateChannelLocal`, which returns the daemon reply
 * directly), so both shapes are tolerated.
 */
export function unwrapRpc(res: unknown): unknown {
  if (
    res !== null &&
    typeof res === 'object' &&
    'result' in res &&
    (res as { result?: unknown }).result !== null &&
    typeof (res as { result?: unknown }).result === 'object'
  ) {
    return (res as { result: unknown }).result;
  }
  return res;
}
