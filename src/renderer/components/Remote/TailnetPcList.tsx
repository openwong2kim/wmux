import Button from '../ui/Button';
import { IconComputer } from '../icons';
import type { A2aDiscoverPc } from '../../../shared/rpc';

// ─── Connect a PC › Tailscale › PCs found on your tailnet ────────────────────
//
// One hairline container, a row per discoverable PC: the device as Tailscale
// names it, then its OS, its wmux version (and the name its wmux answered
// with, when that differs) and its owner's login. A PC this one already
// joined shows "Connected" instead of Connect; one that speaks another
// protocol or missed the last two scans is greyed with why. The first
// connectable row carries the dialog's one primary.

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Tailscale's OS names (`windows`, `macOS`, `linux`) as people write them. */
export function osLabel(os: string): string {
  const lower = os.toLowerCase();
  if (lower === 'windows') return 'Windows';
  if (lower === 'macos') return 'macOS';
  if (lower === 'linux') return 'Linux';
  return os;
}

/** A row's second line. */
export function pcMeta(pc: A2aDiscoverPc, t: T): string {
  const os = osLabel(pc.os);
  if (pc.state === 'version-mismatch') return [os, `wmux ${pc.version}`, t('remotePage.discover.versionMismatch')].join(' · ');
  if (pc.state === 'stale') return [os, t('remotePage.discover.stale')].join(' · ');
  if (pc.alreadyConnected) return [os, t('remotePage.discover.alreadyConnected')].join(' · ');
  // The name is what its wmux reported; the title is Tailscale's, so it is added only when they differ.
  const named = pc.name && pc.name.toLowerCase() !== pc.device.toLowerCase() ? [pc.name] : [];
  return [os, ...named, `wmux ${pc.version}`, pc.login].join(' · ');
}

export interface TailnetPcListProps {
  pcs: A2aDiscoverPc[];
  onConnect: (pc: A2aDiscoverPc) => void;
  /** The first connectable row may be the dialog's primary (false while another action holds it). */
  primary: boolean;
  t: T;
}

export function TailnetPcList({ pcs, onConnect, primary, t }: TailnetPcListProps) {
  const connectable = (pc: A2aDiscoverPc) => pc.state === 'ready' && !pc.alreadyConnected;
  const first = primary ? pcs.find(connectable) : undefined;
  return (
    <ul className="wmux-remote-list" aria-label={t('remotePage.discover.pcsTitle')} data-testid="discover-pcs">
      {pcs.map((pc) => {
        const greyed = pc.state !== 'ready';
        return (
          <li key={pc.ip} className="flex items-center gap-3 px-3.5 py-3" data-discover-pc={pc.ip} data-state={pc.state}>
            <span className="text-[var(--text-sub)]" aria-hidden="true"><IconComputer size={16} /></span>
            <div className="flex flex-col gap-0.5 flex-1 min-w-0">
              <span className={`text-[13px] truncate ${greyed ? 'text-[var(--text-muted)]' : 'text-[var(--text-main)]'}`}>{pc.device}</span>
              <span className={`text-[11px] truncate ${greyed ? 'text-[var(--text-muted)]' : 'text-[var(--text-sub)]'}`} data-testid="discover-pc-meta">{pcMeta(pc, t)}</span>
            </div>
            {connectable(pc) ? (
              <Button
                variant={pc === first ? 'primary' : 'secondary'}
                size="md"
                onClick={() => onConnect(pc)}
                data-testid="discover-connect"
              >
                {t('remotePage.discover.connect')}
              </Button>
            ) : pc.state === 'ready' ? (
              <span className="text-[11px] text-[var(--text-sub)]">{t('remotePage.discover.connected')}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
