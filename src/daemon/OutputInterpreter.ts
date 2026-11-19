import { OscParser, type OscCallback } from '../main/pty/OscParser';
import {
  createNativeAllocReporter,
  isNativeAllocFailure,
  loadNativeTerminalCore,
  reportNativeFallback,
  type NativeOscBatch,
  type NativeOutputChunk,
  type NativeOutputInterpreter,
} from '../shared/nativeTerminalCore';
import { OutputModeTracker } from './util/outputModeTracker';

export type OutputModes = Pick<OutputModeTracker, 'isSet' | 'altScreen' | 'preamble' | 'reset'>;

/** One interpreter per bridge lifetime. Feed only captured output, after the
 * ring write. Recovered history seeds modes without replaying historical OSC
 * notifications or prompt events. Native capability is optional for ABI-1 builds.
 *
 * A native feed that refuses an allocation (isNativeAllocFailure) leaves the
 * native interpreter as it was, so the chunk is fed once more. A second
 * refusal skips it (its mode changes and OSC events are not seen) after
 * clearing the native OSC state (clearOsc, which never allocates): an OSC the
 * skipped chunk would have closed cannot swallow the output after it. The next
 * chunk is interpreted as usual. The backend never switches mid-stream:
 * `modes` is handed out by reference, and a fresh JS tracker would report
 * power-on defaults for a pane already in an alternate screen. */
export class OutputInterpreter {
  readonly backend: 'node' | 'rust';
  readonly modes: OutputModes;
  private readonly native?: NativeOutputInterpreter;
  private readonly osc?: OscParser;
  private readonly jsModes?: OutputModeTracker;
  private readonly callbacks: OscCallback[] = [];
  private skipped = 0;
  private readonly reportAllocFailure: (error: unknown, detail?: string) => void;

  /** `label` names the session in log lines. */
  constructor(backend: 'node' | 'rust', label?: string) {
    this.reportAllocFailure = createNativeAllocReporter('output-interpreter', () => label);
    if (backend === 'rust') {
      try {
        const Constructor = loadNativeTerminalCore('output-interpreter-v1').NativeOutputInterpreter;
        if (!Constructor) throw new Error('Missing native output interpreter');
        this.native = new Constructor();
      } catch { reportNativeFallback('output-interpreter'); }
    }
    this.backend = this.native ? 'rust' : 'node';
    if (this.native) this.modes = this.native;
    else {
      this.jsModes = new OutputModeTracker();
      this.modes = this.jsModes;
      this.osc = new OscParser();
    }
  }
  onOsc(callback: OscCallback): void {
    if (this.osc) this.osc.onOsc(callback);
    else this.callbacks.push(callback);
  }
  seedModes(text: string, end: number): void {
    if (this.native) {
      try { this.native.feed(text, end, false); }
      catch (error) { this.skip(error, 'recovered history not scanned for modes'); }
    } else this.jsModes?.feed(text, end);
  }
  feed(text: string, end: number, chunk?: NativeOutputChunk): void {
    if (this.native) {
      const native = this.native;
      const once = (): NativeOscBatch | null => (chunk ? native.feedChunk(chunk, end) : native.feed(text, end, true));
      let events: NativeOscBatch | null;
      try { events = once(); }
      catch (first) {
        if (!isNativeAllocFailure(first)) throw first;
        // A refused feed changed nothing: the same chunk once more.
        try { events = once(); }
        catch (error) {
          if (isNativeAllocFailure(error)) native.clearOsc?.();
          this.skip(error, 'output chunk not interpreted; OSC state cleared');
          return;
        }
      }
      // As in the JS bridge, all mode updates precede OSC callbacks, and OSC
      // callbacks precede agent interpretation and raw output forwarding.
      if (events) for (let i = 0; i < events.codes.length; i++) {
        const event = { code: events.codes[i], data: events.data[i] };
        for (const callback of this.callbacks) callback(event);
      }
    } else {
      this.jsModes?.feed(text, end);
      this.osc?.process(text);
    }
  }
  /** Chunks a refused native allocation kept from being interpreted. */
  get skippedChunks(): number {
    return this.skipped;
  }
  private skip(error: unknown, what: string): void {
    if (!isNativeAllocFailure(error)) throw error;
    this.skipped++;
    this.reportAllocFailure(error, `${what} (${this.skipped} in all)`);
  }
  dispose(): void {
    this.callbacks.length = 0;
    // An async screen render can hold `modes` across bridge cleanup. Preserve
    // its last state, just as the JS tracker does; the N-API finalizer reclaims
    // the interpreter when the final mode reference becomes unreachable.
  }
}
