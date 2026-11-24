import { describe, expect, it, vi } from 'vitest';
import { OutputInterpreter } from '../OutputInterpreter';
import { loadNativeTerminalCore } from '../../shared/nativeTerminalCore';
vi.mock('../../shared/nativeTerminalCore', async (importOriginal) => ({...await importOriginal<typeof import('../../shared/nativeTerminalCore')>(),loadNativeTerminalCore:vi.fn(() => {throw new Error('old module');}),reportNativeFallback:vi.fn()}));

describe('output interpreter selection', () => {
  it('does not load native code for Node PTYs', () => {
    vi.mocked(loadNativeTerminalCore).mockClear();
    const p = new OutputInterpreter('node');
    expect(loadNativeTerminalCore).not.toHaveBeenCalled();
    expect(p.backend).toBe('node'); p.dispose();
  });
  it('keeps older native modules usable through JS interpretation', () => {
    const p = new OutputInterpreter('rust'), events: unknown[] = [];
    expect(p.backend).toBe('node');
    p.onOsc(e => events.push({e, alt:p.modes.altScreen}));
    p.seedModes('\x1b[?1049h\x1b]133;C\x07', 30);
    expect(events).toEqual([]);
    p.feed('\x1b[?1049l\x1b]133;D;0\x07', 60);
    expect(events).toEqual([{e:{code:133,data:'D;0'},alt:false}]);p.dispose();
  });
});
