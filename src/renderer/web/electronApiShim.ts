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
 * awaiting any node of the shim cannot be mistaken for a thenable.
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

function deniedNode(path: string, onDeny: DenyListener): unknown {
  const fn = function denied(): Promise<never> {
    onDeny(path);
    return Promise.reject(new ElectronApiDeniedError(path));
  };
  return new Proxy(fn, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return deniedNode(`${path}.${prop}`, onDeny);
    },
    set() { return false; },
    defineProperty() { return false; },
  });
}

function wrap(impl: ShimImpl, prefix: string, onDeny: DenyListener): unknown {
  // A private copy, NOT frozen: a frozen target would oblige `get` to return
  // the raw nested object, and nested objects must come back wrapped.
  return new Proxy({ ...impl }, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const path = prefix ? `${prefix}.${prop}` : prop;
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        const value = (target as Record<string, unknown>)[prop];
        return isPlainObject(value) ? wrap(value, path, onDeny) : value;
      }
      return deniedNode(path, onDeny);
    },
    set() { return false; },
    defineProperty() { return false; },
    deleteProperty() { return false; },
  });
}

export function createElectronApiShim(impl: ShimImpl, onDeny: DenyListener): unknown {
  return wrap(impl, '', onDeny);
}
