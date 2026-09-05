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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { isInstallTake } from '../../../shared/statuslineOutcome';

// ─── Injected API (jsdom-testable; the container binds the preload bridges) ───

export interface IntegrationSetupApi {
  hooks?: {
    /** `installed` counts settings.json entries only. The marketplace plugin
     *  owns the same four hook events when it is present, and then an install
     *  deliberately writes nothing — so a row that read `installed` alone would
     *  sit at "not installed" forever while the signals actually flow. */
    status: () => Promise<{ installed: boolean; outcome?: { pluginAlsoInstalled?: boolean } }>;
    install: () => Promise<{ ok: boolean; error: string | null }>;
    /** The install prompt's durable "Don't ask again". Optional: an older
     *  preload simply never shows the re-enable line. */
    getPromptPreference?: () => Promise<{ suppressed: boolean }>;
    setPromptPreference?: (suppressed: boolean) => Promise<{ suppressed: boolean }>;
  };
  statusline?: {
    /** `outcome.targets` is what makes a partially-foreign setup visible: with
     *  two accounts, one installable and one owned by another tool, the install
     *  succeeds and the row would otherwise go green while that account still
     *  has no wmux statusline. */
    status: () => Promise<{ installed: boolean; outcome?: { targets?: StatuslineTargetProbe[] } }>;
    /** `ok` only means nothing broke: every target can be skipped when another
     *  tool owns its settings.json. A row is installed when a target took it. */
    install: (opts?: { force?: boolean }) => Promise<{
      ok: boolean;
      error: string | null;
      targets: Array<{ outcome: string }>;
    }>;
  };
  mcp?: {
    /** Registration state is `wmux.registered`. `verified` is a static property
     *  of the TARGET (we have verified that client's MCP wiring), true for
     *  Claude Code whether or not wmux is registered — reading it as install
     *  state made the row claim "installed" on an untouched config. */
    check: () => Promise<{ targets: McpTarget[] }>;
    reregister: () => Promise<{ targets: McpTarget[] }>;
  };
}

export interface StatuslineTargetProbe {
  label: string;
  state: string;
  /** The command a forced install would overwrite, when we could read it. */
  foreignCommand?: string;
}

export interface McpTarget {
  displayName: string;
  wmux?: { registered: boolean };
}

/** True when any client actually has wmux registered. */
export function mcpRegistered(targets: McpTarget[]): boolean {
  return targets.some((x) => x.wmux?.registered === true);
}

/** Why an install that "succeeded" wrote nothing: the per-target outcomes.
 *  Returns null when there is nothing to say. */
export function skippedReason(targets?: Array<{ outcome: string }>): string | null {
  if (!targets || targets.length === 0) return null;
  const skipped = [...new Set(targets.map((x) => x.outcome))].filter((o) => o !== 'installed');
  return skipped.length > 0 ? skipped.join(', ') : null;
}

/** True when a target actually took the write. `replaced` is a take too — the
 *  forced install overwrote a foreign entry, which is exactly what was asked.
 *  The predicate is shared with the CLI and the first-run wizard so the three
 *  cannot drift. */
export function installTook(targets?: Array<{ outcome: string }>): boolean {
  if (!targets) return true;
  return targets.some((x) => isInstallTake(x.outcome));
}

/** The targets another tool owns, straight from the probe. Drives both the
 *  note and the Replace affordance, so a half-installed multi-account setup
 *  says so instead of showing an unqualified green row. */
export function foreignTargets(targets?: StatuslineTargetProbe[]): StatuslineTargetProbe[] {
  return (targets ?? []).filter((t) => t.state === 'foreign');
}

/** Which skip explains an install that wrote nothing. `foreign` is the only one
 *  the user can act on from here (a forced re-install replaces it); `corrupt`
 *  needs them to fix their settings.json by hand. */
export type SkipReason = 'foreign' | 'corrupt' | 'no-backup' | 'failed' | null;

