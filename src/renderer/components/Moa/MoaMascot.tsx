import { useId, type ReactElement } from 'react';
import type { MoaMascotState } from '../../../shared/moa';
import { useStore } from '../../stores';
import { usePrefersReducedMotion } from '../ui/MediaPreview';
import './moa.css';

export interface MoaMascotProps {
  state: MoaMascotState;
  /** Rendered size in px. 20 and 28 draw only the body and the face. */
  size: number;
  /** Accessible name; omit for a decorative mascot. */
  label?: string;
}

/** At or under this size only the body and the >w< face are drawn. */
export const MOA_MASCOT_SMALL_MAX = 28;

/** True when Moa should hold still: the OS asks for reduced motion, or Moa's
 *  own Reduce motion setting is on. */
export function useMoaReducedMotion(): boolean {
  const os = usePrefersReducedMotion();
  const setting = useStore((s) => s.moa?.config.reduceMotion === true);
  return os || setting;
}

// The approved art's palette (Mascot6, soft 3D). Character colours are art, not
// chrome state, so they stay fixed across themes; the "needs you" mark and the
// working dots take the theme's tokens.
const INK = '#2A2547';
const EYE = '#2B2440';
const TUFT = '#8E9BEF';
const RIM = '#5F69C4';

const BODY_D = 'M60 34 C86 34 98 54 98 76 C98 96 84 104 60 104 C36 104 22 96 22 76 C22 54 34 34 60 34 Z';
const RIM_D = 'M24 84 C28 98 40 103 60 103 C80 103 92 98 96 84 C90 96 78 100 60 100 C42 100 30 96 24 84 Z';
const TUFT_CURL_D = 'M60 36 C58 26 64 22 66 18';
const ARM_LEFT_D = 'M28 82 C20 82 18 92 26 94 C30 95 32 90 32 86 Z';
const ARM_RIGHT_D = 'M92 82 C100 82 102 92 94 94 C90 95 88 90 88 86 Z';
const ARM_LEFT_UP_D = 'M30 78 C24 68 16 62 12 64 C9 68 16 76 26 84 Z';
const ARM_RIGHT_UP_D = 'M90 78 C96 68 104 62 108 64 C111 68 104 76 94 84 Z';

