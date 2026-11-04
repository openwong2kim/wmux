import { randomUUID } from 'node:crypto';
import { isKeepAwakeState, type KeepAwakeState } from '../../shared/sleepPrevention';
import { PHONE_BROWSER_HELP_DECIDE_COMMAND } from '../../shared/phoneBrowserHelp';

export type DesktopPhoneCommand = 'accounts.list' | 'accounts.bind' | 'accounts.usage' | 'accounts.env' | 'accounts.envForAccount' | 'prompts.list' | 'prompts.replace' | 'workspaces.list' | 'workspaces.create' | 'workspaces.fleetTicket' | 'browser.list' | 'browser.capture' | 'browser.viewport' | 'browser.navigate' | 'browser.type' | 'browser.key' | 'browser.tap' | 'browser.open' | 'browser.scroll' | 'browser.focus' | 'browser.history' | 'browser.streamStart' | 'browser.streamUpdate' | 'browser.streamStop' | 'moa.wake' | 'workspaces.roomThreads' | 'workspaces.roomCards' | 'workspaces.roomAttachment' | 'workspaces.roomFile' | 'workspaces.botApproval' | 'workspaces.botApprovalDecide' | 'workspaces.workerResume' | 'workspaces.guestPost' | 'workspaces.browserHelpDecide' | 'agentEnv.summary';
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

/** Requests one desktop may have outstanding at once. */
export const DESKTOP_PHONE_MAX_PENDING = 16;
/**
 * The last slot is a browser help decision's alone
 * (PHONE_BROWSER_HELP_DECIDE_COMMAND): a phone polling Chrome
 * captures (each may wait out its whole capture budget, plus the workspace
 * lookup ahead of each) must never leave the person's Done or Cancel
 * answered `desktop-busy`.
 */

/** How long a request waits for the desktop's reply by default. */
export const DESKTOP_PHONE_TIMEOUT_MS = 15000;

/** Bounded, owner-bound requests to the first-party desktop process. */
export class DesktopPhoneBridge {
  private owner: string | null = null;
  /** Optional commands the attached desktop announced at register; reset with the owner. */
  private commands = new Set<string>();
  /** The owner's last "Keep the computer awake" report; reset with the owner. */
  private awake: KeepAwakeState | null = null;
  private pending = new Map<string, Pending>();
  private readonly ownerLost = new Set<() => void>();
  constructor(private readonly send: (clientId: string, event: unknown) => boolean, private readonly timeoutMs = DESKTOP_PHONE_TIMEOUT_MS) {}
  get available() { return this.owner !== null; }
  /**
   * `commands` is the desktop's announcement of the optional commands it
   * handles. A desktop that predates the announcement sends none, so every
   * optional command reads as unsupported until the owner says otherwise.
   */
  register(clientId: string, commands?: unknown) {
    if (this.owner !== null && this.owner !== clientId) return false;
    this.owner = clientId;
    this.awake = null;
    this.commands = new Set(Array.isArray(commands)
      ? commands.filter((c): c is string => typeof c === 'string' && c.length <= 64).slice(0, 32)
      : []);
    return true;
  }
  /** Whether `clientId` is the registered desktop. */
  isOwner(clientId: string) { return this.owner !== null && this.owner === clientId; }
  /** The registered desktop's client id, null while none is attached. */
  get ownerId(): string | null { return this.owner; }
  /** Called each time the registered desktop goes away. Returns the unsubscribe. */
  onOwnerLost(listener: () => void): () => void {
    this.ownerLost.add(listener);
    return () => { this.ownerLost.delete(listener); };
  }
  /** Whether the attached desktop announced `command` on this connection. */
  supports(command: string) { return this.owner !== null && this.commands.has(command); }
  disconnect(clientId: string) {
    if (this.owner !== clientId) return;
    this.owner = null;
    this.commands = new Set();
    this.awake = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new DesktopPhoneError('desktop-disconnected'));
      this.pending.delete(id);
    }
    for (const listener of [...this.ownerLost]) {
      try { listener(); } catch { /* one listener must not keep the others from hearing it */ }
    }
  }
  /**
   * The desktop's keep-awake mode and whether its blocker is held now, as its
   * owner last reported it. Only the owner may report; anything malformed is
   * refused. Null until the first report, and again once the owner leaves.
   */
  setKeepAwake(clientId: string, state: unknown): boolean {
    if (this.owner === null || this.owner !== clientId || !isKeepAwakeState(state)) return false;
    this.awake = { mode: state.mode, active: state.active };
    return true;
  }
  get keepAwake(): KeepAwakeState | null { return this.owner !== null ? this.awake : null; }
  /** Tell the desktop whether a paired phone is attached. False when no desktop is attached. */
  notifyPhonePresence(attached: boolean): boolean {
    const owner = this.owner;
    if (!owner) return false;
    if (this.send(owner,{type:'phone.presence',sessionId:'',data:{attached}})) return true;
    this.disconnect(owner);
    return false;
  }
  request(command: DesktopPhoneCommand, payload: Record<string,unknown>): Promise<unknown> {
    const owner = this.owner;
    if (!owner) return Promise.reject(new DesktopPhoneError('desktop-unavailable'));
    if (this.pending.size >= (command === PHONE_BROWSER_HELP_DECIDE_COMMAND ? DESKTOP_PHONE_MAX_PENDING : DESKTOP_PHONE_MAX_PENDING - 1)) return Promise.reject(new DesktopPhoneError('desktop-busy'));
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

/**
 * `daemon.phone.keepAwake`: main's keep-awake mode and blocker, for
 * `/api/config`. Only a first-party client (main's own process) is heard, and
 * only when it is the registered desktop.
 */
export function keepAwakeRpc(
  bridge: DesktopPhoneBridge,
  firstParty: (clientId: string) => boolean,
): (params: unknown, ctx: { clientId: string }) => Promise<{ ok: boolean }> {
  return async (params, ctx) => ({ ok: firstParty(ctx.clientId) && bridge.setKeepAwake(ctx.clientId, params) });
}