export function skipReasonOf(targets?: Array<{ outcome: string }>): SkipReason {
  if (!targets || targets.length === 0 || installTook(targets)) return null;
  // Order is by what the operator can act on. `no-backup` outranks `foreign`:
  // a replace that refused because it could not save the old entry is a
  // different situation from one that was never attempted, and clicking
  // Replace again will not fix it.
  if (targets.some((x) => x.outcome === 'skipped-no-backup')) return 'no-backup';
  if (targets.some((x) => x.outcome === 'failed')) return 'failed';
  if (targets.some((x) => x.outcome === 'skipped-foreign')) return 'foreign';
  if (targets.some((x) => x.outcome === 'skipped-corrupt')) return 'corrupt';
  return null;
}

/** Arbitrary text out of someone else's settings.json, on its way into a row
 *  that has to stay one line. Newlines and control characters are stripped and
 *  the rest is capped — an unbounded command pushed the Replace button off
 *  screen, which is the one control the message is telling them to use. */
const FOREIGN_COMMAND_MAX = 120;

export function displayCommand(command: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = command.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > FOREIGN_COMMAND_MAX ? `${flat.slice(0, FOREIGN_COMMAND_MAX)}…` : flat;
}

/** Every command a Replace would overwrite, not just the first. One click
 *  forces ALL foreign targets, so showing one of three names made the other
 *  two disappear without the operator ever seeing them. */
export function foreignCommandSuffix(targets?: StatuslineTargetProbe[]): string {
  const cmds = (targets ?? [])
    .map((x) => x.foreignCommand)
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .map(displayCommand)
    .filter((c) => c.length > 0);
  return cmds.length > 0 ? ` (${cmds.join(', ')})` : '';
}

/** One row's lifecycle. `unknown` is the pre-probe state and reads as its own
 *  thing — never as "not installed", which would be a lie the user acts on. */
export type RowState =
  | 'unknown'      // pre-probe; never rendered as "not installed"
  | 'installed'
  | 'missing'
  | 'working'
  | 'error'
  | 'unavailable'; // this preload does not expose the bridge at all

interface RowModel {
  state: RowState;
  error: string | null;
  /** Set when the install wrote nothing because another tool owns the config.
   *  Drives the plain-language line — the raw `skipped-foreign` token was a
   *  dead end for the user who saw it (#1102). */
  skip?: SkipReason;
  /** Configs another tool owns, from the last probe. Present even on an
   *  `installed` row: that is the partially-foreign case. */
  foreign?: StatuslineTargetProbe[];
}

const INITIAL: RowModel = { state: 'unknown', error: null };
const UNAVAILABLE: RowModel = { state: 'unavailable', error: null };

/** Probe → row state. Kept separate so the mapping is testable without a DOM. */
export function rowStateFromProbe(installed: boolean): RowState {
  return installed ? 'installed' : 'missing';
}

/** The standing note for a row whose install partly landed: which profiles are
 *  still on someone else's statusline, and what that statusline is. */
