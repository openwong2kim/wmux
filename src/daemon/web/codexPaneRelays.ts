import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {ManagedSession} from '../DaemonSessionManager';
import {createCodexTuiRelay,CodexUpstreamError,type CodexAnswerOutcome,type CodexDecisionSettledReason,type CodexTurnEnd} from './codexTuiRelay';
import type {CodexDecisionAnswer,CodexDecisionRequest} from './codexDecisions';
import type {CodexRelayObservation} from './codexTuiSelection';
import {threadIdentityEnv} from './codexRelayPolicy';

type Relay = Awaited<ReturnType<typeof createCodexTuiRelay>>;
interface Entry {id:string; relayId:string; relay?:Relay; owner?:ManagedSession; retired:boolean; codeHome?:string}

export interface CodexPaneRelayHooks {
  /** Before every relay (and so every wmux Codex launch): make sure the shared
   * account server runs, started with no WMUX_* variable. Must not throw. */
  ensureRuntime?:(id:string,codeHome?:string)=>Promise<void>;
  /** Is the account's shared server proven to have been started clean? */
  serverProven?:(codeHome?:string)=>boolean;
  /** A Codex request in pane `id` was refused. */
  refused?:(id:string,reason:string)=>void;
  /** A client response in pane `id` was not forwarded (no matching pending server request). */
  unmatchedResponse?:(id:string,count:number)=>void;
  /** A Codex approval a phone may answer is pending in pane `id` (its committed owner). */
  decisionPending?:(id:string,owner:ManagedSession,ref:CodexDecisionRef,request:CodexDecisionRequest)=>void;
  /** A request reported by `decisionPending` is over without `answer`. */
  decisionSettled?:(id:string,ref:CodexDecisionRef,reason:CodexDecisionSettledReason)=>void;
}
/** One Codex request, keyed by (relay incarnation, thread, server request id). */
export interface CodexDecisionRef {relayId:string; threadId:string; requestId:string; method?:string}
/** Remembered thread owners; the oldest is forgotten past this (forgotten = unknown owner). */
const MAX_THREAD_OWNERS = 4096;
/** Hard bound on a native interrupt: the request and the wait for the pane's own `turn/completed`. */
export const CODEX_NATIVE_INTERRUPT_MS = 5000;
/** A Codex turn one relay incarnation reported running (the Codex turn id never leaves the daemon). */
export interface CodexTurnRef {relayId:string; threadId:string; turnId:string}
/**
 * - `interrupted`: the pane's own stream reported `turn/completed` with status
 *   `interrupted` for the aimed turn. The only proof of a native stop.
 * - `not-written`: nothing reached the server, or it refused the request
 *   (wrong turn, unknown thread), so it did nothing.
 * - `uncertain`: written, and no proof either way in time (`{}` alone, no
 *   answer, or the turn ended some other way).
 */
export type CodexNativeInterrupt = {outcome:'interrupted'|'not-written'|'uncertain'; turn?:CodexTurnRef};

/** Owns relay reservations before PTY spawn and live ownership after it.
 * A failed/retired spawn cannot install a late relay into a recycled pane ID. */
export class CodexPaneRelays {
  private readonly entries = new Map<string,Entry>();
  private readonly closing = new Set<Promise<void>>();
  private readonly creating = new Set<Promise<Relay>>();
  private stopped = false;
  constructor(private readonly create:typeof createCodexTuiRelay = createCodexTuiRelay,
    private readonly cleanupError:()=>void = ()=> { /* noop */ },
    private readonly stateChanged:(id:string,owner:ManagedSession)=>void = ()=> { /* noop */ },
    private readonly hooks:CodexPaneRelayHooks = {}) {}

  /** Thread id → pane that started, resumed or forked it through its relay. */
  private readonly threadOwners = new Map<string,string>();

  private ownerOf(threadId:string) {
    const paneId = this.threadOwners.get(threadId);
    if (paneId === undefined) return undefined;
    const entry = this.entries.get(paneId);
    return {paneId,live:!!entry && !entry.retired && !!entry.owner};
  }

  private recordOwner(threadId:string, paneId:string) {
    this.threadOwners.delete(threadId);
    this.threadOwners.set(threadId,paneId);
    if (this.threadOwners.size > MAX_THREAD_OWNERS) {
      const oldest = this.threadOwners.keys().next().value;
      if (oldest !== undefined) this.threadOwners.delete(oldest);
    }
  }

