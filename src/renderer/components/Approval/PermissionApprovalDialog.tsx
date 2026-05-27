// Permission approval dialog (Phase 2.2 pre-commit 5).
//
// Stateless presentational component. The parsed prompt data + click
// handlers are passed as props so:
//   - The component can be rendered by the store-wired container that
//     Pre-commit 6 will ship (subscribes to `pendingPermissionApproval`).
//   - Tests render it via `renderToStaticMarkup` without needing a DOM
//     library — the wording-asymmetry checks the Phase 2.2 risk-class
//     copy table is intact.
//
// Layout mirrors `A2a/ExecuteApprovalDialog.tsx`: a centered modal with
// risk-class grouping, per-group color treatment, and Approve/Deny on the
// right rail. The risk-class severity drives the accent color so the
// terminal-content / terminal-input asymmetry (plan D5) is immediately
// visible — "can label your panes" sits in neutral grey, "can read what's
// on your screen" sits in warning red.

import {
  CAPABILITY_RISK_CLASS,
  RISK_CLASS_COPY,
  type RiskClass,
  type RiskClassCopy,
} from '../../../main/mcp/methodCapabilityMap';
import { parsePermission } from '../../../main/mcp/permissionGrammar';

export interface PermissionApprovalDialogProps {
  /** Plugin name (e.g. `claude-ai`, `my-org.my-tool`). */
  clientName: string;
  /**
   * Permission strings as the plugin declared them (e.g.
   * `meta.write:custom.dash.*`). Parsed for display; unknown grammar
   * entries fall through with a neutral classification rather than
   * crashing the dialog.
   */
  declaredCapabilities: readonly string[];
  /** Optional reason text from the plugin's mcp.declarePermissions call. */
  rationale?: string;
  /** Called when the user clicks Approve. */
  onApprove: () => void;
  /** Called when the user clicks Deny. */
  onDeny: () => void;
}

/**
 * One row in the dialog's grouped capability list. Exported so tests can
 * verify the grouping logic separately from the render.
 */
export interface CapabilityGroup {
  riskClass: RiskClass;
  copy: RiskClassCopy;
  capabilities: { raw: string; capability: string; pathGlob?: string }[];
}

/**
 * Group declared capabilities by risk class. Order of groups follows
 * `GROUP_RENDER_ORDER` so critical items always appear first regardless of
 * declaration order in the wire payload.
 */
const GROUP_RENDER_ORDER: RiskClass[] = [
  'terminal-content',
  'terminal-input',
  'browser',
  'a2a',
  'metadata',
  'events',
  'pane-lifecycle',
  'workspace',
  'internal',
];

export function groupCapabilities(
  declared: readonly string[],
): CapabilityGroup[] {
  const groups = new Map<RiskClass, CapabilityGroup>();
  for (const raw of declared) {
    const parsed = parsePermission(raw);
    if (!parsed.ok) continue; // skip malformed; substrate already rejected at declare-time
    const cap = parsed.permission.capability;
    const risk =
      CAPABILITY_RISK_CLASS[cap] ?? ('metadata' as RiskClass); // safe fallback
    let group = groups.get(risk);
    if (!group) {
      group = {
        riskClass: risk,
        copy: RISK_CLASS_COPY[risk],
        capabilities: [],
      };
      groups.set(risk, group);
    }
    group.capabilities.push({
      raw,
      capability: cap,
      pathGlob: parsed.permission.pathGlob,
    });
  }
  return GROUP_RENDER_ORDER.filter((r) => groups.has(r)).map(
    (r) => groups.get(r) as CapabilityGroup,
  );
}

function severityAccent(severity: RiskClassCopy['severity']): string {
  switch (severity) {
    case 'critical':
      return 'var(--accent-red)';
    case 'caution':
      return 'var(--accent-yellow)';
    case 'neutral':
      return 'var(--text-subtle)';
  }
}

/**
 * Pure presentational dialog. The store-wired container in Pre-commit 6
 * wraps this with `useStore` / IPC bindings.
 */
export function PermissionApprovalDialogView(
  props: PermissionApprovalDialogProps,
) {
  const groups = groupCapabilities(props.declaredCapabilities);
  const hasCritical = groups.some((g) => g.copy.severity === 'critical');
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}
      role="alertdialog"
      aria-labelledby="permission-approval-title"
    >
      <div
        className="flex flex-col gap-4 p-5 rounded-xl"
        style={{
          width: 540,
          maxWidth: '92vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          backgroundColor: 'var(--bg-base)',
          border: `1px solid ${hasCritical ? 'var(--accent-red)' : 'var(--accent-yellow)'}`,
          boxShadow: '0 25px 60px rgba(0,0,0,0.75)',
        }}
      >
        <div className="flex items-center gap-2">
          <span
            style={{
              color: hasCritical ? 'var(--accent-red)' : 'var(--accent-yellow)',
              fontSize: 18,
            }}
          >
            {hasCritical ? '⚠' : '⚠'}
          </span>
          <p
            id="permission-approval-title"
            className="text-sm font-semibold font-mono"
            style={{ color: 'var(--text-main)' }}
          >
            Plugin requesting permissions
          </p>
        </div>

        <div className="text-xs font-mono" style={{ color: 'var(--text-sub)' }}>
          <span style={{ color: 'var(--text-subtle)' }}>plugin:</span>{' '}
          <span style={{ color: 'var(--text-main)' }}>{props.clientName}</span>
        </div>

        {props.rationale ? (
          <div
            className="text-xs p-3 rounded-md italic"
            style={{
              backgroundColor: 'var(--bg-mantle)',
              color: 'var(--text-sub2)',
            }}
          >
            "{props.rationale}"
          </div>
        ) : null}

        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div
              key={group.riskClass}
              className="flex flex-col gap-1 p-3 rounded-md"
              style={{
                backgroundColor: 'var(--bg-surface)',
                borderLeft: `3px solid ${severityAccent(group.copy.severity)}`,
              }}
            >
              <div
                className="text-xs font-semibold"
                style={{
                  color:
                    group.copy.severity === 'critical'
                      ? 'var(--accent-red)'
                      : group.copy.severity === 'caution'
                        ? 'var(--accent-yellow)'
                        : 'var(--text-main)',
                  fontWeight: group.copy.severity === 'critical' ? 700 : 600,
                }}
              >
                {group.copy.summary}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-sub)' }}>
                {group.copy.detail}
              </div>
              <ul
                className="text-[11px] font-mono mt-1"
                style={{ color: 'var(--text-sub2)' }}
              >
                {group.capabilities.map((cap, idx) => (
                  <li key={`${cap.raw}-${idx}`}>· {cap.raw}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={props.onDeny}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              backgroundColor: 'var(--bg-surface)',
              color: 'var(--text-subtle)',
            }}
          >
            Deny
          </button>
          <button
            onClick={props.onApprove}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{
              backgroundColor: hasCritical
                ? 'var(--accent-red)'
                : 'var(--accent-yellow)',
              color: 'var(--bg-base)',
            }}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