function foreignNote(
  t: (key: string, vars?: Record<string, string | number>) => string,
  targets?: StatuslineTargetProbe[],
): string | null {
  if (!targets || targets.length === 0) return null;
  // Separate keys rather than "profile(s)": the rest of this card is written
  // for a person to read, and the parenthesised plural was the one place that
  // read like a placeholder.
  const key =
    targets.length === 1
      ? 'integrationSetup.statusline.foreignProfilesOne'
      : 'integrationSetup.statusline.foreignProfilesMany';
  return (
    t(key, { count: targets.length, labels: targets.map((x) => x.label).join(', ') }) +
    foreignCommandSuffix(targets)
  );
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
  // The install prompt's durable refusal. `null` means "no answer to show" —
  // either the preload is too old to have it, or the probe failed. Only a
  // definite `true` renders the re-enable line, so a hiccup never invents a
  // control for a preference the user may not have set.
  const [promptSuppressed, setPromptSuppressed] = useState<boolean | null>(null);

  // Every write below lands after an await, and the settings panel is a tab the
  // user closes mid-probe. Without this the card sets state on an unmounted
  // component — and an install that resolves after a close would try to paint a
  // row that no longer exists.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Probes are fire-and-forget and the card re-probes after every install, so
  // two answers for the same row can be in flight at once. Each write carries
  // the generation it was issued under; a stale one is dropped rather than
  // repainting "not installed" over a finished install — which would put the
  // Install button back and invite a second write to the same config.
  const genRef = useRef(0);
  // The preference has its own counter. "Ask again" must invalidate a pref
  // probe still in flight (or a slow read repaints the cleared line), but it
  // must NOT invalidate row commits: a bump of the shared counter here would
  // drop an in-flight install's `error` commit, stranding that row on its
  // spinner with nothing left to re-issue it. Two domains, two generations.
  const prefGenRef = useRef(0);
  // An updater form matters on the failure path: a skipped install does not
  // re-probe, and a flat model would drop the foreign detail the probe already
  // fetched — leaving the message with no command to name.
  const commit = useCallback(
    (
      set: React.Dispatch<React.SetStateAction<RowModel>>,
      model: RowModel | ((prev: RowModel) => RowModel),
      gen: number,
    ) => {
      if (!mountedRef.current || gen !== genRef.current) return;
      set(model);
    },
    [],
  );

  // A probe that throws leaves the row `unknown` rather than claiming "missing":
  // an install button offered because IPC hiccuped would write to a config the
  // user never asked to touch.
  const probeAll = useCallback(() => {
    const gen = ++genRef.current;
    if (!api.hooks) commit(setHooks, UNAVAILABLE, gen);
    else api.hooks
      .status()
      .then((s) =>
        commit(setHooks, {
          // Plugin-owned hooks fire the same signals, and an install against
          // them writes nothing — without this the row sits at "not installed"
          // forever while an Install click reports success and changes nothing.
          state: rowStateFromProbe(s.installed || s.outcome?.pluginAlsoInstalled === true),
          error: null,
        }, gen),
      )
      .catch(() => commit(setHooks, INITIAL, gen));
    // Probed with the rows but kept OUT of RowModel: it is not an install
    // state, and folding it into the hooks row would make a suppressed prompt
    // read as a broken install.
    // Generation-guarded like the rows, on its own counter: "Ask again" bumps
    // it, so a probe still in flight when it lands cannot repaint the stale
    // `true` and bring the line back after the user cleared it.
    const prefGen = ++prefGenRef.current;
    const commitPref = (v: boolean | null) => {
      if (!mountedRef.current || prefGen !== prefGenRef.current) return;
      setPromptSuppressed(v);
    };
    if (!api.hooks?.getPromptPreference) commitPref(null);
    else api.hooks
      .getPromptPreference()
      .then((pref) => commitPref(pref.suppressed))
      .catch(() => commitPref(null));
    if (!api.statusline) commit(setStatusline, UNAVAILABLE, gen);
    else api.statusline
      .status()
      .then((s) =>
        commit(setStatusline, {
          state: rowStateFromProbe(s.installed),
          error: null,
          foreign: foreignTargets(s.outcome?.targets),
        }, gen),
      )
      .catch(() => commit(setStatusline, INITIAL, gen));
    if (!api.mcp) commit(setMcp, UNAVAILABLE, gen);
    else api.mcp
      .check()
      .then((s) => commit(setMcp, { state: rowStateFromProbe(mcpRegistered(s.targets)), error: null }, gen))
      .catch(() => commit(setMcp, INITIAL, gen));
  }, [api, commit]);

  useEffect(() => { probeAll(); }, [probeAll]);

  const runInstall = useCallback(
    async (
      set: React.Dispatch<React.SetStateAction<RowModel>>,
      install: () => Promise<{
        ok: boolean;
        error: string | null;
        targets?: Array<{ outcome: string }>;
      }>,
    ) => {
      const gen = ++genRef.current;
      // Carry the probe's foreign detail across the in-flight state: a flat
      // model here dropped it, and the skip message that follows then had no
      // command to name.
      commit(set, (prev) => ({ state: 'working', error: null, foreign: prev.foreign }), gen);
      try {
        const outcome = await install();
        // When the install reports per-target outcomes, `ok` alone is not
        // success: every target can be skipped because another tool owns its
        // settings.json, and claiming "Installed" there is a receipt for
        // something that did not happen. The skipped outcomes ARE the reason,
        // so they go into the error text — otherwise the user retries blindly.
        const took = installTook(outcome.targets);
        if (outcome.ok && took) {
          // Re-probe rather than trusting the install's own word: the file is
          // the truth, and it can have been rewritten by another tool between
          // the write and this line.
          probeAll();
          return;
        }
        commit(
          set,
          (prev) => ({
            state: 'error',
            error: outcome.error ?? skippedReason(outcome.targets),
            skip: skipReasonOf(outcome.targets),
            foreign: prev.foreign,
          }),
          gen,
        );
      } catch (err) {
        // Updater, like the paths above: a thrown install that dropped the
        // probe's foreign detail took the Replace button with it and left the
        // exact dead end this whole change is about.
        commit(
          set,
          // `skip` is cleared, `foreign` is kept: the reason a PREVIOUS install
          // wrote nothing does not describe this throw, and leaving it set made
          // the row explain a foreign skip while the real failure went unsaid.
          (prev) => ({
            ...prev,
            state: 'error',
            skip: null,
            error: err instanceof Error ? err.message : null,
          }),
          gen,
        );
      }
    },
    [commit, probeAll],
  );

  // MCP's register path answers with a status payload, not an ok/error pair, so
  // it reads its own result rather than sharing runInstall.
  const registerMcp = useCallback(async () => {
    if (!api.mcp) return;
    const gen = ++genRef.current;
    commit(setMcp, { state: 'working', error: null }, gen);
    try {
      const status = await api.mcp.reregister();
      if (mcpRegistered(status.targets)) {
        probeAll();
        return;
      }
      // Nothing took. Name the configs that did not, so the failure is
      // actionable instead of a bare "Failed".
      commit(setMcp, { state: 'error', error: status.targets.map((x) => x.displayName).join(', ') || null }, gen);
    } catch (err) {
      commit(setMcp, { state: 'error', error: err instanceof Error ? err.message : null }, gen);
    }
  }, [api, commit, probeAll]);

  // Clearing the durable refusal. Optimism is wrong here: report what the
  // write actually resolved to, so a failed clear does not hide the line the
  // user would otherwise click again.
  const reenablePrompt = useCallback(() => {
    if (!api.hooks?.setPromptPreference) return;
    const prefGen = ++prefGenRef.current;
    void api.hooks
      .setPromptPreference(false)
      .then((pref) => {
        if (!mountedRef.current || prefGen !== prefGenRef.current) return;
        setPromptSuppressed(pref.suppressed);
      })
      .catch(() => { /* leave the line up: the refusal is still in force */ });
  }, [api]);

  return (
    <div
      className="rounded-[7px] p-4 flex flex-col gap-3"
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
        onAction={() => { if (api.hooks) void runInstall(setHooks, api.hooks.install); }}
      />
      {promptSuppressed === true && (
        <div
          className="flex items-center justify-between gap-2 text-xs text-[color:var(--text-muted)] -mt-1 pl-1"
          data-hooks-prompt-suppressed
        >
          <span>{t('integrationSetup.hooks.promptSuppressed')}</span>
          <button
            type="button"
            data-hooks-prompt-reenable
            onClick={reenablePrompt}
            className="px-2 py-0.5 rounded text-[color:var(--text-sub)] hover:text-[color:var(--text-main)] underline"
          >
            {t('integrationSetup.hooks.promptReenable')}
          </button>
        </div>
      )}
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
        onAction={() => {
          const sl = api.statusline;
          if (sl) void runInstall(setStatusline, () => sl.install());
        }}
        // Offered whenever the probe knows another tool owns a config — which
        // includes the row that already says "installed" because a DIFFERENT
        // account took the write. The overwrite still costs a deliberate click
        // on a button that names what it replaces.
        note={foreignNote(t, statusline.foreign)}
        secondaryLabel={
          (statusline.foreign?.length ?? 0) > 0 || statusline.skip === 'foreign'
            ? t('integrationSetup.replaceButton')
            : null
        }
        onSecondary={() => {
          const sl = api.statusline;
          if (sl) void runInstall(setStatusline, () => sl.install({ force: true }));
        }}
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
  note = null,
  secondaryLabel = null,
  onSecondary,
}: {
  id: string;
  required: boolean;
  title: string;
  description: string;
  model: RowModel;
  actionLabel: string;
  onAction: () => void;
  /** Muted standing fact about the row, shown even when it is installed. Not
   *  an error: a partially-foreign setup is a working install with a caveat. */
  note?: string | null;
  secondaryLabel?: string | null;
  onSecondary?: () => void;
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
            style={{ color: 'var(--accent-red)' }}
            data-setup-row-error
          >
            {/* A skip is not a crash: it says what wmux chose not to touch and
                what to do about it, in words. Printing the raw outcome token
                (`skipped-foreign`) told the user nothing they could act on. */}
            {model.skip === 'foreign'
              ? `${t('integrationSetup.skippedForeign')}${foreignCommandSuffix(model.foreign)}`
              : model.skip === 'no-backup'
                ? t('integrationSetup.skippedNoBackup')
                : model.skip === 'failed'
                  ? t('integrationSetup.installFailedTarget')
                  : model.skip === 'corrupt'
                    ? t('integrationSetup.skippedCorrupt')
                    : `${t('integrationSetup.installFailed')}${model.error ? ` (${model.error})` : ''}`}
          </span>
        )}
        {/* A note and an error never both apply: the error already carries the
            same fact in stronger words. */}
        {note && model.state !== 'error' && (
          // Set apart from the description above it: this is a fact about the
          // operator's own machine, and butted straight against the static copy
          // it read as a third sentence of it. Spacing only — the color grammar
          // reserves the accent for alive/focus, and a note is neither.
          <span className="text-[11px] text-[color:var(--text-muted)] mt-1" data-setup-row-note>
            {note}
          </span>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <StateChip state={model.state} />
        {/* Nothing to click for a row we cannot act on: `unknown` has not been
            probed, and `unavailable` has no bridge to install through. */}
        {secondaryLabel && onSecondary && !working && (
          <button
            type="button"
            onClick={onSecondary}
            data-setup-row-secondary
            className="text-[11px] font-mono px-2.5 py-1 rounded-md transition-colors"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--bg-overlay)',
              cursor: 'pointer',
            }}
          >
            {secondaryLabel}
          </button>
        )}
        {!installed && model.state !== 'unknown' && model.state !== 'unavailable' && (
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
    // Without its own label an error row read "not installed" right next to the
    // failure text it had just printed — two answers to the same question.
    : state === 'error' ? t('integrationSetup.state.error')
    : state === 'unavailable' ? t('integrationSetup.state.unavailable')
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

/** Container: binds whichever preload bridges exist. A missing one costs its own
 *  row (rendered `unavailable`), never the card — hiding the two REQUIRED
 *  integrations because the optional statusline bridge was absent is exactly
 *  the disappearing-surface bug this card was built to end. Renders nothing only
 *  when no bridge is exposed at all (pure jsdom parent tests / no preload). */
export function IntegrationSetupSectionContainer(): React.ReactElement | null {
  const electronAPI = (window as unknown as {
    electronAPI?: {
      deck?: {
        hooksBridge?: IntegrationSetupApi['hooks'];
        statuslineBridge?: IntegrationSetupApi['statusline'];
      };
      mcp?: IntegrationSetupApi['mcp'];
    };
  }).electronAPI;
  const hooks = electronAPI?.deck?.hooksBridge;
  const statusline = electronAPI?.deck?.statuslineBridge;
  const mcp = electronAPI?.mcp;
  // Stable identity: the card's probe effect keys off this object, and a fresh
  // literal every render re-probed all three bridges on every parent render —
  // and could land a stale answer on top of a finished install.
  const api = useMemo(() => ({ hooks, statusline, mcp }), [hooks, statusline, mcp]);
  if (!hooks && !statusline && !mcp) return null;
  return <IntegrationSetupSection api={api} />;
}
