import { useState, useEffect } from 'react';
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

/** 메모리(5초 폴) + 시각(1초). 우측 클러스터 뒷부분(채널/벨 뒤). */
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
