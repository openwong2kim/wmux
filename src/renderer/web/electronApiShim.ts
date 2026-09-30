/**
 * `window.electronAPI` for the browser build (wmux web `/app`).
 *
 * The desktop renderer's components talk to the main process through the
 * preload bridge. In a browser there is no main process, and the page runs
 * with a durable device credential in reach, so the shim is DENY BY DEFAULT:
 * anything not listed in `impl` resolves to a denied stub that records the
 * call and returns a rejected promise. It never falls through to a network
 * call — the implemented members are static values and no-op subscriptions
 * only, and none of them reaches a daemon write endpoint.
 *
 * A denied path is still a callable object (so `api.foo.bar()` rejects instead
 * of throwing a TypeError at the call site), and `then` is never exposed, so
 * awaiting any node of the shim cannot be mistaken for a thenable. The rejected
 * promise is pre-marked handled: a caller that awaits it still gets the error,
 * but fire-and-forget callers (`void api.x()`) do not surface as an uncaught
 * rejection. Every node is created once per path, so repeated reads return the
 * same object.
 */

export type ShimImpl = { readonly [key: string]: unknown };

/** Called once per denied call, with the dotted member path. */
export type DenyListener = (path: string) => void;

export class ElectronApiDeniedError extends Error {
  constructor(readonly path: string) {
    super(`electronAPI.${path} is not available in the browser`);
    this.name = 'ElectronApiDeniedError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

type NodeCache = Map<string, unknown>;

function deniedNode(path: string, onDeny: DenyListener, nodes: NodeCache): unknown {
  const cached = nodes.get(path);
  if (cached) return cached;
  const fn = function denied(): Promise<never> {
    onDeny(path);
    const p = Promise.reject(new ElectronApiDeniedError(path));
    p.catch(() => undefined);
    return p;
  };
  const node = new Proxy(fn, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return deniedNode(`${path}.${prop}`, onDeny, nodes);
    },
    set() { return false; },
    defineProperty() { return false; },
  });
  nodes.set(path, node);
  return node;
}

function wrap(impl: ShimImpl, prefix: string, onDeny: DenyListener, nodes: NodeCache): unknown {
  const cached = nodes.get(`impl:${prefix}`);
  if (cached) return cached;
  // A private copy, NOT frozen: a frozen target would oblige `get` to return
  // the raw nested object, and nested objects must come back wrapped.
  const node = new Proxy({ ...impl }, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const path = prefix ? `${prefix}.${prop}` : prop;
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        const value = (target as Record<string, unknown>)[prop];
        return isPlainObject(value) ? wrap(value, path, onDeny, nodes) : value;
      }
      return deniedNode(path, onDeny, nodes);
    },
    set() { return false; },
    defineProperty() { return false; },
    deleteProperty() { return false; },
  });
  nodes.set(`impl:${prefix}`, node);
  return node;
}

export function createElectronApiShim(impl: ShimImpl, onDeny: DenyListener): unknown {
  return wrap(impl, '', onDeny, new Map());
}
