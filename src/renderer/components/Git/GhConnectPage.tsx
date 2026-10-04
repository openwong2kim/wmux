// The Git page's connect card, shown instead of the lists when gh is not
// signed in or not installed. Connect GitHub runs `gh auth login --web` in
// main (no terminal), shows the one-time code in a dialog and opens GitHub's
// device page; gh keeps the credential and wmux stores no token. When gh's
// output cannot be read, the terminal-tab sign-in is offered instead.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import { GH_DEVICE_URL, type GhLoginEvent } from '../../../shared/ghDeviceLogin';
import { GH_LOGIN_COMMAND, openGithubLoginTab } from './connectGithub';

const CLI_SITE = 'https://cli.github.com';
const LINUX_GUIDE = 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md';

type Flow =
  | { phase: 'starting' }
  | { phase: 'code'; code: string }
  | { phase: 'timeout' }
  | { phase: 'failed'; message: string; fallback: boolean };

export interface GhConnectPageProps {
  /** Which gate the page is answering (from useGhAuthGate). */
  gate: 'unauthenticated' | 'cli-missing';
  /** Check again: re-read the gate past main's cache. */
  onRecheck: () => void;
  /** The sign-in finished; reload what the page shows. */
  onConnected: () => void;
}

function openExternal(url: string): void {
  void window.electronAPI?.shell?.openExternal?.(url)?.catch?.(() => undefined);
}

/** A command in mono with a Copy button. */
function CopyLine({ text, testId }: { text: string; testId: string }): React.ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="wmux-gh-connect-cmd" data-testid={testId}>
      <code>{text}</code>
      <button
        type="button"
        className={`wmux-git-button ${FOCUS_RING}`}
        onClick={async () => {
          try {
            await window.clipboardAPI?.writeText(text);
            setCopied(true);
          } catch { /* the command stays on screen to copy by hand */ }
        }}
      >
        {copied ? t('git.connect.copied') : t('git.connect.copy')}
      </button>
    </div>
  );
}