  async prepare(id:string, codeHome?:string) {
    if (this.stopped || this.entries.has(id) || this.entries.size >= 256 || this.creating.size >= 256) throw new Error('Codex pane relay unavailable');
    const entry:Entry = {id,relayId:randomUUID(),retired:false,codeHome};
    this.entries.set(id,entry);
    try {await this.hooks.ensureRuntime?.(id,codeHome);} catch {/* The relay probe below decides availability. */}
    let creation:Promise<Relay> | undefined;
    try {
      creation = this.create({codeHome,onStateChange:()=>{
        if (!entry.retired && this.entries.get(id) === entry && entry.owner) this.stateChanged(id,entry.owner);
      },policy:{
        paneId:id,
        // Only the committed owner's own session record; never a client value.
        identity:()=>!entry.retired && this.entries.get(id) === entry && entry.owner && entry.owner.meta.id === id
          ? threadIdentityEnv({id,env:entry.owner.meta.env}) : undefined,
        serverProven:()=>this.hooks.serverProven?.(codeHome) ?? false,
        owner:(threadId)=>this.ownerOf(threadId),
        recordOwner:(threadId)=>{ if (!entry.retired && this.entries.get(id) === entry) this.recordOwner(threadId,id); },
        refused:(reason)=>this.hooks.refused?.(id,reason),
        unmatchedResponse:(count)=>this.hooks.unmatchedResponse?.(id,count),
        decisionPending:(requestId,request)=>{
          if (entry.retired || this.entries.get(id) !== entry || !entry.owner) return;
          this.hooks.decisionPending?.(id,entry.owner,{relayId:entry.relayId,threadId:request.threadId,requestId,method:request.method},request);
        },
        decisionSettled:(requestId,threadId,reason)=>{
          this.hooks.decisionSettled?.(id,{relayId:entry.relayId,threadId,requestId},reason);
        },
      }});
      this.creating.add(creation);
      const relay = await creation;
      entry.relay = relay;
      if (this.stopped || entry.retired || this.entries.get(id) !== entry) {
        await this.closeEntry(entry);
        throw new Error('Codex pane relay retired');
      }
      return {
        url:relay.url,
        commit:(owner:ManagedSession):boolean=>{
          if (entry.retired || this.entries.get(id) !== entry || entry.owner || owner.meta.id !== id ||
              !['attached','detached'].includes(owner.meta.state)) return false;
          entry.owner = owner;
          try {this.stateChanged(id,owner);}
          catch {void this.retireEntry(entry);return false;}
          return true;
        },
        close:()=>this.retireEntry(entry),
      };
    } catch(error) {
      if(this.entries.get(id) === entry)this.entries.delete(id);
      entry.retired = true;
      throw error;
    } finally {if(creation)this.creating.delete(creation);}
  }

  /** Live settings AUTHORITY: nothing at all once the relay is retired or unowned. */
  selection(id:string, owner:ManagedSession | undefined) {
    const entry = this.entries.get(id);
    const observed = this.liveSelection(id,owner);
    return observed.live && observed.selection ? {...observed.selection,relayId:entry!.relayId} : undefined;
  }

  /** Durable recovery HINT: reports whether a live relay answered at all, so the
   * caller can preserve the last confirmed hint when the transport is simply gone. */
  liveSelection(id:string, owner:ManagedSession | undefined):CodexRelayObservation {
    const entry = this.entries.get(id);
    if (!entry || entry.retired || !entry.owner) return {live:false};
    if (!owner || entry.owner !== owner || !['attached','detached'].includes(owner.meta.state)) {
      void this.retireEntry(entry);return {live:false};
    }
    const relay = entry.relay;
    if (!relay || relay.retired()) return {live:false};
    const selected = relay.current();
    return selected ? {live:true,selection:selected} : {live:true};
  }

  /**
   * The Codex home of the account server a live, owned relay talks to (the
   * pane's spawn `CODEX_HOME`, else the default); undefined otherwise.
   */
  accountHome(id:string, owner:ManagedSession | undefined):string | undefined {
    if (!this.liveSelection(id,owner).live) return undefined;
    return this.entries.get(id)?.codeHome ?? path.join(os.homedir(),'.codex');
  }

  /** Panes whose relay is live and committed to an owner. */
  liveIds():string[] {
    return [...this.entries.values()].filter(entry=>!entry.retired && !!entry.owner && !!entry.relay && !entry.relay.retired()).map(entry=>entry.id);
  }

