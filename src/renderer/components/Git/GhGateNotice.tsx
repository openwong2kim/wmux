// What the Git page's Pull requests and Issues lists show instead of a list
// when gh cannot read one: not installed, not signed in, or another host /
// no remote. Fail-closed: the list never just stays empty.
import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { GH_LOGIN_COMMAND, openGithubLoginTab } from './connectGithub';

export interface GhGate {
  code: string;
  message: string;
  provider?: 'github' | 'gitlab';
}

export function GhGateNotice({ gate, onRecheck, fallback }: {
  gate: GhGate;
  /** Check again: a read that probes past main's gate cache. */
  onRecheck: () => void;
  /** The line for any other code (no remote, another host, an error). */
  fallback: string;
}): React.ReactElement {
  const t = useT();
  // Connect GitHub: the sign-in tab could not be opened, so the command is
  // shown to copy instead.
  const [loginFallback, setLoginFallback] = useState(false);
  const [copied, setCopied] = useState(false);
  // One sign-in tab per click: the button is off while one is opening.
  const [connecting, setConnecting] = useState(false);

  if (gate.provider === 'github' && gate.code === 'cli-missing') {
    // gh is not installed: signing in cannot work yet, so only the way to
    // get it and a re-check (which probes past the main-side cache).
    return (
      <div className="wmux-git-connect" data-git-install>
        <p className="wmux-git-connect-title">{t('git.connect.installTitle')}</p>
        <p className="wmux-git-connect-desc">{t('git.connect.installDesc')}</p>
        <div className="wmux-git-connect-actions">
          <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={onRecheck} data-git-connect-recheck>
            {t('git.connect.recheck')}
          </button>
        </div>
      </div>
    );
  }

  if (gate.provider === 'github' && gate.code === 'unauthenticated') {
    // Not connected: one way in. gh signs in through the browser and keeps
    // the credential itself; nothing is stored here.
    return (
      <div className="wmux-git-connect" data-git-connect>
        <p className="wmux-git-connect-title">{t('git.connect.title')}</p>
        <p className="wmux-git-connect-desc">{t('git.connect.desc')}</p>
        <div className="wmux-git-connect-actions">
          <button
            type="button"
            className={`wmux-git-primary ${FOCUS_RING}`}
            data-git-connect-button
            disabled={connecting}
            onClick={async () => {
              if (connecting) return;
              setConnecting(true);
              try {
                const ok = await openGithubLoginTab(t('git.connect.tabTitle'));
                if (!ok) setLoginFallback(true);
              } finally {
                setConnecting(false);
              }
            }}
          >
            {t('git.connect.button')}
          </button>
          <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={onRecheck} data-git-connect-recheck>
            {t('git.connect.recheck')}
          </button>
        </div>
        {loginFallback && (
          <div className="wmux-git-connect-cmd" data-git-connect-command>
            <code>{GH_LOGIN_COMMAND}</code>
            <button
              type="button"
              className={`wmux-git-button ${FOCUS_RING}`}
              onClick={() => {
                void window.clipboardAPI?.writeText?.(GH_LOGIN_COMMAND);
                setCopied(true);
              }}
            >
              {copied ? t('git.connect.copied') : t('git.connect.copy')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-3 text-[11px] text-[var(--text-muted)] break-words" {...tokenAttrs('textMuted', 'text')} data-git-gate={gate.code}>
      {fallback}
    </div>
  );
}
