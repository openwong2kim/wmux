/**
 * The first-run wizard's "Agent ready" step: one row per agent with a `setup`
 * row (Claude Code, Codex, Grok, Antigravity; a `card: 'when-installed'` row
 * only once found) in four states (ready, sign-in
 * needed, installed with a sign-in wmux cannot check, not installed), plus the
 * corner card the wizard shrinks to while an install or sign-in pane is in use.
 *
 * Nothing runs without a click. Install first shows the exact line and asks;
 * the line then runs in a visible terminal tab (utils/agentSetupRuns.ts). The
 * wizard never answers an agent's own setup questions: the guide card only
 * says what the screen in the pane is asking.
 */
import { useEffect, useState } from 'react';
import type { AgentId, AgentSetupStatus } from '../../shared/agentSetup';
import { AGENT_IDS, shownAgentIds } from '../../shared/agentSetup';
import { agentRow } from '../../shared/agentIdentity';
import { agentOfficialPage, type AgentInstallVia, type AgentSetupPlan, type AgentSetupPlanInstall, type SetAgentPathResult } from '../../shared/agentInstall';
import { useT } from '../hooks/useT';
import { useStore } from '../stores';
import Button from './ui/Button';
import Input from './ui/Input';
import SegmentedControl from './ui/SegmentedControl';
import { IconCheck, IconWarning } from './icons';
import {
  agentStatusOf,
  clearAgentRun,
  effectivePaneShell,
  refreshAgentStatus,
  showAgentRunPane,
  startAgentRun,
  useAgentSetup,
  type AgentRun,
} from '../utils/agentSetupRuns';

type T = ReturnType<typeof useT>;

/** The card title: the registry's display name (a product name, not translated). */
function agentName(agent: AgentId): string {
  return agentRow(agent)?.display ?? agent;
}

function firstRunApi() {
  return window.electronAPI?.firstRun;
}

function openExternal(url: string): void {
  void window.electronAPI?.shell?.openExternal?.(url)?.catch?.(() => undefined);
}

type RowStatus = 'ok' | 'todo' | 'warn' | 'error';

function Row({ status, title, detail, action, children, testId }: {
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

/** A command in mono with a Copy button (the no-tab fallback). */
function CopyLine({ text, t }: { text: string; t: T }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wmux-agent-setup-cmd">
      <code className="ui-code">{text}</code>
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          try { await window.clipboardAPI?.writeText(text); setCopied(true); } catch { /* stays on screen */ }
        }}
      >
        {copied ? t('firstRunWizard.agent.copied') : t('firstRunWizard.agent.copy')}
      </Button>
    </div>
  );
}

/** The i18n key naming an install line by how it runs. */
export function installViaKey(install: Pick<AgentSetupPlanInstall, 'via' | 'shell'>): string {
  if (install.via !== 'script') return `firstRunWizard.agent.via.${install.via}`;
  return install.shell === 'powershell' ? 'firstRunWizard.agent.via.powershell' : 'firstRunWizard.agent.via.script';
}

/**
 * Which card's action is the dialog's one primary, if any. Only while no agent
 * is ready and nothing is running: the first card in registry order.
 */
export function decideAgentPrimary(
  statuses: AgentSetupStatus[] | null,
  runs: Partial<Record<AgentId, AgentRun>>,
): AgentId | null {
  if (!statuses) return null;
  if (statuses.some((s) => s.readiness === 'ready')) return null;
  if (Object.values(runs).some((r) => r?.phase === 'running')) return null;
  // The first card whose own action can be the primary (Install, Retry, Log
  // in); a card that only offers "Check again" is never the primary.
  return shownAgentIds(statuses).find((a) => {
    const status = agentStatusOf(a, statuses);
    const phase = runs[a]?.phase;
    if (!status || phase === 'not-found' || phase === 'no-tab') return false;
    return status.readiness === 'not-installed' || status.readiness === 'login-needed';
  }) ?? null;
}

/**
 * The agent rows the group lists before "Other agents" when the wizard opens:
 * once an agent is signed in, only the signed-in ones and any with a run the
 * user started; with none signed in yet, every agent, since one of them must
 * be set up. The wizard decides this once and keeps it, so a row the user is
 * working in never folds away under them.
 */
