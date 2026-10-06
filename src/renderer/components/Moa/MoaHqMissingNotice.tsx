import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';

/**
 * Recovery outside Settings: while Moa is on but its workspace is gone (a
 * session load or an archive restore left the HQ id dead), Moa brings it back
 * on its own, once per lost id — recreated under the same id, so its
 * conversation and settings come back with it (createMoaHq). Only when that
 * fails does one persistent toast say so and offer "Recreate Moa workspace".
 * It goes away as soon as the state recovers. Renders nothing itself.
 */
export default function MoaHqMissingNotice() {
  const t = useT();
  const missing = useStore((s) => !!s.moa?.config.enabled && s.moa.hq.state === 'hq-missing');
  const lostId = useStore((s) => (s.moa?.hq.state === 'hq-missing' ? s.moa.hq.workspaceId : null));
  // Bumped after a failed attempt so the notice comes back while still missing
  // (the toast's action dismisses it).
  const [attempt, setAttempt] = useState(0);
  // The lost id the automatic attempt already ran for. Once per loss: a
  // failing recreate must not loop, so the toast takes over after it.
  const autoTried = useRef<string | null>(null);
  const [autoFailed, setAutoFailed] = useState(false);

  useEffect(() => {
    // Recovered: forget the attempt, so a later loss of the same id (the
    // recreate reuses it) is retried rather than ignored in silence.
    if (!missing) {
      autoTried.current = null;
      return;
    }
    if (!lostId || autoTried.current === lostId) return;
    autoTried.current = lostId;
    setAutoFailed(false);
    void useStore.getState().createMoaHq().then((res) => {
      if (!res.ok) setAutoFailed(true);
    });
  }, [missing, lostId]);

  useEffect(() => {
    if (!missing || !autoFailed) return undefined;
    const st = useStore.getState();
    const id = st.pushToast({
      level: 'warn',
      message: t('moa.missing.title'),
      persist: true,
      action: {
        label: t('moa.missing.recreate'),
        onClick: () => {
          void useStore.getState().createMoaHq().then((res) => {
            if (res.ok) return;
            useStore.getState().pushToast({ level: 'error', message: t('moa.missing.failed') });
            setAttempt((n) => n + 1);
          });
        },
      },
    });
    return () => useStore.getState().dismissToast(id);
  }, [missing, autoFailed, attempt, t]);

  return null;
}
