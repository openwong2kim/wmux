import { useT } from '../../hooks/useT';

/** The keys PairingScope renders, in order. */
export const PAIRING_SCOPE_KEYS = ['remote.scope.read', 'remote.scope.viewOnly', 'remote.scope.input'] as const;

/**
 * What a paired device can reach on this computer, said where pairings are
 * managed (Paired devices). It matches the server: every workspace, current
 * and later, is readable and searchable; view only still answers single-key
 * screen prompts; typing also covers opening and closing sessions and
 * answering approvals.
 */
export default function PairingScope({ className = '' }: { className?: string }) {
  const t = useT();
  return (
    <div className={`text-[11px] leading-4 text-[var(--text-sub)] ${className}`} data-pairing-scope>
      {PAIRING_SCOPE_KEYS.map((key) => <p key={key} className="m-0">{t(key)}</p>)}
    </div>
  );
}
