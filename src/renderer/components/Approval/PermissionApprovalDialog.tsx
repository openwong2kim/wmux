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
// Layout mirrors `A2a/ExecuteApprovalDialog.tsx`: the shared ui/Dialog with
// the risk classes as one grouped list, a severity mark per row, and
// Deny/Approve in the footer. The risk-class severity drives the accent color so the
// terminal-content / terminal-input asymmetry (plan D5) is immediately
// visible — "can label your panes" sits in neutral grey, "can read what's
// on your screen" sits in warning red.

import { type RiskClassCopy } from '../../../main/mcp/methodCapabilityMap';
import { groupCapabilities } from './capabilityGrouping';
import { useT } from '../../hooks/useT';
import Dialog, { DialogBody, DialogFooter, DialogHeader } from '../ui/Dialog';
import Button from '../ui/Button';
import { IconWarning } from '../icons';
import { useActivationGuard } from './useActivationGuard';

// Re-export the grouping helpers so existing importers of these symbols from
// the dialog module keep working — the canonical home is now the pure
// `./capabilityGrouping` module (decouples non-UI consumers from this `.tsx`).
export { groupCapabilities } from './capabilityGrouping';
export type { CapabilityGroup } from './capabilityGrouping';

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
  /**
   * Headline, when the generic plugin one would be wrong. The live-Chrome tab
   * borrow prompt sends the whole question here ("Agent in workspace X wants to
   * control tab ..."), because there are no capabilities to group and the client
   * is a workspace rather than a plugin. Absent keeps the plugin wording.
   */
  title?: string;
  /** What is being asked. Absent (and 'plugin') keeps the plugin layout. */
  kind?: 'plugin' | 'browser-borrow';
  /** Called when the user clicks Approve. */
  onApprove: () => void;
  /** Called when the user clicks Deny. */
  onDeny: () => void;
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
  // useT(), not the module-level `t`: a locale change while this is on screen
  // must re-render it. The user cannot dismiss and reopen an approval prompt
  // to pick up the new language.
  const t = useT();
  const groups = groupCapabilities(props.declaredCapabilities);
  const hasCritical = groups.some((g) => g.copy.severity === 'critical');
  // The container keys this view by prompt id, so each prompt gets its own
  // guard window and no focus carried over from the one before.
  const guard = useActivationGuard(props.clientName + '\u0000' + props.declaredCapabilities.join(','));
  // It opens by itself, so it leaves focus where the user is: their next
  // Enter or Space cannot answer a prompt they have not read. There is no
  // Escape, backdrop or close button: the prompt is answered with a button.
  return (
    <Dialog
      role="alertdialog"
      onClose={props.onDeny}
      closeOnEscape={false}
      focusOnOpen="none"
      width={540}
    >
      <DialogHeader
        title={
          <span className="flex items-center gap-2">
            <span
              className="shrink-0"
              style={{ color: hasCritical ? 'var(--accent-red)' : 'var(--accent-yellow)' }}
            >
              <IconWarning size={16} />
            </span>
            {props.title ?? t('permission.pluginTitle')}
          </span>
        }
        description={
          // The label names WHAT is asking. A borrow prompt is a workspace's
          // agent, not a plugin, and calling it one would misattribute the
          // request.
          <>
            {t(props.kind === 'browser-borrow' ? 'permission.workspaceLabel' : 'permission.pluginLabel')}{' '}
            <span className="font-mono text-[12px] text-[var(--text-main)]">{props.clientName}</span>
          </>
        }
      />
      <DialogBody className="!gap-3">
        {props.rationale ? (
          <div className="ui-group px-3.5 py-3 text-[13px] text-[var(--text-sub)]">
            "{props.rationale}"
          </div>
        ) : null}

        {groups.length > 0 && (
          <div className="ui-group" data-permission-groups>
            {groups.map((group) => (
              <div key={group.riskClass} className="ui-row !items-start" data-severity={group.copy.severity}>
                <span className="ui-row-icon h-5" aria-hidden="true">
                  <span
                    className="block w-2 h-2 rounded-full"
                    style={{ backgroundColor: severityAccent(group.copy.severity) }}
                  />
                </span>
                <div className="ui-row-text">
                  <p
                    className="ui-row-title"
                    style={
                      group.copy.severity === 'critical'
                        ? { color: 'var(--accent-red)', fontWeight: 600 }
                        : group.copy.severity === 'caution'
                          ? { color: 'var(--accent-yellow)' }
                          : undefined
                    }
                  >
                    {group.copy.summary}
                  </p>
                  <p className="ui-row-detail">{group.copy.detail}</p>
                  <ul className="m-0 mt-1 p-0 list-none flex flex-wrap gap-1">
                    {group.capabilities.map((cap, idx) => (
                      <li key={`${cap.raw}-${idx}`} className="ui-code">
                        {cap.raw}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button size="md" variant="secondary" onClick={guard(props.onDeny)}>
          {t('approval.deny')}
        </Button>
        {/* Solid red only when the grant reaches the screen or the keyboard —
            that approval is the final confirm of a dangerous grant. */}
        <Button
          size="md"
          variant={hasCritical ? 'danger' : 'primary'}
          className={hasCritical ? 'gap-1.5' : undefined}
          onClick={guard(props.onApprove)}
        >
          {/* Severity is not colour alone: in themes whose accent is red, the
              danger and primary fills look alike. */}
          {hasCritical && <IconWarning size={12} />}
          {t('approval.approve')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
