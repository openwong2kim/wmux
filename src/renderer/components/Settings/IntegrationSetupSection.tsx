// ─── Settings → Claude integration — the setup card ──────────────────────────
//
// Everything wmux installs into someone else's config lives here, in one place,
// with its real state read from a probe rather than inferred.
//
// Why it exists: all three integrations shipped with a working IPC probe and an
// install path, but the only UI that ever offered them was the first-run
// wizard. Skip that once and there was no way back — the CLI commands
// (`wmux setup-hooks`, `wmux mcp register`, `wmux setup-statusline`) were the
// entire re-entry path, and an operator who could not remember them had no way
// to discover the feature existed. The wizard is a moment; settings is a place.
//
// Two rows are REQUIRED and one is RECOMMENDED, and the card says which:
//
//   hooks       required     lifecycle signals; without it every completion
//                            detection degrades to the regex fallback
//   mcp         required     the agent's access to wmux tools at all
//   statusline  recommended  model / context / rate limits under the input box;
//                            purely informational, costs nothing to run
//
// No nagging: this card never raises a banner or a toast. wmux does not edit
// ~/.claude/settings.json behind the operator's back (owner decision
// 2026-07-17), so every row's action is a button the human clicks. The one
// existing nudge (HooksInstallPrompt, at launch and on a mode raise) stays as
// it is — this card is the place you go, not a thing that comes to you.

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';

// ─── Injected API (jsdom-testable; the container binds the preload bridges) ───

export interface IntegrationSetupApi {
  hooks: {
    status: () => Promise<{ installed: boolean }>;
    install: () => Promise<{ ok: boolean; error: string | null }>;
  };
  statusline: {
    status: () => Promise<{ installed: boolean }>;
    /** `ok` only means nothing broke: every target can be skipped when another
     *  tool owns its settings.json. A row is installed when a target took it. */
    install: () => Promise<{
      ok: boolean;
      error: string | null;
      targets: Array<{ outcome: string }>;
    }>;
  };
  mcp: {
    /** `verified` is the per-target truth; the row is installed when any target has it. */
    check: () => Promise<{ targets: Array<{ displayName: string; verified: boolean }> }>;
    reregister: () => Promise<{ targets: Array<{ displayName: string; verified: boolean }> }>;
  };
}

/** One row's lifecycle. `unknown` is the pre-probe state and reads as its own
 *  thing — never as "not installed", which would be a lie the user acts on. */
export type RowState = 'unknown' | 'installed' | 'missing' | 'working' | 'error';

interface RowModel {
  state: RowState;
  error: string | null;
}

const INITIAL: RowModel = { state: 'unknown', error: null };

/** Probe → row state. Kept separate so the mapping is testable without a DOM. */
export function rowStateFromProbe(installed: boolean): RowState {
  return installed ? 'installed' : 'missing';
}

// ─── The card ────────────────────────────────────────────────────────────────

export function IntegrationSetupSection({
  api,
}: {
  api: IntegrationSetupApi;
}): React.ReactElement {
  const t = useT();
  const [hooks, setHooks] = useState<RowModel>(INITIAL);
  const [mcp, setMcp] = useState<RowModel>(INITIAL);
  const [statusline, setStatusline] = useState<RowModel>(INITIAL);

  // A probe that throws leaves the row `unknown` rather than claiming "missing":
  // an install button offered because IPC hiccuped would write to a config the
  // user never asked to touch.
  const probeAll = useCallback(() => {
    api.hooks
      .status()
      .then((s) => setHooks({ state: rowStateFromProbe(s.installed), error: null }))
      .catch(() => setHooks(INITIAL));
    api.statusline
      .status()
      .then((s) => setStatusline({ state: rowStateFromProbe(s.installed), error: null }))
      .catch(() => setStatusline(INITIAL));
    api.mcp
      .check()
      .then((s) =>
        setMcp({ state: rowStateFromProbe(s.targets.some((x) => x.verified)), error: null }),
      )
      .catch(() => setMcp(INITIAL));
  }, [api]);

  useEffect(() => { probeAll(); }, [probeAll]);

  const runInstall = useCallback(
    async (
      set: (m: RowModel) => void,
      install: () => Promise<{
        ok: boolean;
        error: string | null;
        targets?: Array<{ outcome: string }>;
      }>,
    ) => {
      set({ state: 'working', error: null });
      try {
        const outcome = await install();
        // When the install reports per-target outcomes, `ok` alone is not
        // success: every target can be skipped because another tool owns its
        // settings.json, and claiming "Installed" there is a receipt for
        // something that did not happen.
        const took = outcome.targets ? outcome.targets.some((x) => x.outcome === 'installed') : true;
        set(
          outcome.ok && took
            ? { state: 'installed', error: null }
            : { state: 'error', error: outcome.error },
        );
      } catch (err) {
        set({ state: 'error', error: err instanceof Error ? err.message : null });
      }
    },
    [],
  );

  // MCP's register path answers with a status payload, not an ok/error pair, so
  // it reads its own result rather than sharing runInstall.
  const registerMcp = useCallback(async () => {
    setMcp({ state: 'working', error: null });
    try {
      const status = await api.mcp.reregister();
      const verified = status.targets.some((x) => x.verified);
      setMcp(
        verified
          ? { state: 'installed', error: null }
          : { state: 'error', error: null },
      );
    } catch (err) {
      setMcp({ state: 'error', error: err instanceof Error ? err.message : null });
    }
  }, [api]);

  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-3"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
      data-integration-setup
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-[color:var(--text-main)] font-mono">
          {t('integrationSetup.title')}
        </span>
      </div>
      <p className="text-xs text-[color:var(--text-muted)] leading-relaxed">
        {t('integrationSetup.description')}
      </p>

      <SetupRow
        id="hooks"
        required
        title={t('integrationSetup.hooks.title')}
        description={t('integrationSetup.hooks.description')}
        model={hooks}
        actionLabel={t('integrationSetup.installButton')}
        onAction={() => void runInstall(setHooks, api.hooks.install)}
      />
      <SetupRow
        id="mcp"
        required
        title={t('integrationSetup.mcp.title')}
        description={t('integrationSetup.mcp.description')}
        model={mcp}
        actionLabel={t('integrationSetup.registerButton')}
        onAction={() => void registerMcp()}
      />
      <SetupRow
        id="statusline"
        required={false}
        title={t('integrationSetup.statusline.title')}
        description={t('integrationSetup.statusline.description')}
        model={statusline}
        actionLabel={t('integrationSetup.installButton')}
        onAction={() => void runInstall(setStatusline, api.statusline.install)}
      />
    </div>
  );
}

