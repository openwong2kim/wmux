import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { UsageWidgetView } from './UsageWidget';

/**
 * A5 (NB2 파동 0) — StatusBar에서 시계 틱을 분리한 소형 컴포넌트들.
 *
 * 1초 시계(+5초 메모리 폴)는 매초 setState로 리렌더를 유발한다. 이전에는
 * 이 상태가 StatusBar 본체에 있어, 시계 한 틱마다 StatusBar 전체(워크스페이스
 * 이름·프리픽스·채널 배지·알림 벨 등)가 리렌더됐다. 시계에 의존하는 조각만
 * 이 파일로 옮겨 틱이 StatusBar 본체를 건드리지 않게 한다.
 *
 * 우측 클러스터의 원래 DOM 순서(비용/사용량 … 플러그인/채널/벨 … 메모리/시각)를
 * 보존하기 위해 두 조각으로 나눈다:
 *   - StatusClockUsage: company 비용 + 사용량 위젯(클러스터 앞부분)
 *   - StatusClockTime : 메모리 + 시각(클러스터 뒷부분)
 * 각자 자체 1초 커서를 가져 본체와 서로를 리렌더하지 않는다. 두 개의 1초
 * 인터벌 비용은 무시 가능하며, 각 틱은 자기 소형 서브트리만 갱신한다.
 *
 * 동작 불변: 렌더 출력·갱신 주기·표시 포맷·DOM 순서는 이전 StatusBar와 동일.
 * 리렌더 경계만 좁혔다.
 */

/** company 비용(경과 분 툴팁) + Anthropic 사용량 위젯. 우측 클러스터 앞부분. */
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
      {/* Company 모드일 때 비용 표시 */}
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

// ─── Titlebar vitals: render only when they mean something ──────────────────
//
// DESIGN.md ("Fleet vitals = appearing chips … they render ONLY when nonzero —
// no dead gauges"). The memory reading and the wall-clock were the two
// exceptions: `553MB 09:22` sat in the titlebar permanently, saying nothing
// about the fleet at any moment of any session, and spending two of the
// strip's meaning-points to do it.
//
// Memory now appears only when it is worth interrupting for — a large absolute
// footprint, or one that has more than doubled since this window started (the
// shape of the leak the chip was added to catch). The clock is off unless
// asked for: the OS already draws one, and it is only missing for people
// running wmux full-screen with the taskbar hidden.

/** Absolute floor for the memory chip. Below this the number is noise. */
export const MEMORY_CHIP_MIN_BYTES = 1.5 * 1024 * 1024 * 1024;

/** …or this much of the footprint the window started with. */
export const MEMORY_CHIP_GROWTH_FACTOR = 1.5;

/**
 * Once shown, the chip holds until the footprint drops below this fraction of
 * the level that showed it. Without the band a footprint sitting ON the
 * threshold flickers the chip in and out every poll — the titlebar equivalent
 * of a blinking light, and worse than either state.
 */
export const MEMORY_CHIP_HYSTERESIS = 0.9;

/** Poll cadence: rare while the chip is hidden, live while it is on screen. */
export const MEMORY_POLL_HIDDEN_MS = 30_000;
export const MEMORY_POLL_SHOWN_MS = 5_000;

/**
 * The footprint at which the chip appears: the absolute floor, or the growth
 * rule, whichever this window reaches first. `baselineBytes` is the first
 * reading it took (null before one has landed, so only the floor can fire).
 */
export function memoryChipLevel(baselineBytes: number | null): number {
  if (baselineBytes === null || baselineBytes <= 0) return MEMORY_CHIP_MIN_BYTES;
  return Math.min(MEMORY_CHIP_MIN_BYTES, baselineBytes * MEMORY_CHIP_GROWTH_FACTOR);
}

/**
 * Pure — the whole rule for whether the chip is worth a titlebar slot.
 * `wasShown` carries the hysteresis: showing takes the full level, staying
 * shown only takes MEMORY_CHIP_HYSTERESIS of it.
 */
export function shouldShowMemoryChip(
  bytes: number,
  baselineBytes: number | null,
  wasShown = false,
): boolean {
  if (!Number.isFinite(bytes) || bytes <= 0) return false;
  const level = memoryChipLevel(baselineBytes);
  return bytes >= (wasShown ? level * MEMORY_CHIP_HYSTERESIS : level);
}

/** Unchanged chip text — the styling and format the strip already had. */
export function formatMemoryChip(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

/** 메모리(5초 폴) + 시각(1초). 우측 클러스터 뒷부분(채널/벨 뒤). */
export function StatusClockTime() {
  const clockVisible = useStore((s) => s.titlebarClockVisible);
  const [time, setTime] = useState(() => new Date());
  const [memBytes, setMemBytes] = useState<number | null>(null);
  // Whether the chip is on screen. State, because it also picks the poll
  // cadence — there is no reason to ask main for a number every 5 s while
  // nothing is rendering it.
  const [memShown, setMemShown] = useState(false);
  // The footprint this window started with, and the last decision — refs
  // because the poll reads them, it does not render them.
  const memBaseline = useRef<number | null>(null);
  const memShownRef = useRef(false);
  memShownRef.current = memShown;

  // Update clock every second — only while the clock is actually shown. An
  // interval driving a hidden node is the dead gauge's running cost.
  useEffect(() => {
    if (!clockVisible) return;
    setTime(new Date());
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, [clockVisible]);

  // Update memory usage every 5 seconds. Reads the TOTAL app footprint from
  // main (app.getAppMetrics summed RSS across the whole Electron process tree)
  // instead of the renderer-only performance.memory.usedJSHeapSize, which
  // measured just this renderer's V8 JS heap (~10MB) and under-reported real
  // memory usage by roughly an order of magnitude.
  useEffect(() => {
    let cancelled = false;
    const update = () => {
      void window.electronAPI.system.getMemoryUsage().then((bytes) => {
        if (cancelled || typeof bytes !== 'number' || bytes <= 0) return;
        if (memBaseline.current === null) memBaseline.current = bytes;
        setMemBytes(bytes);
        setMemShown(shouldShowMemoryChip(bytes, memBaseline.current, memShownRef.current));
      }).catch(() => { /* main not ready / handler swapped — keep last value */ });
    };
    update();
    const timer = setInterval(update, memShown ? MEMORY_POLL_SHOWN_MS : MEMORY_POLL_HIDDEN_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [memShown]);

  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <>
      {memShown && memBytes !== null && (
        <span data-statusbar-memory>{formatMemoryChip(memBytes)}</span>
      )}
      {clockVisible && <span data-statusbar-clock>{timeStr}</span>}
    </>
  );
}
