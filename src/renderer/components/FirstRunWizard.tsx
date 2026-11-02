/**
 * FirstRunWizard — the first launch, on one short screen.
 *
 * Is an agent ready (install or sign in from its row if not), is wmux
 * connected to Claude Code (MCP registration, hooks), and should wmux update
 * itself. Then one action: open a project folder as a workspace. Nothing else
 * opens by itself after it: the tour and the keyboard cheat sheet are on
 * demand (Settings › Setup and reset, the `?` prefix action).
 *
 * Opening a folder completes the first run; Skip, Later, × or Escape only
 * mark it shown (firstRun:dismiss), so a reopened wizard and Settings never
 * call a skipped first run completed.
 *
 * Renderer-only. Glues to main via window.electronAPI.firstRun.* (T1/T4).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FirstRunCheckResult,
  FirstRunMode,
  RegisterMcpResult,
  RegisterMcpErrorCode,
} from '../../shared/firstRun';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from './ui/Dialog';
import Button from './ui/Button';
import Switch from './ui/Switch';
import { IconCheck, IconWarning } from './icons';
import { FOCUS_RING } from './focusRing';
import { AgentReadyGroup, AgentSetupCorner, agentRowsToList, cornerRun, decideAgentPrimary } from './FirstRunAgentCards';
import { refreshAgentStatus, useAgentSetup } from '../utils/agentSetupRuns';
import { anyAgentSetUp, type AgentId } from '../../shared/agentSetup';
import { FIRST_RUN_REOPEN_EVENT } from '../../shared/firstRun';
import { showWorkspaces } from '../utils/showWorkspaces';

// ─── Local type narrowing for electronAPI.firstRun ────────────────────────────
//
// `firstRun` is also declared as optional on `Window['electronAPI']` in the
// shared `electron.d.ts` augmentation. We narrow to a non-optional shape here
// so callers below don't have to optional-chain every method.
interface FirstRunBridge {
  check: () => Promise<FirstRunCheckResult>;
  complete: () => Promise<void>;
  dismiss: () => Promise<void>;
  reopen: () => Promise<FirstRunCheckResult>;
  registerMcp: () => Promise<RegisterMcpResult>;
}

function firstRunBridge(): FirstRunBridge {
  const api = (window as unknown as {
    electronAPI?: { firstRun?: FirstRunBridge };
  }).electronAPI;
  if (!api?.firstRun) {
    throw new Error('window.electronAPI.firstRun is not available — preload not loaded?');
  }
  return api.firstRun;
}

// Hook bridge (preload `deck.hooksBridge`). An opt-in install the user
// clicks, never an edit behind their back. Not cosmetic: without it every
// lifecycle signal degrades to the regex detector, so the wizard is the one
// place a new install is guaranteed to see the offer.
interface HooksBridge {
  status: () => Promise<{ installed: boolean }>;
  install: () => Promise<{ ok: boolean; error: string | null }>;
}

/** Exported for the contract test: the accessor and the preload must agree
 *  on where the bridge lives, and reading the wrong path fails silently. */
export function hooksBridge(): HooksBridge | null {
  const api = (window as unknown as {
    electronAPI?: { deck?: { hooksBridge?: HooksBridge } };
  }).electronAPI;
  return api?.deck?.hooksBridge ?? null;
}

function shellOpenExternal(url: string): Promise<void> {
  const api = (window as unknown as {
    electronAPI?: { shell?: { openExternal: (u: string) => Promise<void> } };
  }).electronAPI;
  if (!api?.shell?.openExternal) return Promise.resolve();
  return api.shell.openExternal(url);
}

/** The folder picker; null when cancelled or unavailable. */
async function pickFolder(): Promise<string | null> {
  const picked = await window.electronAPI?.dialog?.pickFolder?.();
  return picked && picked.length > 0 ? picked[0] : null;
}

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

