import { useState } from 'react';
import { useStore } from '../../../renderer/stores';
import { spawnCompany, spawnMember, destroyCompanyWithCleanup } from '../provisioner';
import CreateCompanyDialog, { type CompanyTemplateResult } from './CreateCompanyDialog';
import CompanyMemberItem from './CompanyMemberItem';
import AddMemberDialog from './AddMemberDialog';
import { hasSoul } from '../../core/SoulLoader';

/* ── tiny icons ────────────────────────────────────────────────────────────── */

const Ix = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
const Iplus = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><line x1="5" y1="1" x2="5" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
const Itrash = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V2a.5.5 0 01.5-.5h2a.5.5 0 01.5.5v1M3 3l.5 7a1 1 0 001 1h3a1 1 0 001-1L9 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/* ═══════════════════════════════════════════════════════════════════════════════
   MANAGE VIEW
   ═══════════════════════════════════════════════════════════════════════════════ */

function ManageView({ onClose }: { onClose: () => void }) {
  const company = useStore((s) => s.company);
  const messageQueue = useStore((s) => s.messageQueue);
  const [addingDept, setAddingDept] = useState(false);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  if (!company) return null;

  const total = company.departments.reduce((s, d) => s + d.members.length, 0);
  const prov = company.departments.reduce((s, d) => s + d.members.filter((m) => m.workspaceId && m.ptyId).length, 0);

  const pendingCounts: Record<string, number> = {};
  for (const m of messageQueue) {
    if (!m.delivered) pendingCounts[m.targetMemberId] = (pendingCounts[m.targetMemberId] ?? 0) + 1;
  }

  const handleAddMember = async (deptId: string, deptName: string, name: string, preset: string, customPath?: string) => {
    useStore.getState().addMember(deptId, name, preset as import('../../types').AgentPreset, customPath);
    setAddingTo(null);

    // Spawn the new member immediately
    const dept = useStore.getState().company?.departments.find((d) => d.id === deptId);
    const lead = dept?.members.find((m) => m.id === dept?.leadId);
    const { workspaceId, ptyId } = await spawnMember(
      company.name, deptName, lead?.name || 'Lead', name, preset,
      company.skipPermissions || false, company.workDir,
    );
    const member = useStore.getState().company?.departments.find((d) => d.id === deptId)?.members.find((m) => m.name === name);
    if (member) {
      useStore.getState().setMemberWorkspace(member.id, workspaceId);
      useStore.getState().setMemberPty(member.id, ptyId);
    }
  };

  const handleDestroy = async () => {
    if (!confirm('Destroy company and all teams?')) return;
    // M6 TODOS #4 — await dispose Promise.all before unmounting so the
    // store does not flip to company === null while async dispose
    // handlers still reference it.
    await destroyCompanyWithCleanup();
    onClose();
  };

  return (
    <>
      {/* header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-base font-mono font-bold" style={{ color: 'var(--text-main)' }}>{company.name}</div>
          <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            {company.departments.length} departments &middot; {prov}/{total} provisioned
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={handleDestroy}
            className="px-3 py-1.5 rounded-lg text-[10px] font-mono transition-all hover:bg-[rgba(243,139,168,0.1)]"
            style={{ color: 'var(--accent-red)', border: '1px solid var(--accent-red)' }}>
            Destroy
          </button>
        </div>
      </div>

      {/* ── Org Chart ── */}
      <div className="flex-1 overflow-y-auto -mx-5 px-5" style={{ maxHeight: 420 }}>

        {/* CEO node at top */}
        <div className="flex flex-col items-center mb-3">
          <div
            className="px-4 py-1.5 rounded-lg text-[11px] font-mono font-bold flex items-center gap-2"
            style={{
              backgroundColor: 'var(--bg-mantle)',
              color: 'var(--accent-yellow)',
              border: '1px solid var(--accent-yellow)',
            }}
          >
            <span>{'\u2605'}</span>
            <span>CEO</span>
            <span
              className="text-[9px] font-normal ml-1"
              style={{ color: 'var(--text-muted)' }}
            >
              {company.ceoWorkspaceId ? 'Active' : 'Idle'}
            </span>
          </div>
          {/* Connector line from CEO down */}
          {company.departments.length > 0 && (
            <div
              style={{
                width: 1,
                height: 16,
                backgroundColor: 'var(--bg-overlay)',
              }}
            />
          )}
        </div>

        {/* Horizontal connector bar */}
        {company.departments.length > 1 && (
          <div className="flex justify-center mb-0">
            <div
              style={{
                height: 1,
                backgroundColor: 'var(--bg-overlay)',
                width: `${Math.min(company.departments.length * 120, 440)}px`,
                maxWidth: '90%',
              }}
            />
          </div>
        )}

        {/* Department cards */}
        <div className="space-y-2 mt-2">
          {company.departments.map((dept) => {
            const lead = dept.members.find((m) => m.id === dept.leadId);
            const others = dept.members.filter((m) => m.id !== dept.leadId);
            const activeCount = dept.members.filter((m) => m.status === 'running' || m.status === 'waiting').length;

            return (
              <div key={dept.id} className="rounded-lg overflow-hidden"
                style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}>

                {/* Dept header */}
                <div className="flex items-center justify-between px-4 py-2"
                  style={{ borderBottom: '1px solid var(--bg-surface)' }}>
                  <div className="flex items-center gap-2">
                    {/* Vertical connector dot */}
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: 'var(--accent-blue)', opacity: 0.6 }}
                    />
                    <span className="text-[12px] font-mono font-bold" style={{ color: 'var(--text-main)' }}>
                      {dept.name}
                    </span>
                    <span
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: activeCount > 0 ? 'rgba(137, 180, 250, 0.1)' : 'var(--bg-surface)',
                        color: activeCount > 0 ? 'var(--accent-blue)' : 'var(--text-muted)',
                      }}
                    >
                      {activeCount}/{dept.members.length} active
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setAddingTo(addingTo === dept.id ? null : dept.id)}
                      className="flex items-center gap-0.5 px-2 py-1 rounded-md text-[9px] font-mono transition-colors hover:bg-[rgba(166,227,161,0.08)]"
                      style={{ color: 'var(--accent-green)' }}>
                      <Iplus />add
                    </button>
                    <button onClick={() => useStore.getState().removeDepartment(dept.id)}
                      className="p-1 rounded-md hover:bg-[rgba(243,139,168,0.08)] transition-colors"
                      style={{ color: 'var(--accent-red)' }}><Itrash /></button>
                  </div>
                </div>

                {/* Members */}
                <div className="py-0.5">
                  {lead && <CompanyMemberItem member={lead} isLead pendingMessageCount={pendingCounts[lead.id] ?? 0} />}
                  {others.map((m) => (
                    <CompanyMemberItem key={m.id} member={m} isLead={false} pendingMessageCount={pendingCounts[m.id] ?? 0} />
                  ))}
                </div>

                {addingTo === dept.id && (
                  <AddMemberDialog
                    deptName={dept.name}
                    onConfirm={(name, preset, customPath) => handleAddMember(dept.id, dept.name, name, preset, customPath)}
                    onCancel={() => setAddingTo(null)}
                  />
                )}
              </div>
            );
          })}

          {addingDept ? (
            <AddDeptRow onAdd={(n, l) => { useStore.getState().addDepartment(n, l); setAddingDept(false); }}
              onCancel={() => setAddingDept(false)} />
          ) : (
            <button onClick={() => setAddingDept(true)}
              className="w-full flex items-center justify-center gap-1.5 py-3 rounded-lg text-[10px] font-mono transition-all hover:border-[var(--accent-blue)] hover:text-[var(--accent-blue)]"
              style={{ color: 'var(--text-muted)', border: '1px dashed var(--bg-overlay)' }}>
              <Iplus /> Add Department
            </button>
          )}
        </div>
      </div>

      {/* footer */}
      <div className="flex items-center justify-between pt-3 mt-3 text-[9px] font-mono"
        style={{ borderTop: '1px solid var(--bg-surface)', color: 'var(--text-muted)' }}>
        <span>CEO: {company.ceoWorkspaceId ? 'assigned' : '-'}</span>
        <button onClick={onClose} className="hover:underline" style={{ color: 'var(--accent-blue)' }}>Close</button>
      </div>
    </>
  );
}