function SetupRow({
  id,
  required,
  title,
  description,
  model,
  actionLabel,
  onAction,
}: {
  id: string;
  required: boolean;
  title: string;
  description: string;
  model: RowModel;
  actionLabel: string;
  onAction: () => void;
}): React.ReactElement {
  const t = useT();
  const installed = model.state === 'installed';
  const working = model.state === 'working';

  return (
    <div
      className="flex items-start justify-between gap-3 py-2 border-t"
      style={{ borderColor: 'var(--bg-surface)' }}
      data-setup-row={id}
      data-setup-row-state={model.state}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-[color:var(--text-main)]">{title}</span>
          {/* Required is stated in text, not color: the color grammar reserves
              red for destructive, and a red "required" on a healthy install
              would read as an error. */}
          <span className="text-[10px] text-[color:var(--text-muted)]">
            {required ? t('integrationSetup.required') : t('integrationSetup.recommended')}
          </span>
        </div>
        <span className="text-[11px] text-[color:var(--text-muted)] leading-relaxed">
          {description}
        </span>
        {model.state === 'error' && (
          <span
            className="text-[11px]"
            style={{ color: 'var(--accent-red, #f38ba8)' }}
            data-setup-row-error
          >
            {t('integrationSetup.installFailed')}
            {model.error ? ` (${model.error})` : ''}
          </span>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <StateChip state={model.state} />
        {!installed && model.state !== 'unknown' && (
          <button
            type="button"
            onClick={onAction}
            disabled={working}
            data-setup-row-action
            className="text-[11px] font-mono px-2.5 py-1 rounded-md transition-colors disabled:opacity-50"
            style={{
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-main)',
              border: '1px solid var(--bg-overlay)',
              cursor: working ? 'wait' : 'pointer',
            }}
          >
            {working ? t('integrationSetup.working') : actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function StateChip({ state }: { state: RowState }): React.ReactElement {
  const t = useT();
  // Installed is the only state that earns the alive accent; everything else is
  // muted status text (DESIGN.md — amber means alive, and a checklist of grey
  // rows should not glow).
  const label =
    state === 'installed' ? t('integrationSetup.state.installed')
    : state === 'working' ? t('integrationSetup.state.working')
    : state === 'unknown' ? t('integrationSetup.state.unknown')
    : t('integrationSetup.state.missing');
  return (
    <span
      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
      style={{
        color: state === 'installed' ? 'var(--accent)' : 'var(--text-muted)',
        backgroundColor: 'rgba(var(--bg-surface-rgb), 0.6)',
      }}
      data-setup-row-chip
    >
      {label}
    </span>
  );
}

/** Container: binds the preload bridges. Renders nothing when any of them is
 *  absent (older preload / pure jsdom parent tests) — a card whose rows cannot
 *  report state is worse than no card. */
export function IntegrationSetupSectionContainer(): React.ReactElement | null {
  const api = (window as unknown as {
    electronAPI?: {
      deck?: {
        hooksBridge?: IntegrationSetupApi['hooks'];
        statuslineBridge?: IntegrationSetupApi['statusline'];
      };
      mcp?: IntegrationSetupApi['mcp'];
    };
  }).electronAPI;
  const hooks = api?.deck?.hooksBridge;
  const statusline = api?.deck?.statuslineBridge;
  const mcp = api?.mcp;
  if (!hooks || !statusline || !mcp) return null;
  return <IntegrationSetupSection api={{ hooks, statusline, mcp }} />;
}
