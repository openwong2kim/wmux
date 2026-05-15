import { useState } from 'react';
import { useStore } from '../../stores';
import type { Department, TeamMember } from '../../../shared/types';
import CompanyMemberItem from '../../../company/renderer/components/CompanyMemberItem';
import AddMemberDialog from '../../../company/renderer/components/AddMemberDialog';
import CostDashboard from '../../../company/renderer/components/CostDashboard';
import { spawnMember, destroyCompanyWithCleanup } from '../../../company/renderer/provisioner';

// ─── Department section ──────────────────────────────────────────────────────

function DeptSection({ dept, pendingCounts }: { dept: Department; pendingCounts: Record<string, number> }) {
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const removeDepartment = useStore((s) => s.removeDepartment);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  const lead = dept.members.find((m) => m.id === dept.leadId);
  const others = dept.members.filter((m) => m.id !== dept.leadId);
  const activeCount = dept.members.filter((m) => m.status === 'running' || m.status === 'waiting').length;

  const handleSelect = (member: TeamMember) => {
    if (member.workspaceId) {
      setActiveWorkspace(member.workspaceId);
    }
  };

  return (
    <div className="mb-1">
      {/* Dept header */}
      <div
        className="flex items-center justify-between px-3 py-1 cursor-pointer select-none group"
        onContextMenu={(e) => { e.preventDefault(); setConfirmDelete(true); }}
        title="Right-click to remove"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>{'├─'}</span>
          <span className="text-[11px] font-mono font-semibold truncate" style={{ color: 'var(--text-main)' }}>
            {dept.name}
          </span>
          <span className="text-[9px] font-mono" style={{ color: 'var(--text-subtle)' }}>
            ({dept.members.length})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {activeCount > 0 && (
            <span className="text-[8px] font-mono" style={{ color: 'var(--accent-blue)' }}>Active</span>
          )}
          <button
            className="text-[10px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: 'var(--accent-green)' }}
            onClick={() => setAddMemberOpen(true)}
            title="Add member"
          >
            +
          </button>
        </div>
      </div>

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="mx-2 mb-1 px-2 py-1.5 rounded" style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid rgba(243,139,168,0.3)' }}>
          <p className="text-[9px] font-mono mb-1.5" style={{ color: 'var(--accent-red)' }}>
            Remove "{dept.name}"?
          </p>
          <div className="flex gap-1.5">
            <button
              className="flex-1 text-[9px] font-mono rounded py-0.5 transition-colors"
              style={{ backgroundColor: 'var(--accent-red)', color: 'var(--bg-base)' }}
              onClick={() => { removeDepartment(dept.id); setConfirmDelete(false); }}
            >
              Remove
            </button>
            <button
              className="flex-1 text-[9px] font-mono rounded py-0.5 transition-colors"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--text-muted)' }}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Members */}
      <div className="ml-3">
        {lead && (
          <CompanyMemberItem
            member={lead}
            isLead
            pendingMessageCount={pendingCounts[lead.id] ?? 0}
            onSelect={() => handleSelect(lead)}
          />
        )}
        {others.map((m) => (
          <CompanyMemberItem
            key={m.id}
            member={m}
            isLead={false}
            pendingMessageCount={pendingCounts[m.id] ?? 0}
            onSelect={() => handleSelect(m)}
          />
        ))}
      </div>

      {/* Add member dialog */}
      {addMemberOpen && (
        <AddMemberDialog
          deptName={dept.name}
          onConfirm={async (name, preset, customPath) => {
            try {
              const s = useStore.getState();
              const company = s.company;
              if (!company) return;
              s.addMember(dept.id, name, preset, customPath);
              setAddMemberOpen(false);

              const lead = dept.members.find((m) => m.id === dept.leadId);
              const { workspaceId, ptyId } = await spawnMember(
                company.name, dept.name, lead?.name || 'Lead', name, preset,
                company.skipPermissions || false, company.workDir,
              );
              const member = useStore.getState().company?.departments
                .find((d) => d.id === dept.id)?.members.find((m) => m.name === name);
              if (member) {
                useStore.getState().setMemberWorkspace(member.id, workspaceId);
                useStore.getState().setMemberPty(member.id, ptyId);
              }
            } catch (err) {
              console.error('Failed to spawn member:', err);
            }
          }}
          onCancel={() => setAddMemberOpen(false)}
        />
      )}
    </div>
  );
}