/* ── add dept row ──────────────────────────────────────────────────────────── */

function AddDeptRow({ onAdd, onCancel }: { onAdd: (n: string, l: string) => void; onCancel: () => void }) {
  const [n, setN] = useState('');
  const [l, setL] = useState('');
  const ok = !!(n.trim() && l.trim());
  const go = () => { if (ok) onAdd(n.trim(), l.trim()); };
  return (
    <div className="flex items-center gap-1.5 p-2 rounded-lg"
      style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}>
      <input value={n} onChange={(e) => setN(e.target.value)} placeholder="Dept" autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onCancel(); }}
        className="flex-1 px-2 py-1 rounded text-[10px] font-mono focus:outline-none"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)' }} />
      <input value={l} onChange={(e) => setL(e.target.value)} placeholder="Lead"
        onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onCancel(); }}
        className="w-24 px-2 py-1 rounded text-[10px] font-mono focus:outline-none"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-main)' }} />
      <button onClick={go} className="px-2 py-1 rounded text-[9px] font-mono font-bold hover:opacity-90"
        style={{ backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)', opacity: ok ? 1 : 0.3 }}>Add</button>
      <button onClick={onCancel} style={{ color: 'var(--text-muted)' }}><Ix /></button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ROOT
   ═══════════════════════════════════════════════════════════════════════════════ */

interface CompanyViewProps { onClose: () => void; }

export default function CompanyView({ onClose }: CompanyViewProps) {
  const hasCompany = useStore((s) => s.company !== null);
  const handleConfirm = (result: CompanyTemplateResult) => {
    const g = useStore.getState;

    // 1. Create company
    g().createCompany(result.name, result.skipPermissions, result.workDir || undefined);

    // 2. Populate departments + members in store BEFORE anything else
    for (const d of result.template.departments) {
      g().addDepartment(d.name, d.leadName, d.leadPreset);
      const co = g().company;
      if (!co) continue;
      const dept = co.departments.find((dep) => dep.name === d.name);
      if (!dept) continue;
      for (const m of d.members) {
        g().addMember(dept.id, m.name, m.preset as import('../../types').AgentPreset, m.customAgentPath);
      }
    }

    // 3. Close dialog (sidebar now shows full org chart)
    onClose();

    // 4. Spawn agents in background (store already populated)
    spawnCompany({
      companyName: result.name,
      skipPermissions: result.skipPermissions,
      workDir: result.workDir,
      departments: result.template.departments.map((d) => ({
        name: d.name,
        leadName: d.leadName,
        members: d.members.map((m) => ({ name: m.name, preset: m.preset, customAgentPath: m.customAgentPath })),
      })),
    }).catch((err) => console.error('Company spawn error:', err));
  };

  if (!hasCompany) {
    return (
      <CreateCompanyDialog
        onConfirm={handleConfirm}
        onCancel={onClose}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxHeight: 'calc(100vh - 80px)',
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          borderRadius: 12,
          padding: '24px 28px',
          boxShadow: '0 25px 60px rgba(0,0,0,0.7)',
        }}
      >
        <ManageView onClose={onClose} />
      </div>
    </div>
  );
}
