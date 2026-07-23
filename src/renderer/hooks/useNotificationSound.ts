/**
 * useNotificationSound
 *
 * Generates short beeps via Web Audio API without external files.
 * Plays only when notificationSoundEnabled is true.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * Play sound by notification type.
 * - agent: two rising tones (success signal)
 * - error: low single tone (warning)
 * - warning: mid single tone
 * - info: default single tone
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
        // Two rising tones: G → C
        configs.push({ freq: 784, time: now, duration: 0.1 });
        configs.push({ freq: 1047, time: now + 0.12, duration: 0.12 });
        break;
      case 'error':
        // Low single tone
        configs.push({ freq: 330, time: now, duration: 0.18 });
        break;
      case 'warning':
        // Mid single tone
        configs.push({ freq: 523, time: now, duration: 0.14 });
        break;
      default:
        // info: short high tone
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
    // Ignore when AudioContext is not supported
  }
}
