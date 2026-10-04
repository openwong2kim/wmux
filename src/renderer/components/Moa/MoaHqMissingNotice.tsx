import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';

/**
 * Recovery outside Settings: while Moa is on but its workspace is gone (a
 * session load or an archive restore left the HQ id dead), one persistent
 * toast says so and offers "Recreate Moa workspace". It goes away as soon as
 * the state recovers. Renders nothing itself.
 */
export default function MoaHqMissingNotice() {
  const t = useT();
  const missing = useStore((s) => !!s.moa?.config.enabled && s.moa.hq.state === 'hq-missing');
  // Bumped after a failed attempt so the notice comes back while still missing
  // (the toast's action dismisses it).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!missing) return undefined;
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
  }, [missing, attempt, t]);

  return null;
}
