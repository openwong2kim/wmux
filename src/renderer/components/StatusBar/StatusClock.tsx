import { useState, useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { UsageWidgetView } from './UsageWidget';

/**
 * A5 (NB2 wave 0) — small components that split clock ticks out of StatusBar.
 *
 * The 1s clock (+5s memory poll) triggers setState every second. Previously this state
 * lived on StatusBar body, so every clock tick re-rendered all of StatusBar (workspace
 * name, prefix, channel badges, notification bell, etc.). Only clock-dependent pieces
 * moved here so ticks do not touch StatusBar body.
 *
 * To preserve the original right-cluster DOM order (cost/usage … plugins/channel/bell …
 * memory/time), split into two pieces:
 *   - StatusClockUsage: company cost + usage widget (front of cluster)
 *   - StatusClockTime : memory + time (back of cluster, after channel/bell)
 * Each has its own 1s cursor and does not re-render the body or each other. Two 1s
 * intervals are negligible; each tick updates only its own small subtree.
 *
 * Behavior unchanged: render output, update cadence, display format, DOM order match
 * previous StatusBar. Only the re-render boundary narrowed.
 */

/** Company cost (elapsed-minutes tooltip) + Anthropic usage widget. Front of right cluster. */
export function StatusClockUsage({ isCompanyMode }: { isCompanyMode: boolean }) {
  const t = useT();
  const sessionStartTime = useStore((s) => s.sessionStartTime);
  const totalCost = useStore((s) => s.company?.totalCostEstimate ?? 0);
  const usage = useStore((s) => s.anthropicUsage);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [sessionMin, setSessionMin] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
      if (sessionStartTime) {
        setSessionMin(Math.floor((Date.now() - sessionStartTime) / 60_000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  return (
    <>
      {/* Show cost in company mode */}
      {isCompanyMode && (
        <span className="text-[var(--text-sub2)]" title={t('statusBar.session', { min: sessionMin })}>
          ~${totalCost.toFixed(2)}
        </span>
      )}
      <UsageWidgetView
        status={usage.status}
        snapshot={usage.snapshot}
        lastError={usage.lastError}
        subscriptionType={usage.subscriptionType}
        nowMs={nowMs}
      />
    </>
  );
}

/** Memory (5s poll) + time (1s). Back of right cluster (after channel/bell). */
export function StatusClockTime() {
  const [time, setTime] = useState(() => new Date());
  const [memUsage, setMemUsage] = useState('');

  // Update clock every second.
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Update memory usage every 5 seconds. Reads the TOTAL app footprint from
  // main (app.getAppMetrics summed RSS across the whole Electron process tree)
  // instead of the renderer-only performance.memory.usedJSHeapSize, which
  // measured just this renderer's V8 JS heap (~10MB) and under-reported real
  // memory usage by roughly an order of magnitude.
  useEffect(() => {
    // Newer builds include wmux RSS in SystemVitals. Keep this poll only as a
    // compatibility fallback when an older preload is paired with this renderer.
    if (typeof window.electronAPI.system.getStats === 'function') return;
    let cancelled = false;
    const update = () => {
      void window.electronAPI.system.getMemoryUsage().then((bytes) => {
        if (cancelled || typeof bytes !== 'number' || bytes <= 0) return;
        setMemUsage(`${Math.round(bytes / 1024 / 1024)}MB`);
      }).catch(() => { /* main not ready / handler swapped — keep last value */ });
    };
    update();
    const timer = setInterval(update, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <>
      {memUsage && <span>{memUsage}</span>}
      <span>{timeStr}</span>
    </>
  );
}