export function GhConnectPage({ gate, onRecheck, onConnected }: GhConnectPageProps): React.ReactElement {
  const t = useT();
  const [flow, setFlow] = useState<Flow | null>(null);
  // gh vanished between the gate read and Connect.
  const [missing, setMissing] = useState(false);
  // The terminal tab could not be opened: show the command to copy.
  const [showCommand, setShowCommand] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  // Subscribed for the page's lifetime, so no event is lost to dialog timing.
  useEffect(() => {
    const off = window.electronAPI?.github?.onLoginEvent?.((e: GhLoginEvent) => {
      if (e.kind === 'done') {
        setFlow(null);
        onConnectedRef.current();
        return;
      }
      // Only a sign-in this page started (the dialog is open) is shown.
      setFlow((cur) => {
        if (!cur) return cur;
        if (e.kind === 'code') return { phase: 'code', code: e.code };
        if (e.kind === 'timeout') return { phase: 'timeout' };
        if (e.kind === 'failed') return { phase: 'failed', message: e.message, fallback: e.fallback };
        return cur;
      });
    });
    return () => { off?.(); };
  }, []);

  const connect = async () => {
    setCodeCopied(false);
    setShowCommand(false);
    setFlow({ phase: 'starting' });
    let res: Awaited<ReturnType<Window['electronAPI']['github']['loginStart']>>;
    try {
      res = await window.electronAPI.github.loginStart();
    } catch (err) {
      res = { ok: false, message: err instanceof Error ? err.message : String(err), fallback: true };
    }
    if (res.ok) return;
    if (!res.fallback) {
      setFlow(null);
      setMissing(true);
      return;
    }
    setFlow({ phase: 'failed', message: res.message, fallback: true });
  };

  const cancel = () => {
    if (flow && (flow.phase === 'starting' || flow.phase === 'code')) {
      void window.electronAPI?.github?.loginCancel?.()?.catch?.(() => undefined);
    }
    setFlow(null);
  };

  const copyAndOpen = async (code: string) => {
    try {
      await window.clipboardAPI?.writeText(code);
      setCodeCopied(true);
    } catch { /* the code stays on screen to type */ }
    openExternal(GH_DEVICE_URL);
  };

  const signInInTerminal = async () => {
    setFlow(null);
    const ok = await openGithubLoginTab(t('git.connect.tabTitle'));
    if (!ok) setShowCommand(true);
  };

  const recheck = () => {
    setMissing(false);
    onRecheck();
  };

  if (gate === 'cli-missing' || missing) {
    const platform = window.electronAPI?.platform;
    const install = platform === 'darwin' ? 'brew install gh' : platform === 'win32' ? 'winget install --id GitHub.cli' : null;
    return (
      <div className="wmux-gh-connect-page" data-gh-connect-install>
        <div className="wmux-gh-connect-card">
          <h2 className="wmux-gh-connect-title">{t('git.connect.installTitle')}</h2>
          <p className="wmux-gh-connect-desc">{t('git.ghConnect.installDesc')}</p>
          {install
            ? <CopyLine text={install} testId="gh-connect-install-cmd" />
            : <p className="wmux-gh-connect-desc">{t('git.ghConnect.installLinux')}</p>}
          <div className="wmux-gh-connect-actions">
            {!install && (
              <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={() => openExternal(LINUX_GUIDE)} data-gh-connect-guide>
                {t('git.ghConnect.installGuide')}
              </button>
            )}
            <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={() => openExternal(CLI_SITE)} data-gh-connect-site>
              {t('git.ghConnect.installSite')}
            </button>
            <button type="button" className={`wmux-git-primary ${FOCUS_RING}`} onClick={recheck} data-gh-connect-recheck>
              {t('git.connect.recheck')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wmux-gh-connect-page" data-gh-connect>
      <div className="wmux-gh-connect-card">
        <h2 className="wmux-gh-connect-title">{t('git.connect.title')}</h2>
        <p className="wmux-gh-connect-desc">{t('git.ghConnect.desc')}</p>
        <div className="wmux-gh-connect-actions">
          <button
            type="button"
            className={`wmux-git-primary ${FOCUS_RING}`}
            disabled={flow !== null}
            onClick={() => void connect()}
            data-gh-connect-button
          >
            {t('git.connect.button')}
          </button>
          <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={recheck} data-gh-connect-recheck>
            {t('git.connect.recheck')}
          </button>
        </div>
        {showCommand && (
          <>
            <p className="wmux-gh-connect-quiet">{t('git.ghConnect.commandDesc')}</p>
            <CopyLine text={GH_LOGIN_COMMAND} testId="gh-connect-command" />
          </>
        )}
      </div>

      {flow && (
        <Dialog onClose={cancel} width={420} data-testid="gh-connect-dialog">
          <DialogHeader title={t('git.connect.title')} closeLabel={t('git.ghConnect.cancel')} />
          <DialogBody>
            {flow.phase === 'starting' && <p className="wmux-gh-connect-quiet" role="status">{t('git.ghConnect.starting')}</p>}
            {flow.phase === 'code' && (
              <>
                <p className="wmux-gh-connect-desc">{t('git.ghConnect.codeHint')}</p>
                <p className="wmux-gh-connect-code" data-gh-connect-code>{flow.code}</p>
                <p className="wmux-gh-connect-quiet" role="status">
                  {codeCopied ? `${t('git.ghConnect.copied')} ` : ''}{t('git.ghConnect.waiting')}
                </p>
              </>
            )}
            {flow.phase === 'timeout' && <p className="wmux-gh-connect-desc" role="alert">{t('git.ghConnect.timeout')}</p>}
            {flow.phase === 'failed' && (
              <>
                <p className="wmux-gh-connect-desc" role="alert">{t('git.ghConnect.failed')}</p>
                {flow.message && <p className="wmux-gh-connect-quiet">{flow.message}</p>}
                {flow.fallback && (
                  <>
                    <p className="wmux-gh-connect-quiet">{t('git.ghConnect.commandDesc')}</p>
                    <CopyLine text={GH_LOGIN_COMMAND} testId="gh-connect-dialog-command" />
                  </>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            {(flow.phase === 'starting' || flow.phase === 'code') && (
              <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={cancel} data-gh-connect-cancel>
                {t('git.ghConnect.cancel')}
              </button>
            )}
            {flow.phase === 'code' && (
              <button type="button" className={`wmux-git-primary ${FOCUS_RING}`} onClick={() => void copyAndOpen(flow.code)} data-gh-connect-copy-open>
                {t('git.ghConnect.copyOpen')}
              </button>
            )}
            {(flow.phase === 'timeout' || flow.phase === 'failed') && (
              <>
                <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={cancel} data-gh-connect-close>
                  {t('git.ghConnect.close')}
                </button>
                {flow.phase === 'failed' && flow.fallback ? (
                  <>
                    <button type="button" className={`wmux-git-button ${FOCUS_RING}`} onClick={() => void connect()} data-gh-connect-retry>
                      {t('git.ghConnect.retry')}
                    </button>
                    <button type="button" className={`wmux-git-primary ${FOCUS_RING}`} onClick={() => void signInInTerminal()} data-gh-connect-terminal>
                      {t('git.ghConnect.useTerminal')}
                    </button>
                  </>
                ) : (
                  <button type="button" className={`wmux-git-primary ${FOCUS_RING}`} onClick={() => void connect()} data-gh-connect-retry>
                    {t('git.ghConnect.retry')}
                  </button>
                )}
              </>
            )}
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
