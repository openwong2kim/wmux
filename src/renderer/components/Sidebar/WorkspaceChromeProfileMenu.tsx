import { useState, useEffect, useCallback } from 'react';
import { IconChevron } from '../icons';
import { useT } from '../../hooks/useT';

/**
 * Workspace right-click → Chrome profile submenu (Phase 2.5, BIND ONLY).
 *
 * Binds the workspace's chrome-backend automation to a named Chrome profile
 * (own user-data-dir = own logins), so workspace 1 can drive an account-A
 * Chrome while workspace 2 drives account B. Binding is the authorization —
 * agents cannot pick a profile themselves. Already-connected agent sessions
 * keep their current browser; new page resolutions use the new binding.
 * Structure cloned from WorkspaceAccountMenu (same bind-only shape).
 */
export default function WorkspaceChromeProfileMenu({
  workspaceId,
  flipLeft,
}: {
  workspaceId: string;
  flipLeft: boolean;
}): React.ReactElement | null {
  const t = useT();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [bound, setBound] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const reload = useCallback(() => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api) return;
    void api.list().then((res) => {
      setProfiles(res.profiles);
      setBound(res.bindings[workspaceId]);
    }).catch(() => { /* menu stays with stale rows */ });
  }, [workspaceId]);

  useEffect(() => { reload(); }, [reload]);

  const bind = useCallback((profileName: string | null) => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api) return;
    void api.bind(workspaceId, profileName).then(reload).catch(() => { /* best-effort */ });
  }, [workspaceId, reload]);

  const bindLive = useCallback(() => {
    // Honest one-line grant: binding live = this workspace's agent gets the
    // user's whole live browser (Chrome adds its own per-connection dialog).
    if (!window.confirm(t('chromeProfiles.liveConfirm'))) return;
    bind('live');
  }, [bind, t]);

  const createAndBind = useCallback(() => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api) return;
    const name = window.prompt(t('chromeProfiles.newPrompt'))?.trim();
    if (!name) return;
    void api.create(name).then((res) => {
      if (res.ok) bind(name);
      else if (res.error) window.alert(res.error);
    }).catch(() => { /* best-effort */ });
  }, [bind, t]);

  // Hide on older builds without the preload surface.
  if (!window.electronAPI?.browser?.chromeProfiles) return null;

  const submenuPos = flipLeft ? 'right-full mr-0.5' : 'left-full ml-0.5';

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
        style={{ color: 'var(--text-main)' }}
      >
        <span>{t('chromeProfiles.menuLabel')}</span>
        {bound && (
          <span className="text-[10px] text-[var(--accent-amber)] truncate max-w-[90px]">{bound}</span>
        )}
        <span className="ml-auto text-[var(--text-muted)]"><IconChevron /></span>
      </button>
      {open && (
        <div
          className={`absolute top-0 ${submenuPos} min-w-[200px] max-w-[300px] py-1 rounded-[7px] shadow-xl sidebar-popover-enter`}
          style={{ background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--bg-overlay) 70%, transparent)' }}
        >
          {/* Reserved: attach to the user's own live Chrome (Phase 3). */}
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
            style={{ color: 'var(--text-main)' }}
            onClick={bindLive}
            title={t('chromeProfiles.liveDesc')}
          >
            <span className="w-3 text-[var(--accent-amber)]">{bound === 'live' ? '●' : ''}</span>
            <span className="truncate flex-1">{t('chromeProfiles.liveProfile')}</span>
          </button>
          {profiles.map((name) => {
            const isBound = name === 'default' ? bound === undefined || bound === 'default' : bound === name;
            return (
              <button
                key={name}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
                style={{ color: 'var(--text-main)' }}
                onClick={() => bind(name === 'default' ? null : name)}
              >
                <span className="w-3 text-[var(--accent-amber)]">{isBound ? '●' : ''}</span>
                <span className="truncate flex-1">
                  {name === 'default' ? t('chromeProfiles.defaultProfile') : name}
                </span>
              </button>
            );
          })}
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)] border-t border-[var(--bg-overlay)] mt-1 pt-2"
            style={{ color: 'var(--text-muted)' }}
            onClick={createAndBind}
          >
            <span className="w-3" />
            <span>{t('chromeProfiles.newProfile')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
