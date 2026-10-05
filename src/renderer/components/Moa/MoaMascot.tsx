import { useId, useState } from 'react';
import type { MoaMascotState } from '../../../shared/moa';
import { useStore } from '../../stores';
import { usePrefersReducedMotion } from '../ui/MediaPreview';
import './moa.css';

export interface MoaMascotProps {
  state: MoaMascotState;
  /** Rendered size in px. 20 and 28 draw only the body and the state-specific face. */
  size: number;
  /** Accessible name; omit for a decorative mascot. */
  label?: string;
}

/** At or under this size only the body and the face are drawn. */
export const MOA_MASCOT_SMALL_MAX = 28;

/** True when Moa should hold still: the OS asks for reduced motion, or Moa's
 *  own Reduce motion setting is on. */
export function useMoaReducedMotion(): boolean {
  const os = usePrefersReducedMotion();
  const setting = useStore((s) => s.moa?.config.reduceMotion === true);
  return os || setting;
}

// SPDX-License-Identifier: MIT — original wmux SVG artwork and interaction.
const INK = '#2A2547';

/** Original lavender companion. Uses only the four states supplied by wmux. */
export function MoaMascot({ state, size, label }: MoaMascotProps) {
  const reduce = useMoaReducedMotion();
  const uid = `moa${useId().replace(/[^\w-]/g, '')}`;
  const small = size <= MOA_MASCOT_SMALL_MAX;
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const anim = (name: string) => reduce ? undefined : name;
  const eyes = state === 'working'
    ? <><path d="M40 64 Q46 59 52 64" /><path d="M68 64 Q74 59 80 64" /></>
    : state === 'done'
      ? <><path d="M40 64 Q46 54 52 64" /><path d="M68 64 Q74 54 80 64" /></>
      : <g className={anim('moa-blink')} stroke="none">
          <ellipse cx="46" cy="64" rx="7" ry="9" fill="white" />
          <ellipse cx="74" cy="64" rx="7" ry="9" fill="white" />
          <g data-moa-gaze="" style={{ transform: `translate(${reduce ? 0 : gaze.x}px, ${reduce ? 0 : gaze.y}px)`, transition: reduce ? 'none' : 'transform 180ms ease-out' }}>
            <ellipse cx="46" cy="65" rx="4" ry="6" fill={INK} />
            <ellipse cx="74" cy="65" rx="4" ry="6" fill={INK} />
            <circle cx="47" cy="63" r="1.5" fill="white" />
            <circle cx="75" cy="63" r="1.5" fill="white" />
          </g>
        </g>;
  return <svg width={size} height={size} viewBox={small ? '20 32 80 74' : '0 0 120 114'}
    className="moa-mascot" data-moa-mascot={state} data-moa-size={small ? 'small' : 'full'}
    data-motion={reduce ? 'reduced' : 'full'} role={label ? 'img' : undefined}
    aria-label={label} aria-hidden={label ? undefined : true} focusable="false"
    onPointerMove={(event) => {
      if (reduce) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const clamp = (n: number) => Math.max(-1, Math.min(1, n));
      setGaze({ x: clamp((event.clientX - box.left) / box.width * 2 - 1) * 2,
        y: clamp((event.clientY - box.top) / box.height * 2 - 1) * 1.5 });
    }} onPointerLeave={() => setGaze({ x: 0, y: 0 })}>
    <defs><radialGradient id={`${uid}-body`} cx="32%" cy="24%" r="90%">
      <stop offset="0" stopColor="#EDF0FF" /><stop offset=".5" stopColor="#BAC5FF" />
      <stop offset="1" stopColor="#7E8ADC" /></radialGradient></defs>
    {!small && <ellipse cx="60" cy="106" rx="30" ry="4" fill={INK} opacity=".15" />}
    <g className={anim(state === 'needs-you' ? 'moa-hop' : state === 'done' ? 'moa-squish-fast' : 'moa-squish')}>
      {!small && <>
        <path className={anim('moa-tuft')} d="M58 36 C51 22 71 28 67 16" fill="none" stroke="#8E9BEF" strokeWidth="4" strokeLinecap="round" />
        <path className={anim(state === 'done' ? 'moa-wave-l' : '')} d={state === 'done' ? 'M31 79 Q10 60 13 72 Q18 84 32 88' : 'M30 80 Q14 81 24 92 L34 91'} fill="#A5B2F7" />
        <path className={anim(state === 'done' ? 'moa-wave-r' : state === 'needs-you' ? 'moa-raise' : '')} d={state === 'done' || state === 'needs-you' ? 'M89 79 Q110 60 107 72 Q102 84 88 88' : 'M90 80 Q106 81 96 92 L86 91'} fill="#A5B2F7" />
      </>}
      <path d="M60 35 C83 35 96 49 97 73 C99 96 82 103 60 103 C38 103 21 96 23 73 C24 49 37 35 60 35 Z" fill={`url(#${uid}-body)`} stroke="#8793DE" strokeWidth="1.5" />
      <path d="M35 51 Q42 41 52 42" stroke="white" strokeOpacity=".7" strokeWidth="4" strokeLinecap="round" fill="none" />
      <ellipse cx="37" cy="76" rx="7" ry="4" fill="#F59CB6" opacity=".65" />
      <ellipse cx="83" cy="76" rx="7" ry="4" fill="#F59CB6" opacity=".65" />
      <g fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">{eyes}
        {state === 'needs-you' ? <ellipse cx="60" cy="79" rx="3" ry="4" fill={INK} stroke="none" />
          : state === 'done' ? <path d="M53 76 Q60 89 67 76 Z" fill={INK} />
            : <path d="M54 77 Q57 82 60 78 Q63 82 66 77" />}
      </g>
    </g>
    {!small && state === 'working' && <g className={anim('moa-dots')} data-moa-effect="dots" fill="var(--text-muted)"><circle cx="96" cy="30" r="3" /><circle cx="105" cy="23" r="3" /><circle cx="114" cy="16" r="3" /></g>}
    {!small && state === 'needs-you' && <g data-moa-effect="bang"><circle cx="104" cy="31" r="10" fill="var(--attention)" /><path d="M104 25 V32 M104 37 V37.1" stroke={INK} strokeWidth="3" strokeLinecap="round" /></g>}
    {!small && state === 'done' && [12, 102].map((x) => <path key={x} className={anim('moa-heart')} data-moa-effect="heart" d={`M${x} 31 c-7 -8 -12 4 0 11 c12 -7 7 -19 0 -11`} fill="#F59CB6" />)}
  </svg>;
}
