// The wake-taint tracker (wakeTaint.ts) as a factory module: built at start
// from main's stores, and fed every `handoff.received` fact so each handoff
// carries its sender wake's mark.

import path from 'node:path';
import type { WakeItem } from '../../shared/wake';
import { registerFactoryRpcModule } from './factoryHost';
import { TAINT_FILENAME, WakeTaint, expectWakeTaint, guestTurnProbeOf, setWakeTaint } from './wakeTaint';
import { expectGuestProbes, setFactGuestProbe, setGuestTurnProbe } from './roomWriter';
import { getBotWorkflowStore } from './botWorkflow';

// Part of the app: until (or unless) the tracker runs, reads and stamps
// fail closed.
expectWakeTaint();
expectGuestProbes();

registerFactoryRpcModule('wakeTaint', (_router, deps) => {
  let off: (() => void) | null = null;
  return {
    async start() {
      const [{ getFactLog }, { getHandoffRouter }, { getTaskLedger }, { currentWakeItem, wakeItemById }, { getBotRuntime, setBotRuntimePorts }, { resolveFactsFrom }, { getBotDirectory }] = await Promise.all([
        import('./factLog'),
        import('./handoffRouter'),
        import('../deck/taskLedgerHost'),
        import('./wakeQueue'),
        import('./BotRuntime'),
        import('./factoryWiring'),
        import('./botStore'),
      ]);
      // The bot's running wake and when its turn began (the queue's item and
      // the runtime's turn must name the same wake).
      const runningWake = (botId: string): { item: WakeItem; startedAt: number } | null => {
        const item = currentWakeItem(botId);
        const turn = getBotRuntime()?.currentTurn(botId);
        return item && turn && turn.wakeId === item.id ? { item, startedAt: turn.startedAt } : null;
      };
      const taint = new WakeTaint({
        facts: (ids) => resolveFactsFrom(getFactLog(), ids),
        handoff: (id) => getHandoffRouter()?.get(id) ?? null,
        taskRow: (id) => getTaskLedger().get(id),
        workflow: (id) => getBotWorkflowStore()?.provenance(id) ?? null,
        runningWake,
        bot: (botId) => getBotDirectory()?.get(botId) ?? null,
        file: path.join(deps.wmuxDir(), 'factory', TAINT_FILENAME),
      });
      setWakeTaint(taint, runningWake, wakeItemById);
      // The runtime marks a bot's conversation by the wakes run in it
      // (conversationMarks.ts).
      setBotRuntimePorts({ wakeTainted: (item) => taint.wakeTainted(item) });
      // A bot's card written in its running wake is stamped (RoomCard.origin)
      // unless that wake is known clean; a write outside a wake passes its
      // origin itself.
      setGuestTurnProbe(guestTurnProbeOf(taint, runningWake));
      // A fact's system cards (a handoff's title or answer, a notice) are
      // stamped the same way, from the fact's own record.
      setFactGuestProbe((f) => taint.factGuest(f) !== false);
      const log = getFactLog();
      off = log ? log.subscribe((f) => taint.onFact(f)) : null;
    },
    dispose() {
      off?.();
      off = null;
      setGuestTurnProbe(null);
      setFactGuestProbe(null);
      setWakeTaint(null);
    },
  };
});