export function agentRowsToList(
  statuses: AgentSetupStatus[] | null,
  runs: Partial<Record<AgentId, AgentRun>>,
): { listed: AgentId[]; folded: AgentId[] } {
  const all = shownAgentIds(statuses);
  if (!statuses?.some((s) => s.readiness === 'ready')) return { listed: all, folded: [] };
  const keep = (a: AgentId) => agentStatusOf(a, statuses)?.readiness === 'ready' || runs[a] !== undefined;
  return { listed: all.filter(keep), folded: all.filter((a) => !keep(a)) };
}

/**
 * The "Agent ready" group: one row per agent. `onShowPane` is called when a
 * card brings a run's terminal tab to the front, so the wizard can step aside
 * (a modal over the pane would keep the user from typing or reading it).
 */
export function AgentReadyGroup({ primary, onShowPane, folded = [], onShowAll }: {
  primary: AgentId | null;
  onShowPane: (agent: AgentId) => void;
  /** Agents listed under "Other agents" until it is pressed. */
  folded?: readonly AgentId[];
  onShowAll?: () => void;
}) {
  const t = useT();
  const { statuses, runs } = useAgentSetup();
  const all = shownAgentIds(statuses);
  const rows = all.filter((a) => !folded.includes(a));
  const hidden = all.length - rows.length;
  return (
    <section className="flex flex-col gap-2" data-testid="first-run-agent-ready">
      <div>
        <h3 className="ui-row-title">{t('firstRunWizard.agent.groupTitle')}</h3>
        <p className="ui-row-detail">{t('firstRunWizard.agent.groupHint')}</p>
      </div>
      <div className="ui-group">
        {rows.map((agent) => (
          <AgentCard
            key={agent}
            agent={agent}
            status={agentStatusOf(agent, statuses)}
            loaded={statuses !== null}
            run={runs[agent]}
            primary={primary === agent}
            onShowPane={onShowPane}
          />
        ))}
      </div>
      {hidden > 0 && onShowAll && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={onShowAll}
          data-testid="first-run-agent-show-others"
        >
          {t('firstRunWizard.agent.otherAgents', { count: hidden })}
        </Button>
      )}
    </section>
  );
}

