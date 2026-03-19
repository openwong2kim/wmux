/**
 * useNotificationSound
 *
 * Web Audio API를 사용해 외부 파일 없이 짧은 비프음을 생성합니다.
 * notificationSoundEnabled 설정이 true일 때만 재생됩니다.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * 알림 타입별 소리 재생.
 * - agent: 두 음 상승 (성공 신호)
 * - error: 낮은 단음 (경고)
 * - warning: 중간 단음
 * - info: 기본 단음
 */
export function playNotificationSound(type: 'agent' | 'error' | 'warning' | 'info' = 'info'): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => undefined);
    }

    const now = ctx.currentTime;

    const configs: Array<{ freq: number; time: number; duration: number }> = [];

    switch (type) {
      case 'agent':
        // 두 음 상승: 솔 → 도
        configs.push({ freq: 784, time: now, duration: 0.1 });
        configs.push({ freq: 1047, time: now + 0.12, duration: 0.12 });
        break;
      case 'error':
        // 낮은 단음
        configs.push({ freq: 330, time: now, duration: 0.18 });
        break;
      case 'warning':
        // 중간 단음
        configs.push({ freq: 523, time: now, duration: 0.14 });
        break;
      default:
        // info: 짧은 고음
        configs.push({ freq: 880, time: now, duration: 0.1 });
        break;
    }

    for (const { freq, time, duration } of configs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);

      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(0.18, time + 0.01);
      gain.gain.linearRampToValueAtTime(0, time + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(time);
      osc.stop(time + duration + 0.01);
    }
  } catch {
    // AudioContext가 지원되지 않는 환경에서는 무시
  }
}
