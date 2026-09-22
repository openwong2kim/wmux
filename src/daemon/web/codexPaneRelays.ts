import {randomUUID} from 'node:crypto';
import type {ManagedSession} from '../DaemonSessionManager';
import {createCodexTuiRelay} from './codexTuiRelay';
import type {CodexRelayObservation} from './codexTuiSelection';

type Relay = Awaited<ReturnType<typeof createCodexTuiRelay>>;
interface Entry {id:string; relayId:string; relay?:Relay; owner?:ManagedSession; retired:boolean}

/** Owns relay reservations before PTY spawn and live ownership after it.
 * A failed/retired spawn cannot install a late relay into a recycled pane ID. */
export class CodexPaneRelays {
  private readonly entries = new Map<string,Entry>();
  private readonly closing = new Set<Promise<void>>();
  private readonly creating = new Set<Promise<Relay>>();
  private stopped = false;
  constructor(private readonly create:typeof createCodexTuiRelay = createCodexTuiRelay,
    private readonly cleanupError:()=>void = ()=> { /* noop */ },
    private readonly stateChanged:(id:string,owner:ManagedSession)=>void = ()=> { /* noop */ }) {}

  async prepare(id:string, codeHome?:string) {
    if (this.stopped || this.entries.has(id) || this.entries.size >= 256 || this.creating.size >= 256) throw new Error('Codex pane relay unavailable');
    const entry:Entry = {id,relayId:randomUUID(),retired:false};
    this.entries.set(id,entry);
    let creation:Promise<Relay> | undefined;
    try {
      creation = this.create({codeHome,onStateChange:()=>{
        if (!entry.retired && this.entries.get(id) === entry && entry.owner) this.stateChanged(id,entry.owner);
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
