import { Icon } from '../icons';

/** An arrow on the app's 14px icon grid (icons.tsx has none yet): up for Send, down for jump to latest. */
export function ArrowIcon({ dir, size = 14 }: { dir: 'up' | 'down'; size?: number }) {
  return <Icon size={size}>{dir === 'up' ? <path d="M7 11.5v-9M3 6.5l4-4 4 4" /> : <path d="M7 2.5v9M3 7.5l4 4 4-4" />}</Icon>;
}