  /**
   * A phone's answer to one request: Yes = `accept`, No = `cancel` (what Esc
   * sends in the TUI; it interrupts the turn). Only the relay incarnation that
   * reported the request can answer it, and only while its pane still owns the
   * thread; anything else is `not-found`.
   */
  answer(ref:{relayId?:string; threadId?:string; requestId:string}, decision:'approve'|'deny'):Promise<CodexAnswerOutcome> {
    const answer:CodexDecisionAnswer = decision === 'approve' ? 'accept' : 'cancel';
    const entry = ref.relayId === undefined ? undefined : [...this.entries.values()].find(e=>e.relayId === ref.relayId);
    if (!entry || entry.retired || !entry.owner || !entry.relay || entry.relay.retired() || ref.threadId === undefined) return Promise.resolve('not-found');
    const owner = this.ownerOf(ref.threadId);
    if (owner?.paneId !== entry.id || !owner.live) return Promise.resolve('not-found');
    return entry.relay.answer(ref.threadId,ref.requestId,answer);
  }

  /** The running Codex turn of the pane's foreground thread, from its own live relay. */
  activeTurn(id:string, owner:ManagedSession | undefined):CodexTurnRef | undefined {
    const observed = this.liveSelection(id,owner);
    const entry = this.entries.get(id);
    if (!observed.live || !observed.selection || !entry?.relay) return undefined;
    const turnId = entry.relay.activeTurn(observed.selection.threadId);
    return turnId ? {relayId:entry.relayId,threadId:observed.selection.threadId,turnId} : undefined;
  }

  /**
   * Stop the pane's running Codex turn with `turn/interrupt`, bounded by
   * `timeoutMs` in total. The waiter on the pane's own stream is registered
   * before the request leaves, and only that stream decides `interrupted`:
   * the request's `{}` never does.
   */
  async interrupt(id:string, owner:ManagedSession | undefined, timeoutMs = CODEX_NATIVE_INTERRUPT_MS):Promise<CodexNativeInterrupt> {
    const turn = this.activeTurn(id,owner);
    const relay = this.entries.get(id)?.relay;
    if (!turn || !relay) return {outcome:'not-written'};
    const wait = relay.waitTurnEnd(turn.threadId,turn.turnId,timeoutMs);
    let answer:'answered'|'refused'|'not-sent'|'uncertain'|undefined;
    const request = relay.interrupt(turn.threadId,turn.turnId,timeoutMs).then(
      ()=>{answer = 'answered';},
      (error:unknown)=>{answer = error instanceof CodexUpstreamError && error.kind !== 'uncertain' ? error.kind : 'uncertain';});
    // A refusal or a request that never left ends the wait early; `{}` does not.
    void request.then(()=>{ if (answer === 'refused' || answer === 'not-sent') wait.cancel(); });
    const status:CodexTurnEnd | undefined = await wait.ended;
    if (status === 'interrupted') return {outcome:'interrupted',turn};
    await request;
    return {outcome:answer === 'refused' || answer === 'not-sent' ? 'not-written' : 'uncertain',turn};
  }

  /** How the turn ended, when the same relay incarnation's stream reported it. */
  turnEnded(id:string, ref:CodexTurnRef):CodexTurnEnd | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.retired || entry.relayId !== ref.relayId || !entry.relay) return undefined;
    return entry.relay.turnEnded(ref.threadId,ref.turnId);
  }

  retire(id:string):Promise<void> {
    const entry = this.entries.get(id);
    return entry ? this.retireEntry(entry) : Promise.resolve();
  }

  async shutdown():Promise<void> {
    this.stopped = true;
    await Promise.all([...this.entries.values()].map(entry=>this.retireEntry(entry)));
    await Promise.allSettled([...this.creating]);
    await Promise.all([...this.closing]);
  }

  private retireEntry(entry:Entry):Promise<void> {
    entry.retired = true;
    if(this.entries.get(entry.id) === entry)this.entries.delete(entry.id);
    return this.closeEntry(entry);
  }

  private closeEntry(entry:Entry):Promise<void> {
    const relay = entry.relay;
    if(!relay)return Promise.resolve();
    entry.relay = undefined;
    const task = relay.close().catch(()=>{try{this.cleanupError();}catch{/* Diagnostics cannot restore authority. */}});
    this.closing.add(task);
    void task.then(()=>this.closing.delete(task));
    return task;
  }
}