export function AgentCard({ agent, status, loaded, run, primary, onShowPane }: {
  agent: AgentId;
  status: AgentSetupStatus | null;
  loaded: boolean;
  run: AgentRun | undefined;
  primary: boolean;
  onShowPane?: (agent: AgentId) => void;
}) {
  const t = useT();
  const name = agentName(agent);
  const [confirming, setConfirming] = useState<AgentSetupPlan | null>(null);
  // Which of the plan's install lines the confirm step shows and runs.
  const [via, setVia] = useState<AgentInstallVia>('script');
  const [planError, setPlanError] = useState(false);
  const [path, setPath] = useState('');
  const [pathResult, setPathResult] = useState<SetAgentPathResult | null>(null);
  const testId = `first-run-agent-${agent}`;

  const loadPlan = async (): Promise<AgentSetupPlan | null> => {
    try {
      // The sign-in line is quoted for the shell the pane will open in.
      const plan = await firstRunApi()?.agentPlan?.(agent, effectivePaneShell(useStore.getState().defaultShell));
      setPlanError(!plan);
      return plan ?? null;
    } catch {
      setPlanError(true);
      return null;
    }
  };

  const askInstall = async () => {
    const plan = await loadPlan();
    if (!plan) return;
    // Retry: the failed run gives way to the confirm step.
    clearAgentRun(agent);
    if (!(plan.installs ?? []).some((i) => i.via === via)) setVia(plan.install.via);
    setConfirming(plan);
  };

  const showPane = () => {
    if (showAgentRunPane(agent)) onShowPane?.(agent);
  };

  const runInstall = async (plan: AgentSetupPlan, install: AgentSetupPlanInstall) => {
    setConfirming(null);
    await startAgentRun(agent, 'install', { ...plan, install }, t('firstRunWizard.agent.tabInstall', { name }));
  };

  const runLogin = async () => {
    const plan = await loadPlan();
    if (plan) await startAgentRun(agent, 'login', plan, t('firstRunWizard.agent.tabLogin', { name }));
  };

  const checkAgain = () => {
    clearAgentRun(agent);
    void refreshAgentStatus();
  };

  const usePath = async () => {
    try {
      const res = await firstRunApi()?.setAgentPath?.(agent, path);
      setPathResult(res ?? { ok: false, reason: 'not-found' });
      if (res?.ok) checkAgain();
    } catch {
      setPathResult({ ok: false, reason: 'not-found' });
    }
  };

  const page = agentOfficialPage(agent);
  const officialPage = page ? (
    <Button size="sm" variant="ghost" onClick={() => openExternal(page)}>
      {t('firstRunWizard.agent.officialPage')}
    </Button>
  ) : null;
  const variant = (isPrimary: boolean) => (isPrimary ? 'primary' : 'secondary');

  if (!loaded || !status) {
    return <Row status="todo" testId={testId} title={name} detail={t('firstRunWizard.agent.checking')} />;
  }

  // A run in progress or just ended speaks first; the detected state otherwise.
  if (run?.phase === 'running') {
    return (
      <Row
        status="todo"
        testId={testId}
        title={name}
        detail={run.kind === 'install' ? t('firstRunWizard.agent.installing') : t('firstRunWizard.agent.loggingIn')}
        action={<Button size="sm" variant="secondary" onClick={showPane}>{t('firstRunWizard.agent.showTerminal')}</Button>}
      />
    );
  }

  if (run?.phase === 'no-tab') {
    return (
      <Row status="todo" testId={testId} title={name} detail={t('firstRunWizard.agent.noTab')}
        action={<Button size="sm" variant="secondary" onClick={checkAgain}>{t('firstRunWizard.agent.checkAgain')}</Button>}>
        {run.command && <CopyLine text={run.command} t={t} />}
      </Row>
    );
  }

  if (run?.kind === 'install' && run.phase === 'failed') {
    const key = run.failure === 'network'
      ? 'firstRunWizard.agent.failedNetwork'
      : run.failure === 'permission'
        ? 'firstRunWizard.agent.failedPermission'
        : 'firstRunWizard.agent.failedUnknown';
    return (
      <Row status="error" testId={testId} title={name} detail={t(key)}
        action={<Button size="sm" variant={variant(primary)} onClick={() => void askInstall()}>{t('firstRunWizard.agent.retry')}</Button>}>
        <div className="wmux-agent-setup-actions">
          <Button size="sm" variant="ghost" onClick={showPane} data-testid={`${testId}-view-log`}>
            {t('firstRunWizard.agent.viewLog')}
          </Button>
          {officialPage}
        </div>
        {planError && <p className="ui-row-error">{t('firstRunWizard.agent.planError')}</p>}
      </Row>
    );
  }

  if (status.readiness === 'not-installed' && run?.phase === 'not-found') {
    return (
      <Row status="warn" testId={testId} title={name} detail={t('firstRunWizard.agent.notFound')}
        action={<Button size="sm" variant="secondary" onClick={checkAgain}>{t('firstRunWizard.agent.checkAgain')}</Button>}>
        <ul className="wmux-agent-setup-paths" data-testid={`${testId}-candidates`}>
          {status.candidates.map((c) => <li key={c}><code className="ui-code">{c}</code></li>)}
        </ul>
        <div className="wmux-agent-setup-path">
          <Input
            value={path}
            onChange={(e) => { setPath(e.target.value); setPathResult(null); }}
            placeholder={t('firstRunWizard.agent.pathLabel', { name })}
            aria-label={t('firstRunWizard.agent.pathLabel', { name })}
            spellCheck={false}
            data-testid={`${testId}-path`}
          />
          <Button size="sm" variant="secondary" disabled={path.trim().length === 0} onClick={() => void usePath()}>
            {t('firstRunWizard.agent.pathUse')}
          </Button>
        </div>
        {pathResult && !pathResult.ok && (
          <p className="ui-row-error">{t(`firstRunWizard.agent.pathError.${pathResult.reason}`, { name })}</p>
        )}
      </Row>
    );
  }

  if (status.readiness === 'ready') {
    return (
      <Row
        status="ok"
        testId={testId}
        title={name}
        detail={status.version ? t('firstRunWizard.agent.readyVersion', { version: status.version }) : t('firstRunWizard.agent.ready')}
      >
        {status.updateRecommended && status.version && (
          <p className="ui-row-detail" data-testid={`${testId}-update`}>
            {t('firstRunWizard.agent.updateRecommended')}
          </p>
        )}
      </Row>
    );
  }

  if (status.readiness === 'installed') {
    // Installed; the agent signs in on its own first run and documents no
    // check wmux could run, so the card says that instead of guessing.
    return (
      <Row
        status="ok"
        testId={testId}
        title={name}
        detail={status.version ? t('firstRunWizard.agent.installedVersion', { version: status.version }) : t('firstRunWizard.agent.installed')}
        action={
          <Button size="sm" variant="secondary" onClick={() => void runLogin()} data-testid={`${testId}-login`}>
            {t('firstRunWizard.agent.signInButton')}
          </Button>
        }>
        <p className="ui-row-detail" data-testid={`${testId}-sign-in-note`}>{t('firstRunWizard.agent.signInOwn', { name })}</p>
        {status.updateRecommended && <p className="ui-row-detail">{t('firstRunWizard.agent.updateRecommended')}</p>}
        {planError && <p className="ui-row-error">{t('firstRunWizard.agent.planError')}</p>}
      </Row>
    );
  }

  if (status.readiness === 'login-needed') {
    const closed = run?.kind === 'login' && run.phase === 'closed';
    const detail = closed
      ? t('firstRunWizard.agent.loginClosed')
      : status.loginKnown ? t('firstRunWizard.agent.loginNeeded') : t('firstRunWizard.agent.loginUnknown');
    return (
      <Row status="todo" testId={testId} title={name} detail={detail}
        action={
          <Button size="sm" variant={variant(primary)} onClick={() => void runLogin()} data-testid={`${testId}-login`}>
            {closed ? t('firstRunWizard.agent.loginAgainButton') : t('firstRunWizard.agent.loginButton')}
          </Button>
        }>
        {status.updateRecommended && <p className="ui-row-detail">{t('firstRunWizard.agent.updateRecommended')}</p>}
        {planError && <p className="ui-row-error">{t('firstRunWizard.agent.planError')}</p>}
      </Row>
    );
  }

  // Not installed.
  if (confirming) {
    const installs = confirming.installs?.length ? confirming.installs : [confirming.install];
    const chosen = installs.find((i) => i.via === via) ?? installs[0];
    const missing = chosen.missing;
    // Every documented way on this platform, the vendor's main one first.
    const choice = installs.length > 1 ? (
      <SegmentedControl
        value={chosen.via}
        options={installs.map((i) => ({ value: i.via, label: t(installViaKey(i)) }))}
        onValueChange={setVia}
        ariaLabel={t('firstRunWizard.agent.viaLabel', { name })}
        data-testid={`${testId}-via`}
      />
    ) : null;
    if (missing.length > 0) {
      return (
        <Row status="warn" testId={testId} title={name}
          detail={t('firstRunWizard.agent.missingTool', { tool: missing.join(', ') })}
          action={<Button size="sm" variant="secondary" onClick={() => { setConfirming(null); void askInstall(); }}>{t('firstRunWizard.agent.checkAgain')}</Button>}>
          {choice}
          <div className="wmux-agent-setup-actions">{officialPage}</div>
        </Row>
      );
    }
    return (
      <Row status="todo" testId={testId} title={name} detail={t('firstRunWizard.agent.confirmInstall')}>
        {choice}
        <code className="ui-code wmux-agent-setup-line" data-testid={`${testId}-command`}>{chosen.command}</code>
        <div className="wmux-agent-setup-actions">
          <Button size="sm" variant={variant(primary)} onClick={() => void runInstall(confirming, chosen)} data-testid={`${testId}-run`}>
            {t('firstRunWizard.agent.confirmRun')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>{t('firstRunWizard.agent.cancel')}</Button>
        </div>
      </Row>
    );
  }
  return (
    <Row status="todo" testId={testId} title={name} detail={t('firstRunWizard.agent.notInstalled')}
      action={
        <Button size="sm" variant={variant(primary)} onClick={() => void askInstall()} data-testid={`${testId}-install`}>
          {t('firstRunWizard.agent.installButton')}
        </Button>
      }>
      {planError && <p className="ui-row-error">{t('firstRunWizard.agent.planError')}</p>}
    </Row>
  );
}

/** The guide line for what the sign-in pane shows right now. */
export function guideKeys(run: AgentRun): { title: string; body: string } {
  // A run that already ended (the user opened its tab with View log).
  if (run.phase !== 'running') {
    const body = run.phase === 'failed'
      ? run.failure === 'network' ? 'firstRunWizard.agent.failedNetwork'
        : run.failure === 'permission' ? 'firstRunWizard.agent.failedPermission' : 'firstRunWizard.agent.failedUnknown'
      : run.phase === 'not-found' ? 'firstRunWizard.agent.notFound'
        : run.phase === 'succeeded'
          ? (run.kind === 'login' ? 'firstRunWizard.agent.guide.signedInBody' : 'firstRunWizard.agent.ready')
          : run.kind === 'login' ? 'firstRunWizard.agent.loginClosed' : 'firstRunWizard.agent.failedUnknown';
    return { title: 'firstRunWizard.agent.guide.logTitle', body };
  }
  if (run.kind === 'install') {
    return { title: 'firstRunWizard.agent.guide.installTitle', body: 'firstRunWizard.agent.guide.installBody' };
  }
  // An agent without recognised first-run screens gets its own sign-in note.
  if (!agentRow(run.agent)?.setup?.firstRunScreens) {
    return { title: 'firstRunWizard.agent.guide.signInTitle', body: `firstRunWizard.agent.guide.signInBody.${run.agent}` };
  }
  if (run.screen === 'folder-trust') {
    return { title: 'firstRunWizard.agent.guide.trustTitle', body: 'firstRunWizard.agent.guide.trustBody' };
  }
  if (run.screen === 'first-run') {
    return { title: 'firstRunWizard.agent.guide.claudeSetupTitle', body: 'firstRunWizard.agent.guide.claudeSetupBody' };
  }
  return { title: 'firstRunWizard.agent.guide.claudeTitle', body: 'firstRunWizard.agent.guide.claudeBody' };
}

/** The run the corner card is about: a running one, else the latest with a tab. */
export function cornerRun(runs: Partial<Record<AgentId, AgentRun>>): AgentRun | undefined {
  const all = AGENT_IDS.map((a) => runs[a]).filter((r): r is AgentRun => !!r && r.ptyId !== null);
  return all.find((r) => r.phase === 'running') ?? all.sort((a, b) => b.id - a.id)[0];
}

/**
 * The wizard while a setup pane is in use: a small non-modal card in the
 * window's corner (like the keyboard cheat sheet), so the terminal stays
 * usable. It says what the pane is asking and leads back to the full wizard.
 */
export function AgentSetupCorner({ agent, onExpand }: { agent?: AgentId; onExpand: () => void }) {
  const t = useT();
  const { runs } = useAgentSetup();
  // The agent the user is looking at, not whichever run happens to be newest.
  const run = (agent ? runs[agent] : undefined) ?? cornerRun(runs);
  useEffect(() => {
    // The pane is the point of this mode: put it in front once.
    if (run) showAgentRunPane(run.agent);
  }, [run?.agent, run?.ptyId]);
  if (!run) return null;
  const name = agentName(run.agent);
  const guide = guideKeys(run);
  return (
    <aside
      className="wmux-agent-setup-corner"
      role="status"
      aria-live="polite"
      data-testid="first-run-agent-corner"
      data-agent={run.agent}
      data-screen={run.screen ?? ''}
    >
      <p className="ui-row-title">{t(guide.title, { name })}</p>
      <p className="ui-row-detail">{t(guide.body, { name })}</p>
      <div className="wmux-agent-setup-actions">
        <Button size="sm" variant="secondary" onClick={onExpand} data-testid="first-run-agent-corner-back">
          {t('firstRunWizard.agent.backToSetup')}
        </Button>
      </div>
    </aside>
  );
}