const ink = (width = 3.2) => ({
  fill: 'none',
  stroke: INK,
  strokeWidth: width,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/**
 * Moa, the HQ main bot's character (approved art: soft 3D, four states).
 *
 * - idle: squishes and blinks, the tuft sways;
 * - working: eyes closed, hands together, three dots;
 * - needs-you: round eyes, one hand up, a small hop and a "!" mark;
 * - done: >▽< with both hands up and two hearts.
 *
 * At {@link MOA_MASCOT_SMALL_MAX}px and under (the titlebar icon) only the body
 * and the >w< face are drawn: limbs, tuft and effects would be noise at that
 * size. Motion stops under the OS reduced-motion preference and under Moa's
 * Reduce motion setting. Gradient ids are per instance (useId), so several
 * mascots on screen never share one another's paint servers.
 */
export function MoaMascot({ state, size, label }: MoaMascotProps) {
  const reduce = useMoaReducedMotion();
  const uid = `moa${useId().replace(/[^\w-]/g, '')}`;
  const small = size <= MOA_MASCOT_SMALL_MAX;
  const anim = (cls: string) => (reduce ? undefined : cls);
  const id = { body: `${uid}-body`, nub: `${uid}-nub`, blush: `${uid}-blush`, shadow: `${uid}-shadow` };
  const url = (k: keyof typeof id) => `url(#${id[k]})`;

  const defs = (
    <defs>
      <radialGradient id={id.body} cx="38%" cy="30%" r="80%">
        <stop offset="0%" stopColor="#E4E9FF" />
        <stop offset="38%" stopColor="#BCC8FF" />
        <stop offset="78%" stopColor="#8F9CF0" />
        <stop offset="100%" stopColor="#6E79D6" />
      </radialGradient>
      <radialGradient id={id.blush} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#FF8FAE" stopOpacity={0.9} />
        <stop offset="100%" stopColor="#FF8FAE" stopOpacity={0} />
      </radialGradient>
      {!small && (
        <>
          <radialGradient id={id.nub} cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#DDE3FF" />
            <stop offset="100%" stopColor="#8794E8" />
          </radialGradient>
          <radialGradient id={id.shadow} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#000" stopOpacity={0.55} />
            <stop offset="100%" stopColor="#000" stopOpacity={0} />
          </radialGradient>
        </>
      )}
    </defs>
  );

  const common = {
    width: size,
    height: size,
    className: 'moa-mascot',
    'data-moa-mascot': state,
    'data-moa-size': small ? 'small' : 'full',
    'data-motion': reduce ? 'reduced' : 'full',
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    focusable: 'false' as const,
  };

  if (small) {
    // Body + >w< face only; viewBox cropped to the body so it fills the icon.
    return (
      <svg {...common} viewBox="18 30 84 78" style={{ overflow: 'visible' }}>
        {defs}
        <g className={anim('moa-squish')}>
          <path d={BODY_D} fill={url('body')} />
          <ellipse cx="44" cy="48" rx="10" ry="5.5" transform="rotate(-25 44 48)" fill="#fff" opacity={0.8} />
          <path d="M43 62 L50 66 L43 70" {...ink(4)} />
          <path d="M77 62 L70 66 L77 70" {...ink(4)} />
          <ellipse cx="39" cy="76" rx="9" ry="6" fill={url('blush')} />
          <ellipse cx="81" cy="76" rx="9" ry="6" fill={url('blush')} />
          <path d="M54 75 L57 79 L60 76 L63 79 L66 75" {...ink(3.2)} />
        </g>
      </svg>
    );
  }

  const shell = (
    <>
      <path d={BODY_D} fill={url('body')} />
      <path d={RIM_D} fill={RIM} opacity={0.35} />
      <ellipse cx="44" cy="48" rx="10" ry="5.5" transform="rotate(-25 44 48)" fill="#fff" opacity={0.85} style={{ filter: 'blur(1.2px)' }} />
      <circle cx="56" cy="43" r="2" fill="#fff" opacity={0.9} />
      <path d="M92 62 C96 74 94 88 86 96" fill="none" stroke="#fff" strokeOpacity={0.35} strokeWidth={2.5} strokeLinecap="round" />
    </>
  );
  const tuftCurl = (
    <g className={anim('moa-tuft')}>
      <path d={TUFT_CURL_D} fill="none" stroke={TUFT} strokeWidth={4} strokeLinecap="round" />
    </g>
  );
  const cheeks = (cy: number, rx = 9, ry = 6) => (
    <>
      <ellipse cx="40" cy={cy} rx={rx} ry={ry} fill={url('blush')} />
      <ellipse cx="80" cy={cy} rx={rx} ry={ry} fill={url('blush')} />
    </>
  );

  let figure: ReactElement;
  switch (state) {
    case 'working':
      figure = (
        <>
          <ellipse className={anim('moa-shadow')} cx="60" cy="107" rx="36" ry="7" fill={url('shadow')} />
          <g className={anim('moa-squish')}>
            {tuftCurl}
            {shell}
            <path d="M43 66 Q47 63 51 66" {...ink()} />
            <path d="M69 66 Q73 63 77 66" {...ink()} />
            {cheeks(76)}
            <path d="M55 76 L57.5 79 L60 76.5 L62.5 79 L65 76" {...ink(2.4)} />
            <path d="M44 86 C50 92 58 92 60 88 C62 92 70 92 76 86 C70 96 50 96 44 86 Z" fill={url('nub')} />
          </g>
          <g className={anim('moa-dots')} fill="var(--text-muted, #C2BDC9)" data-moa-effect="dots">
            <circle cx="96" cy="30" r="3" />
            <circle cx="105" cy="23" r="3" />
            <circle cx="114" cy="16" r="3" />
          </g>
        </>
      );
      break;
    case 'needs-you':
      figure = (
        <>
          <ellipse cx="60" cy="107" rx="34" ry="7" fill={url('shadow')} />
          <g className={anim('moa-hop')}>
            <path d="M60 36 C60 26 60 22 60 16" fill="none" stroke={TUFT} strokeWidth={4} strokeLinecap="round" />
            <path d={ARM_LEFT_D} fill={url('nub')} />
            <g className={anim('moa-raise')}>
              <path d={ARM_RIGHT_UP_D} fill={url('nub')} />
            </g>
            {shell}
            <ellipse cx="46" cy="66" rx="4" ry="5" fill={EYE} />
            <ellipse cx="74" cy="66" rx="4" ry="5" fill={EYE} />
            <circle cx="47.3" cy="64.2" r="1.5" fill="#fff" />
            <circle cx="75.3" cy="64.2" r="1.5" fill="#fff" />
            {cheeks(77)}
            <ellipse cx="60" cy="78" rx="3.5" ry="3" fill={EYE} />
          </g>
          <g className={anim('moa-bang')} data-moa-effect="bang">
            <circle cx="104" cy="34" r="11" fill="var(--accent-yellow, #F2B25C)" />
            <path d="M104 28 L104 36" stroke={EYE} strokeWidth={3} strokeLinecap="round" />
            <circle cx="104" cy="40.5" r="1.7" fill={EYE} />
          </g>
        </>
      );
      break;
    case 'done':
      figure = (
        <>
          <ellipse className={anim('moa-shadow')} cx="60" cy="107" rx="36" ry="7" fill={url('shadow')} />
          <g className={anim('moa-squish-fast')}>
            {tuftCurl}
            <g className={anim('moa-wave-l')}>
              <path d={ARM_LEFT_UP_D} fill={url('nub')} />
            </g>
            <g className={anim('moa-wave-r')}>
              <path d={ARM_RIGHT_UP_D} fill={url('nub')} />
            </g>
            {shell}
            <path d="M43 62 L50 66 L43 70" {...ink()} />
            <path d="M77 62 L70 66 L77 70" {...ink()} />
            {cheeks(76, 10, 6.5)}
            <path d="M52 73 Q60 73 68 73 Q66 84 60 84 Q54 84 52 73 Z" fill={EYE} />
            <path d="M55 80 Q60 77 65 80 Q63 83.5 60 83.5 Q57 83.5 55 80 Z" fill="#FF8FA3" />
          </g>
          <path
            className={anim('moa-heart')}
            data-moa-effect="heart"
            d="M100 34 C100 30 106 30 106 34 C106 30 112 30 112 34 C112 39 106 42 106 44 C106 42 100 39 100 34 Z"
            fill="#FF9DB5"
          />
          <path
            className={reduce ? undefined : 'moa-heart moa-heart-late'}
            data-moa-effect="heart"
            d="M10 42 C10 39 14 39 14 42 C14 39 18 39 18 42 C18 46 14 48 14 50 C14 48 10 46 10 42 Z"
            fill="#FF9DB5"
          />
        </>
      );
      break;
    case 'idle':
    default:
      figure = (
        <>
          <ellipse className={anim('moa-shadow')} cx="60" cy="107" rx="36" ry="7" fill={url('shadow')} />
          <g className={anim('moa-squish')}>
            {tuftCurl}
            <path d={ARM_LEFT_D} fill={url('nub')} />
            <path d={ARM_RIGHT_D} fill={url('nub')} />
            {shell}
            <g className={anim('moa-blink')}>
              <path d="M44 62 L50 66 L44 70" {...ink()} />
              <path d="M76 62 L70 66 L76 70" {...ink()} />
            </g>
            {cheeks(76)}
            <path d="M54 74 L57 78 L60 75 L63 78 L66 74" {...ink(2.6)} />
          </g>
        </>
      );
  }

  return (
    <svg {...common} viewBox="0 0 120 114">
      {defs}
      {figure}
    </svg>
  );
}
