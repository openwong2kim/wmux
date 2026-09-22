import { randomUUID } from 'node:crypto';

export type DesktopPhoneCommand = 'accounts.list' | 'accounts.bind' | 'accounts.usage' | 'accounts.env' | 'prompts.list' | 'prompts.replace' | 'workspaces.list' | 'workspaces.create' | 'browser.list' | 'browser.capture' | 'browser.viewport' | 'browser.navigate' | 'browser.type' | 'browser.key' | 'browser.tap' | 'browser.open' | 'browser.scroll';
export class DesktopPhoneError extends Error {
  constructor(public readonly tag: string) { super(tag); }
}
interface Pending {
  owner: string;
  maxBytes: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded, owner-bound requests to the first-party desktop process. */
export class DesktopPhoneBridge {
  private owner: string | null = null;
  private pending = new Map<string, Pending>();
  constructor(private readonly send: (clientId: string, event: unknown) => boolean, private readonly timeoutMs = 15000) {}
  get available() { return this.owner !== null; }
  register(clientId: string) {
    if (this.owner !== null && this.owner !== clientId) return false;
    this.owner = clientId;
    return true;
  }
  disconnect(clientId: string) {
    if (this.owner !== clientId) return;
    this.owner = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new DesktopPhoneError('desktop-disconnected'));
      this.pending.delete(id);
    }
  }
  request(command: DesktopPhoneCommand, payload: Record<string,unknown>): Promise<unknown> {
    const owner = this.owner;
    if (!owner) return Promise.reject(new DesktopPhoneError('desktop-unavailable'));
    if (this.pending.size >= 16) return Promise.reject(new DesktopPhoneError('desktop-busy'));
    const requestId = randomUUID();
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new DesktopPhoneError('desktop-timeout'));
      },this.timeoutMs);
      // A capture reply is one line on the same control pipe as everything else,
      // and DaemonPipeServer drops a connection whose line exceeds
      // MAX_LINE_BUFFER (1 MiB). A 3 MiB allowance here could never be reached —
      // the pipe would have closed first — so it described a path that does not
      // exist. PhoneBrowser caps the base64 at 700 KiB; this is that budget plus
      // room for the rest of the envelope, still inside the line limit.
      this.pending.set(requestId,{owner,resolve,reject,timer,maxBytes:command === 'browser.capture' ? 900 * 1024 : 128 * 1024});
      if (!this.send(owner,{type:'phone.request',sessionId:'',data:{requestId,command,payload,expiresAt:Date.now()+this.timeoutMs}})) {
        this.disconnect(owner);
      }
    });
  }
  complete(clientId: string, response: { requestId?: unknown; ok?: unknown; result?: unknown; error?: unknown }) {
    if (typeof response.requestId !== 'string') return false;
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.owner !== clientId || this.owner !== clientId) return false;
    if (Buffer.byteLength(JSON.stringify(response)) > pending.maxBytes) return false;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.ok === true) pending.resolve(response.result);
    else pending.reject(new DesktopPhoneError('desktop-request-failed'));
    return true;
  }
}
