// The delegate's startup gate: off ⇒ nothing registered, no file read or
// written (an existing moa-ask.json is only set back to false).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const state = vi.hoisted(() => ({ config: { enabled: true, askMode: 'off' as string }, switchPath: '', written: new Set<() => void>() }));

vi.mock('../deckHqStore', () => ({
  getMoaConfig: () => ({ ...state.config, autoRules: [], trustedAuthors: [] }),
  setMoaAutoRules: async () => true,
  onHqStoreWritten: (l: () => void) => { state.written.add(l); return () => state.written.delete(l); },
}));
vi.mock('../../../shared/moaAskSwitch', async (orig) => ({
  ...(await orig<typeof import('../../../shared/moaAskSwitch')>()),
  moaAskSwitchPath: () => state.switchPath,
}));
vi.mock('../moaShadowHost', () => ({
  findShadowJudgment: () => null,
  readPaneScreen: async () => [],
  runMoaJudge: vi.fn(async () => ({ reply: null, error: 'unused', tokens: { input: 0, output: 0 }, ms: 0 })),
}));
vi.mock('../taskLedgerHost', () => ({ getTaskLedger: () => ({ list: () => [] }) }));
vi.mock('../../github/GhPrReviewService', () => ({ ghPrReviewService: {} }));
vi.mock('../../github/GhIssueService', () => ({ ghIssueService: {} }));
vi.mock('../../github/PrProvider', () => ({ detectRemote: async () => null }));

import { refreshMoaDelegate, startMoaDelegate, syncMoaAskSwitch } from '../moaDelegateWiring';
import { getMoaDelegateService } from '../moaDelegatePorts';
import { runMoaJudge } from '../moaShadowHost';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-moa-wiring-'));
  state.switchPath = path.join(dir, 'moa-ask.json');
  state.config = { enabled: true, askMode: 'off' };
});
afterEach(() => {
  state.config = { enabled: true, askMode: 'off' };
  refreshMoaDelegate();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('moaDelegateWiring', () => {
  it('off: registers nothing, writes nothing, calls no judge', () => {
    expect(startMoaDelegate({ getDaemonClient: () => null, wmuxDir: dir, log: () => undefined })).toBeNull();
    expect(getMoaDelegateService()).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(runMoaJudge).not.toHaveBeenCalled();
  });

  it('on: registers the service and turns the MCP switch on; off again unregisters and sets it false', () => {
    state.config = { enabled: true, askMode: 'suggest' };
    const svc = startMoaDelegate({ getDaemonClient: () => null, wmuxDir: dir, log: () => undefined });
    expect(svc).not.toBeNull();
    expect(getMoaDelegateService()).toBe(svc);
    expect(JSON.parse(fs.readFileSync(state.switchPath, 'utf8'))).toEqual({ enabled: true });
    state.config = { enabled: true, askMode: 'off' };
    expect(refreshMoaDelegate()).toBeNull();
    expect(getMoaDelegateService()).toBeNull();
    expect(JSON.parse(fs.readFileSync(state.switchPath, 'utf8'))).toEqual({ enabled: false });
  });

  it('off → on stops the old service and reuses the same stores (one writer per file)', () => {
    state.config = { enabled: true, askMode: 'suggest' };
    const first = startMoaDelegate({ getDaemonClient: () => null, wmuxDir: dir, log: () => undefined })!;
    const stop = vi.spyOn(first, 'stop');
    state.config = { enabled: true, askMode: 'off' };
    refreshMoaDelegate();
    expect(stop).toHaveBeenCalledTimes(1);
    state.config = { enabled: true, askMode: 'suggest' };
    const second = refreshMoaDelegate()!;
    expect(second).not.toBe(first);
    type WithPorts = { ports: { decisions: unknown; effects: unknown } };
    expect((second as unknown as WithPorts).ports.decisions).toBe((first as unknown as WithPorts).ports.decisions);
    expect((second as unknown as WithPorts).ports.effects).toBe((first as unknown as WithPorts).ports.effects);
  });

  it('saving the settings starts and stops the delegate without a reconnect', () => {
    expect(startMoaDelegate({ getDaemonClient: () => null, wmuxDir: dir, log: () => undefined })).toBeNull();
    const saved = () => { for (const l of state.written) l(); };
    state.config = { enabled: true, askMode: 'auto' };
    saved();
    expect(getMoaDelegateService()).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(state.switchPath, 'utf8'))).toEqual({ enabled: true });
    state.config = { enabled: true, askMode: 'off' };
    saved();
    expect(getMoaDelegateService()).toBeNull();
    expect(JSON.parse(fs.readFileSync(state.switchPath, 'utf8'))).toEqual({ enabled: false });
    // One listener, however often main reconnects.
    startMoaDelegate({ getDaemonClient: () => null, wmuxDir: dir, log: () => undefined });
    expect(state.written.size).toBe(1);
  });

  it('Moa itself off means the delegate is off whatever the mode says', () => {
    state.config = { enabled: false, askMode: 'auto' };
    expect(startMoaDelegate({ getDaemonClient: () => null, wmuxDir: dir, log: () => undefined })).toBeNull();
    expect(fs.existsSync(state.switchPath)).toBe(false);
  });

  it('a corrupt store keeps the delegate off without throwing', () => {
    state.config = { enabled: true, askMode: 'auto' };
    fs.mkdirSync(path.join(dir, 'moa-delegate'));
    fs.writeFileSync(path.join(dir, 'moa-delegate', 'decisions.json'), '{"version":1,"decisions":[{"id":"forged"}]}');
    expect(startMoaDelegate({ getDaemonClient: () => null, wmuxDir: dir, log: () => undefined })).toBeNull();
    expect(getMoaDelegateService()).toBeNull();
  });

  it('syncMoaAskSwitch never creates the file while off', () => {
    syncMoaAskSwitch('off', state.switchPath);
    expect(fs.existsSync(state.switchPath)).toBe(false);
  });
});
