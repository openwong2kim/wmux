import { useState, useEffect, useCallback, useRef } from 'react';
import { IconChevron } from '../icons';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';

/**
 * Workspace right-click → Chrome profile submenu (Phase 2.5, BIND ONLY).
 *
 * Binds the workspace's chrome-backend automation to a named Chrome profile
 * (own user-data-dir = own logins), so workspace 1 can drive an account-A
 * Chrome while workspace 2 drives account B. Binding is the authorization —
 * agents cannot pick a profile themselves. Already-connected agent sessions
 * keep their current browser; new page resolutions use the new binding.
 * Structure cloned from WorkspaceAccountMenu (same bind-only shape).
 *
 * Backend gate: a binding is only ever consulted on the 'chrome' path
 * (requireChrome → chromeRegistry.forWorkspace in browser.rpc.ts), so under
 * 'builtin' or 'external' the whole submenu is inert — it would offer a
 * profile choice that changes nothing observable. Hide it there, the same way
 * WorkspaceAccountMenu hides itself when no accounts are registered. The
 * backend mirror is read synchronously at store-module load
 * (readInitialBrowserBackend), so this is correct on first render and needs
 * no hydration wait.
 */
export default function WorkspaceChromeProfileMenu({
  workspaceId,
  flipLeft,
}: {
  workspaceId: string;
  flipLeft: boolean;
}): React.ReactElement | null {
  const t = useT();
  const browserBackend = useStore((s) => s.browserBackend);
  const isChromeBackend = browserBackend === 'chrome';
  const [profiles, setProfiles] = useState<string[]>([]);
  const [bound, setBound] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  // Inline "new profile" form (replaces window.prompt — see createProfile below).
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Prevent double submit: React state is async, so a second Enter/click in the
  // same tick sees a stale `creating` and slips through — lock it with a ref.
  const creatingRef = useRef(false);

  const reload = useCallback(() => {
    const api = window.electronAPI?.browser?.chromeProfiles;
    // Skip the boot IPC entirely off the chrome backend: this effect runs once
    // per rendered workspace row, and none of those rows will show the menu.
    if (!api || !isChromeBackend) return;
    void api.list().then((res) => {
      setProfiles(res.profiles);
      setBound(res.bindings[workspaceId]);
    }).catch(() => { /* menu stays with stale rows */ });
  }, [workspaceId, isChromeBackend]);

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

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setNewName('');
    setNewError(null);
  }, []);

  // Drop any half-typed profile name when the submenu itself goes away, so
  // re-opening it never resurrects a stale name or a stale error.
  useEffect(() => {
    if (!open) closeForm();
  }, [open, closeForm]);

  /**
   * Create the profile, then bind it — same create→bind flow the old
   * `createAndBind` had, minus `window.prompt`. Electron's renderer has no
   * prompt polyfill and the call itself throws (measured in DiffPanel's ask
   * flow), so the "New profile…" row was dead; the name now comes from the
   * inline form. Failures are common by design — main rejects bad names, the
   * reserved 'live', and the 20-profile cap — so the error is shown in the
   * form with the typed name intact instead of an (equally unavailable)
   * `window.alert`.
   */
  const createProfile = useCallback(async () => {
    if (creatingRef.current) return;
    const api = window.electronAPI?.browser?.chromeProfiles;
    if (!api) return;
    const name = newName.trim();
    if (!name) return;
    creatingRef.current = true;
    setCreating(true);
    setNewError(null);
    try {
      const res = await api.create(name);
      if (res.ok) {
        bind(name);
        setFormOpen(false);
        setNewName('');
      } else {
        setNewError(res.error || t('chromeProfiles.newFailed'));
      }
    } catch {
      setNewError(t('chromeProfiles.newFailed'));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [newName, bind, t]);

  // Hide on older builds without the preload surface.
  if (!window.electronAPI?.browser?.chromeProfiles) return null;
  // Hide when the backend cannot act on a binding (see the gate note above).
  if (!isChromeBackend) return null;

  const submenuPos = flipLeft ? 'right-full mr-0.5' : 'left-full ml-0.5';

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        // Hover-close would eat a half-typed profile name the moment the
        // pointer drifted off the submenu — keep it open while the form is up.
        if (formOpen) return;
        setOpen(false);
      }}
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
          <div className="border-t border-[var(--bg-overlay)] mt-1 pt-1">
            {formOpen ? (
              <div className="px-3 py-1.5" data-testid="chrome-profile-new-form">
                <input
                  autoFocus
                  className="ui-input text-xs"
                  value={newName}
                  placeholder={t('chromeProfiles.newPlaceholder')}
                  spellCheck={false}
                  disabled={creating}
                  data-testid="chrome-profile-new-input"
                  onChange={(e) => setNewName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // An Enter that closes an IME composition (ko/ja/zh) commits
                    // the text, it does not submit the form — guard on both
                    // isComposing and the legacy keyCode 229.
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                      e.preventDefault();
                      void createProfile();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      closeForm();
                    }
                  }}
                />
                {newError && (
                  <div
                    className="mt-1 text-[10px] text-[var(--accent-red)]"
                    data-testid="chrome-profile-new-error"
                  >
                    {newError}
                  </div>
                )}
                <div className="flex items-center gap-1.5 mt-1.5">
                  <button
                    className="px-2 py-0.5 rounded-[5px] text-[11px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={creating || newName.trim().length === 0}
                    data-testid="chrome-profile-new-submit"
                    onClick={() => void createProfile()}
                  >
                    {t('chromeProfiles.newCreate')}
                  </button>
                  <button
                    className="px-2 py-0.5 rounded-[5px] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-main)]"
                    data-testid="chrome-profile-new-cancel"
                    onClick={closeForm}
                  >
                    {t('chromeProfiles.newCancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-[var(--bg-overlay)]"
                style={{ color: 'var(--text-muted)' }}
                data-testid="chrome-profile-new-open"
                onClick={() => { setNewError(null); setFormOpen(true); }}
              >
                <span className="w-3" />
                <span>{t('chromeProfiles.newProfile')}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