// ─── CEO row ─────────────────────────────────────────────────────────────────

function CeoRow({ ceoWorkspaceId }: { ceoWorkspaceId?: string }) {
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === ceoWorkspaceId));
  const isProvisioned = !!ceoWorkspaceId && !!workspace;

  return (
    <button
      className="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors"
      style={{ backgroundColor: 'transparent' }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-surface)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      onClick={() => {
        if (isProvisioned) {
          setActiveWorkspace(ceoWorkspaceId);
            }
      }}
      disabled={!isProvisioned}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: isProvisioned ? 'var(--accent-green)' : 'var(--text-muted)' }}
      />
      <span className="text-[11px] font-mono font-semibold" style={{ color: 'var(--text-main)' }}>
        CEO
      </span>
      <span className="ml-auto text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>
        {isProvisioned ? 'Active' : 'Idle'}
      </span>
    </button>
  );
}

// ─── Main CompanyPanel ───────────────────────────────────────────────────────

export default function CompanyPanel() {
  const company = useStore((s) => s.company);
  const setCompanyViewVisible = useStore((s) => s.setCompanyViewVisible);
  const messageQueue = useStore((s) => s.messageQueue);

  // Pending message counts
  const pendingCounts: Record<string, number> = {};
  for (const msg of messageQueue) {
    if (!msg.delivered) {
      pendingCounts[msg.targetMemberId] = (pendingCounts[msg.targetMemberId] ?? 0) + 1;
    }
  }

  if (!company) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 text-center gap-3">
        <p className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
          No company created yet.
        </p>
        <button
          onClick={() => setCompanyViewVisible(true)}
          className="px-4 py-1.5 text-[11px] font-mono font-bold rounded transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)' }}
        >
          Create Company
        </button>
      </div>
    );
  }

  const totalMembers = company.departments.reduce((s, d) => s + d.members.length, 0);
  const provisionedCount = company.departments.reduce(
    (s, d) => s + d.members.filter((m) => m.workspaceId && m.ptyId).length, 0,
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Scrollable area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Company header */}
        <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: '1px solid var(--bg-surface)' }}>
          <div className="min-w-0">
            <p className="text-[11px] font-mono font-semibold truncate" style={{ color: 'var(--text-main)' }}>
              {company.name}
            </p>
            <p className="text-[9px] font-mono" style={{ color: 'var(--text-muted)' }}>
              {company.departments.length} depts / {provisionedCount}/{totalMembers} active
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCompanyViewVisible(true)}
              className="text-[9px] font-mono transition-colors"
              style={{ color: 'var(--accent-blue)' }}
              title="Manage company"
            >
              Manage
            </button>
            <button
              onClick={() => {
                if (confirm('Destroy company and all teams?')) {
                  // M6 TODOS #4 — fire-and-forget the async helper here
                  // (no surrounding UI we need to flip after). The
                  // internal Promise.all on pty.dispose guards the store
                  // mutation order; React will re-render on company=null.
                  void destroyCompanyWithCleanup();
                }
              }}
              className="text-[9px] font-mono transition-colors"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-red)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
              title="Destroy company"
            >
              {'\u2715'}
            </button>
          </div>
        </div>

        {/* CEO */}
        <div className="px-1 pt-2 pb-1">
          <CeoRow ceoWorkspaceId={company.ceoWorkspaceId} />
        </div>

        {/* Departments */}
        <div className="px-1 pb-2">
          {company.departments.length === 0 && (
            <p className="text-[9px] font-mono px-2 py-1" style={{ color: 'var(--text-subtle)' }}>
              No departments yet.
            </p>
          )}
          {company.departments.map((dept) => (
            <DeptSection key={dept.id} dept={dept} pendingCounts={pendingCounts} />
          ))}
        </div>

        {/* Add dept button */}
        <div className="px-2 pb-2">
          <button
            onClick={() => setCompanyViewVisible(true)}
            className="w-full text-[11px] font-mono py-1.5 rounded-md transition-colors"
            style={{ color: 'var(--text-muted)', border: '1px dashed var(--bg-surface)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent-blue)'; e.currentTarget.style.borderColor = 'var(--accent-blue)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--bg-surface)'; }}
          >
            + Add Department
          </button>
        </div>
      </div>

      {/* Cost dashboard — fixed at bottom */}
      <div style={{ borderTop: '1px solid var(--bg-surface)' }}>
        <CostDashboard />
      </div>
    </div>
  );
}
