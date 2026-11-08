// A browser on the far end of a debugging pipe, for the pipe multiplexer's tests.
import { PassThrough } from 'node:stream';

export interface Command { id: number; method: string; params: Record<string, unknown>; sessionId?: string }

/**
 * A browser on the far end of the pipe, as far as the mux can tell: browser
 * sessions, flattened child sessions, per-session auto-attach, and replies
 * that put "id" first and "sessionId" last, as Chrome writes them.
 */
export class FakeBrowser {
  readonly toMux = new PassThrough();
  readonly fromMux = new PassThrough();
  readonly received: Command[] = [];
  readonly rawReceived: string[] = [];
  private carry = '';
  private n = 0;
  readonly sessions = new Set<string>();
  readonly autoAttach = new Set<string>();
  /** Sessions whose auto-attach asked to pause new targets (waitForDebuggerOnStart). */
  readonly pauseOnStart = new Set<string>();
  /** Methods whose replies are held until releaseHeld(). */
  readonly holdReplies = new Set<string>();
  private heldReplies: Command[] = [];
  private releasing = false;
  readonly targets: Array<{ targetId: string; title: string; url: string }> = [];
  /** What Page.getFrameTree answers, when set. */
  frameTree: unknown = null;

  constructor() {
    this.fromMux.on('data', (chunk: Buffer) => {
      this.carry += chunk.toString('utf8');
      for (let i = this.carry.indexOf('\0'); i !== -1; i = this.carry.indexOf('\0')) {
        const text = this.carry.slice(0, i);
        this.carry = this.carry.slice(i + 1);
        this.rawReceived.push(text);
        const command = JSON.parse(text) as Command;
        this.received.push(command);
        this.handle(command);
      }
    });
  }

  emit(text: string): void {
    this.toMux.write(`${text}\0`);
  }

  reply(command: Command, body: string): void {
    this.emit(`{"id":${command.id},${body}${command.sessionId ? `,"sessionId":${JSON.stringify(command.sessionId)}` : ''}}`);
  }

  event(sessionId: string, method: string, params: Record<string, unknown>): void {
    this.emit(`{"method":${JSON.stringify(method)},"params":${JSON.stringify(params)},"sessionId":${JSON.stringify(sessionId)}}`);
  }

  /** Answer the held commands now. */
  releaseHeld(): void {
    const held = this.heldReplies;
    this.heldReplies = [];
    // A flag, not an argument: subclasses override handle(c) and call super.handle(c).
    this.releasing = true;
    try {
      for (const c of held) this.handle(c);
    } finally {
      this.releasing = false;
    }
  }

  protected handle(c: Command): void {
    if (!this.releasing && this.holdReplies.has(c.method)) {
      this.heldReplies.push(c);
      return;
    }
    if (c.sessionId !== undefined && !this.sessions.has(c.sessionId)) {
      this.reply(c, '"error":{"code":-32001,"message":"Session with given id not found."}');
      return;
    }
    switch (c.method) {
      case 'Target.attachToBrowserTarget': {
        const s = `B${++this.n}`;
        this.sessions.add(s);
        this.reply(c, `"result":{"sessionId":"${s}"}`);
        return;
      }
      case 'Target.attachToTarget': {
        const s = `C${++this.n}`;
        this.sessions.add(s);
        this.reply(c, `"result":{"sessionId":"${s}"}`);
        return;
      }
      case 'Target.setAutoAttach':
        if (c.sessionId) this.autoAttach.add(c.sessionId);
        if (c.sessionId && c.params.waitForDebuggerOnStart === true) this.pauseOnStart.add(c.sessionId);
        this.reply(c, '"result":{}');
        return;
      case 'Target.createTarget': {
        const targetId = `T${++this.n}`;
        this.targets.push({ targetId, title: '', url: String(c.params.url) });
        this.reply(c, `"result":{"targetId":"${targetId}"}`);
        for (const parent of this.autoAttach) {
          const child = `C${++this.n}`;
          this.sessions.add(child);
          const browserContextId = typeof c.params.browserContextId === 'string' ? c.params.browserContextId : 'DEFAULT';
          this.event(parent, 'Target.attachedToTarget', { sessionId: child, targetInfo: { targetId, type: 'page', browserContextId }, waitingForDebugger: this.pauseOnStart.has(parent) });
        }
        return;
      }
      case 'Target.detachFromTarget':
        if (typeof c.params.sessionId === 'string') this.sessions.delete(c.params.sessionId);
        this.reply(c, '"result":{}');
        return;
      case 'Test.idLast':
        // Not how Chrome writes it: the mux must not depend on the id coming first.
        this.emit(`{"result":{"ok":true},"id":${c.id}${c.sessionId ? `,"sessionId":${JSON.stringify(c.sessionId)}` : ''}}`);
        return;
      case 'Runtime.evaluate':
        this.reply(c, `"result":{"result":{"type":"string","value":${JSON.stringify(String(c.params.expression))}}}`);
        return;
      case 'Target.getTargets':
        this.reply(c, `"result":{"targetInfos":${JSON.stringify(this.targets.map((t) => ({ targetId: t.targetId, type: 'page', title: t.title, url: t.url, attached: false })))}}`);
        return;
      case 'Page.getFrameTree':
        this.reply(c, this.frameTree ? `"result":{"frameTree":${JSON.stringify(this.frameTree)}}` : `"result":{"echo":"Page.getFrameTree"}`);
        return;
      case 'Target.closeTarget':
      case 'Target.activateTarget':
        this.reply(c, '"result":{"success":true}');
        return;
      default:
        this.reply(c, `"result":{"echo":${JSON.stringify(c.method)}}`);
    }
  }
}