/** i18n keys for Tier 2 error display (D10). Falls back to UNKNOWN for unrecognized codes. */
export function getRegisterErrorKeys(code: RegisterMcpErrorCode | string): {
  problem: string;
  cause: string;
  fix: string;
} {
  const valid: ReadonlyArray<RegisterMcpErrorCode> = ['PERM', 'PARSE', 'IO', 'UNKNOWN'];
  const safe = valid.includes(code as RegisterMcpErrorCode) ? code : 'UNKNOWN';
  return {
    problem: `firstRunWizard.error.${safe}.problem`,
    cause: `firstRunWizard.error.${safe}.cause`,
    fix: `firstRunWizard.error.${safe}.fix`,
  };
}

/** The workspace name for a picked folder: its last path segment. */
export function folderWorkspaceName(folder: string): string {
  return folder.split(/[/\\]/).filter(Boolean).pop() || 'Workspace';
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface FirstRunWizardProps {
  mode: FirstRunMode;
  onClose: () => void;
}

/** Hooks row lifecycle; `unknown` keeps the row hidden. */
export type HooksSubState =
  | 'unknown'   // status not fetched yet (or bridge unavailable)
  | 'offer'     // installable, waiting for the user's click
  | 'installing'
  | 'installed'
  | 'error';

export default function FirstRunWizard({ mode, onClose }: FirstRunWizardProps) {
  const t = useT();

  const [result, setResult] = useState<FirstRunCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<
    { code: RegisterMcpErrorCode; message: string } | null
  >(null);
  const [hooksState, setHooksState] = useState<HooksSubState>('unknown');
  const [hooksError, setHooksError] = useState<string | null>(null);

  const firstFocusRef = useRef<HTMLButtonElement>(null);

  // Keep latest onClose in a ref so listeners installed once stay correct.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Async work (the hooks probe and install) must not set state after the
  // wizard closed.
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // ─── Initial check ─────────────────────────────────────────────────────────
  // `quiet`: re-read without the loading state, which would unmount the cards
  // (and lose what the user typed in one) while another card just installed.
  const refresh = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoading(true);
    try {
      const next =
        mode === 'reopen'
          ? await firstRunBridge().reopen()
          : await firstRunBridge().check();
      setResult(next);
    } catch {
      // If main is unreachable, show the agent rows only so the user can
      // still skip out cleanly.
      setResult({
        shown: false,
        status: { claudeFound: false, mcpRegistered: false, claudeJsonPath: '' },
      });
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ─── Agent ready step ──────────────────────────────────────────────────────
  // Probed separately from check(): it spawns each agent's status command, and
  // the dialog must not wait on that to open. While an install or sign-in pane
  // is in use the dialog steps aside to a corner card (the pane needs the
  // keyboard); it comes back when the run ends, or on "Back to setup".
  const { statuses, runs } = useAgentSetup();
  useEffect(() => {
    void refreshAgentStatus();
  }, []);
  // Aside (the corner card) whenever a run starts or the user opens a run's
  // tab, and back when every run has ended or on "Back to setup".
  // `aside` names the agent whose tab the corner card is about: the one that
  // just started a run, or the one whose View log / Show terminal was clicked.
  const running = Object.values(runs).filter((r): r is NonNullable<typeof r> => r?.phase === 'running');
  const runningIds = running.map((r) => `${r.id}:${r.agent}`).sort().join(',');
  const [aside, setAside] = useState<AgentId | null>(null);
  const seenRunning = useRef('');
  useEffect(() => {
    const before = seenRunning.current;
    seenRunning.current = runningIds;
    const agentOf = (key: string) => key.split(':')[1] as AgentId;
    const prev = before.split(',').filter(Boolean);
    const now = runningIds.split(',').filter(Boolean);
    const started = now.filter((key) => !prev.includes(key));
    if (started.length > 0) {
      setAside(agentOf(started[started.length - 1]));
      return;
    }
    if (!prev.some((key) => !now.includes(key))) return;
    // A run ended. Stay on a sign-in that just succeeded: the agent may still
    // be asking its own questions in the tab (security notes, folder trust),
    // and a dialog back over it would take the keyboard. Otherwise move to a
    // run still going, or come back when none is.
    setAside((cur) => {
      const run = cur ? runs[cur] : undefined;
      if (run && (run.phase === 'running' || (run.kind === 'login' && run.phase === 'succeeded'))) return cur;
      return now.length > 0 ? agentOf(now[0]) : null;
    });
  }, [runningIds]);
  // The sidebar's "Set up" (or Settings) asks for the wizard itself.
  useEffect(() => {
    const back = () => setAside(null);
    window.addEventListener(FIRST_RUN_REOPEN_EVENT, back);
    return () => window.removeEventListener(FIRST_RUN_REOPEN_EVENT, back);
  }, []);
  const stepAside = useCallback((agent: AgentId) => setAside(agent), []);
  const asideRun = aside ? runs[aside] ?? cornerRun(runs) : undefined;
  // An install the cards just saw: re-read the checklist so the rows that need
  // an installed agent (MCP registration, hooks) appear without reopening.
  const installedKey = statuses?.filter((s) => s.readiness !== 'not-installed').map((s) => s.agent).join(',') ?? null;
  const seenInstalled = useRef<string | null>(null);
  useEffect(() => {
    if (installedKey === null) return;
    const before = seenInstalled.current;
    seenInstalled.current = installedKey;
    if (before !== null && before !== installedKey) void refresh({ quiet: true });
  }, [installedKey, refresh]);
  const agentPrimary = decideAgentPrimary(statuses, runs);
  const agentReady = statuses !== null && anyAgentSetUp(statuses);
  // Which agents wait under "Other agents": decided on the first status read
  // and kept (here, not in the group, which unmounts while the dialog steps
  // aside), so a row the user is installing in never folds away.
  const [foldedAgents, setFoldedAgents] = useState<AgentId[] | null>(null);
  const folded = foldedAgents ?? (statuses ? agentRowsToList(statuses, runs).folded : []);
  useEffect(() => {
    if (foldedAgents === null && statuses !== null) setFoldedAgents(folded);
  }, [foldedAgents, statuses, folded]);
  const showAllAgents = useCallback(() => setFoldedAgents([]), []);
  const noAgentReady = statuses !== null && !agentReady;

  // ─── Hook bridge offer ─────────────────────────────────────────────────────
  // Already-installed shows as a ✓ line rather than hiding: this one is a
  // REQUIREMENT, and a first-run checklist that silently omits its most
  // important item teaches the operator it does not exist.
  useEffect(() => {
    const bridge = hooksBridge();
    if (!bridge) return;
    bridge
      .status()
      .then((s) => {
        if (!isMountedRef.current) return;
        setHooksState(s.installed ? 'installed' : 'offer');
      })
      .catch(() => {
        // Probe failure is not worth surfacing — keep the block hidden.
      });
  }, []);

  const handleInstallHooks = useCallback(async () => {
    const bridge = hooksBridge();
    if (!bridge) return;
    setHooksState('installing');
    setHooksError(null);
    try {
      const outcome = await bridge.install();
      if (!isMountedRef.current) return;
      if (outcome.ok) {
        setHooksState('installed');
      } else {
        setHooksError(outcome.error);
        setHooksState('error');
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setHooksError(err instanceof Error ? err.message : null);
      setHooksState('error');
    }
  }, []);

  // ─── Dismiss ───────────────────────────────────────────────────────────────
  // Escape, the close button and focus handling come from <Dialog>: Escape is
  // caught in the capture phase (so a focused terminal cannot swallow it) and
  // focus starts on the close button and returns to the opener afterwards.
  const dismiss = useCallback(async () => {
    try {
      await firstRunBridge().dismiss();
    } catch {
      // ignore — closing is best-effort
    }
    onCloseRef.current();
  }, []);

  // ─── Open a folder ─────────────────────────────────────────────────────────
  // The first run's one goal: a workspace on the user's project. Cancelling
  // the picker leaves the wizard open.
  const openFolder = useCallback(async () => {
    let folder: string | null = null;
    try {
      folder = await pickFolder();
    } catch {
      folder = null;
    }
    if (!folder || !isMountedRef.current) return;
    const st = useStore.getState();
    st.addWorkspace(folderWorkspaceName(folder), { startupCwd: folder });
    showWorkspaces(useStore.getState());
    try {
      await firstRunBridge().complete();
    } catch {
      // ignore — the workspace is open either way
    }
    onCloseRef.current();
  }, []);

  // ─── Register MCP ──────────────────────────────────────────────────────────
  const handleRegister = useCallback(async () => {
    setRegistering(true);
    setRegisterError(null);
    try {
      const res = await firstRunBridge().registerMcp();
      if (res.ok) {
        // Quiet: the agent cards keep what the user was doing in them.
        await refresh({ quiet: true });
      } else {
        setRegisterError({ code: res.code, message: res.message });
      }
    } catch (err) {
      setRegisterError({
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRegistering(false);
    }
  }, [refresh]);

  const primary = decidePrimaryAction({
    claudeFound: result?.status.claudeFound ?? false,
    mcpRegistered: result?.status.mcpRegistered ?? false,
    registering,
    hooksState: result?.status.claudeFound ? hooksState : 'unknown',
    agentAction: agentPrimary !== null,
    agentReady,
  });

  if (aside && asideRun) {
    return <AgentSetupCorner agent={asideRun.agent} onExpand={() => setAside(null)} />;
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog
      onClose={() => void dismiss()}
      width={500}
      initialFocusRef={firstFocusRef}
      data-testid="first-run-wizard"
      backdropTestId="first-run-wizard-backdrop"
    >
      <DialogHeader
        ref={firstFocusRef}
        title={t('firstRunWizard.title')}
        description={t('firstRunWizard.subtitle')}
        closeLabel={t('firstRunWizard.closeButton')}
        closeTestId="first-run-wizard-close"
      />

      <DialogBody>
        {loading && (
          <div
            className="text-[13px]"
            style={{ color: 'var(--text-muted)' }}
            data-testid="first-run-wizard-loading"
          >
            …
          </div>
        )}

        {!loading && result && (
          <>
            {/* Agent ready: one set-up agent is enough to go on. */}
            <AgentReadyGroup
              primary={primary === 'agent' ? agentPrimary : null}
              onShowPane={stepAside}
              folded={folded}
              onShowAll={showAllAgents}
            />

            {/* wmux's connection to Claude Code, and updates: one grouped
                container, one row per item. Rows that need an action are
                notice rows with the action on the right. */}
            <div className="ui-group" data-testid="first-run-wizard-checklist">
              {result.status.claudeFound && (
                <ClaudeStatusBlock
                  claudeFound={result.status.claudeFound}
                  mcpRegistered={result.status.mcpRegistered}
                  registering={registering}
                  onRegister={handleRegister}
                  primary={primary === 'register'}
                  showDetectedRow={false}
                />
              )}

              {result.status.claudeFound && hooksState !== 'unknown' && (
                <HooksBlock
                  state={hooksState}
                  errorDetail={hooksError}
                  onInstall={() => void handleInstallHooks()}
                  primary={primary === 'hooks'}
                />
              )}

              {/* The update question used to be its own modal right after this
                  one. Reopen mode leaves it to Settings, which owns the toggle. */}
              {mode === 'firstRun' && <AutoUpdateBlock />}
            </div>

            {/* Tier 2 inline registration error (D10) */}
            {registerError && (
              <div
                role="alert"
                data-testid="first-run-wizard-register-error"
                className="wmux-welcome-alert"
              >
                {(() => {
                  const keys = getRegisterErrorKeys(registerError.code);
                  return (
                    <>
                      <p className="ui-row-title">{t(keys.problem)}</p>
                      <p className="ui-row-detail">{withInlineCode(t(keys.cause))}</p>
                      <p className="ui-row-detail">{withInlineCode(t(keys.fix))}</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleRegister()}
                        disabled={registering}
                        data-testid="first-run-wizard-register-retry"
                        className="self-start mt-2"
                      >
                        {t('firstRunWizard.registerMcpButton')}
                      </Button>
                    </>
                  );
                })()}
              </div>
            )}
          </>
        )}
      </DialogBody>

      {!loading && result && (
        <DialogFooter>
          <Button
            size="md"
            variant="ghost"
            onClick={() => void dismiss()}
            data-testid="first-run-wizard-skip"
          >
            {mode === 'reopen'
              ? t('firstRunWizard.closeButton')
              : noAgentReady ? t('firstRunWizard.agent.later') : t('firstRunWizard.skipButton')}
          </Button>
          <Button
            size="md"
            variant={primary === 'folder' ? 'primary' : 'secondary'}
            onClick={() => void openFolder()}
            data-testid="first-run-wizard-open-folder"
          >
            {t('firstRunWizard.openFolder')}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}

/**
 * Which action gets the dialog's single solid (primary) button. DESIGN.md:
 * at most one filled action per surface, and never one that is disabled or
 * already running. Order follows what unblocks the user first: getting an
 * agent ready, then MCP registration, then the required hook install, then
 * opening a folder. While a registration or hook install is in flight,
 * nothing is primary — the emphasis does not jump to the next step
 * mid-install.
 */
export type WizardPrimaryAction = 'agent' | 'register' | 'hooks' | 'folder' | null;

export function decidePrimaryAction({
  claudeFound,
  mcpRegistered,
  registering,
  hooksState,
  agentAction = false,
  agentReady = false,
}: {
  claudeFound: boolean;
  mcpRegistered: boolean;
  registering: boolean;
  hooksState: HooksSubState;
  /** No agent is ready yet and an agent card has an action (install / sign in). */
  agentAction?: boolean;
  /** At least one agent is set up (any agent, not only Claude Code). */
  agentReady?: boolean;
}): WizardPrimaryAction {
  // Nothing below works without an agent: getting one ready comes first.
  if (agentAction) return 'agent';
  if (claudeFound && !mcpRegistered) return registering ? null : 'register';
  if (hooksState === 'installing') return null;
  if (hooksState === 'offer' || hooksState === 'error') return 'hooks';
  if (agentReady) return 'folder';
  return null;
}

/**
 * Renders `backtick` spans as mono code — commands are machine evidence.
 * Only balanced pairs become code: a stray backtick (an odd count, e.g. from a
 * translation) stays literal instead of turning the rest of the text to code.
 */
export function withInlineCode(text: string): React.ReactNode {
  const parts = text.split('`');
  if (parts.length < 3) return text;
  if (parts.length % 2 === 0) {
    // Odd number of backticks: the last one has no partner.
    const tail = parts.pop() as string;
    parts[parts.length - 1] = `${parts[parts.length - 1]}\`${tail}`;
    if (parts.length < 3) return parts[0];
  }
  return parts.map((part, i) =>
    i % 2 === 1 ? <code key={i} className="ui-code">{part}</code> : part,
  );
}

// ─── Sub-blocks (exported for unit tests) ─────────────────────────────────────

/** `none`: a setting row whose control carries its own state (a switch),
 *  so no status glyph — a check means done or installed, never "on". */
type RowStatus = 'ok' | 'todo' | 'warn' | 'error' | 'none';

/**
 * One row of a grouped list: status icon, title + optional muted detail, and
 * for a notice row the action on the right behind a vertical divider.
 */
function SetupRow({
  status,
  title,
  detail,
  action,
  children,
  testId,
}: {
  status: RowStatus;
  title: React.ReactNode;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="ui-row" data-status={status} data-testid={testId}>
      <span className="ui-row-icon" aria-hidden="true">
        {status === 'ok' && <span className="wmux-welcome-glyph-ok"><IconCheck size={14} /></span>}
        {status === 'warn' && <span className="wmux-welcome-glyph-warn"><IconWarning size={14} /></span>}
        {status === 'error' && <span className="wmux-welcome-glyph-error"><IconWarning size={14} /></span>}
        {status === 'todo' && <span className="wmux-welcome-todo" />}
      </span>
      <div className="ui-row-text">
        <p className="ui-row-title">{title}</p>
        {detail != null && <p className="ui-row-detail">{detail}</p>}
        {children}
      </div>
      {action != null && <div className="ui-row-action">{action}</div>}
    </div>
  );
}

export function ClaudeStatusBlock({
  claudeFound,
  mcpRegistered,
  registering,
  onRegister,
  primary = true,
  showDetectedRow = true,
}: {
  claudeFound: boolean;
  mcpRegistered: boolean;
  registering: boolean;
  onRegister: () => void;
  /** Draw Register as the dialog's primary action (never while registering). */
  primary?: boolean;
  /** The "Claude Code detected" row; off where the agent card already says it. */
  showDetectedRow?: boolean;
}) {
  const t = useT();

  if (!claudeFound) {
    return (
      <SetupRow
        status="warn"
        testId="first-run-wizard-claude-missing"
        title={t('firstRunWizard.claudeNotDetected')}
        detail={t('firstRunWizard.claudeInstallHint')}
      >
        <a
          href="https://claude.ai/code"
          onClick={(e) => {
            e.preventDefault();
            void shellOpenExternal('https://claude.ai/code').catch(() => undefined);
          }}
          className={`wmux-welcome-link ${FOCUS_RING}`}
          data-testid="first-run-wizard-install-link"
        >
          claude.ai/code
        </a>
      </SetupRow>
    );
  }

  return (
    <div className="contents" data-testid="first-run-wizard-claude-detected">
      {showDetectedRow && <SetupRow status="ok" title={t('firstRunWizard.claudeDetected')} />}
      {mcpRegistered ? (
        <SetupRow
          status="ok"
          testId="first-run-wizard-mcp-registered"
          title={t('firstRunWizard.mcpRegistered')}
        />
      ) : (
        <SetupRow
          status="todo"
          testId="first-run-wizard-mcp-not-registered"
          title={t('firstRunWizard.mcpNotRegistered')}
          action={
            <Button
              size="sm"
              variant={primary && !registering ? 'primary' : 'ghost'}
              onClick={onRegister}
              disabled={registering}
              data-testid="first-run-wizard-register"
            >
              {t('firstRunWizard.registerMcpButton')}
            </Button>
          }
        />
      )}
    </div>
  );
}

/**
 * Automatic update checks as one row with a switch, on by default (the same
 * default the updater and the store start from). Flipping it writes the
 * setting right away; Settings › General changes it later.
 */
export function AutoUpdateBlock() {
  const t = useT();
  const enabled = useStore((s) => s.autoUpdateEnabled);
  const setEnabled = (next: boolean) => {
    useStore.getState().setAutoUpdateEnabled(next);
    window.electronAPI?.settings?.setAutoUpdateEnabled(next);
  };
  return (
    <SetupRow
      status="none"
      testId="first-run-wizard-auto-update"
      title={t('settings.autoUpdate')}
      detail={t('settings.autoUpdateDesc')}
      action={
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('settings.autoUpdate')}
          data-testid="first-run-wizard-auto-update-switch"
        />
      }
    />
  );
}

export function HooksBlock({
  state,
  errorDetail,
  onInstall,
  primary = true,
}: {
  state: HooksSubState;
  errorDetail?: string | null;
  onInstall: () => void;
  /** Draw Install as the dialog's primary action (never while installing). */
  primary?: boolean;
}) {
  const t = useT();

  if (state === 'installed') {
    return (
      <SetupRow
        status="ok"
        testId="first-run-wizard-hooks-installed"
        title={t('firstRunWizard.hooksInstalled')}
        detail={t('firstRunWizard.hooksInstalledHint')}
      />
    );
  }

  const installing = state === 'installing';
  return (
    <SetupRow
      status={state === 'error' ? 'error' : 'todo'}
      testId="first-run-wizard-hooks-offer"
      title={t('firstRunWizard.hooksHeading')}
      detail={t('firstRunWizard.hooksDescription')}
      action={
        <Button
          size="sm"
          variant={primary && !installing ? 'primary' : 'ghost'}
          onClick={onInstall}
          disabled={installing}
          data-testid="first-run-wizard-hooks-install"
        >
          {installing ? t('firstRunWizard.hooksInstalling') : t('firstRunWizard.hooksEnableButton')}
        </Button>
      }
    >
      {state === 'error' && (
        <p className="ui-row-error" data-testid="first-run-wizard-hooks-error">
          {withInlineCode(t('firstRunWizard.hooksError'))}
          {errorDetail ? <> (<code className="ui-code">{errorDetail}</code>)</> : null}
        </p>
      )}
    </SetupRow>
  );
}
