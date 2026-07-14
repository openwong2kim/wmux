import { useState, useRef, useEffect } from 'react';
import type { CompanyTemplate } from '../../types';
import { BUILTIN_TEMPLATES } from '../../core/builtinTemplates';
import { hasSoul } from '../../core/SoulLoader';

// ─── Extended template list ───────────────────────────────────────────────────
// BUILTIN_TEMPLATES has 3 entries (Full-Stack Team, Startup MVP, Code Review Squad).
// We augment it with Enterprise Team and Empty Company here in the dialog.

interface DialogTemplate {
  id: string;
  icon: string;
  description: string;
  template: CompanyTemplate;
}

const DIALOG_TEMPLATES: DialogTemplate[] = [
  {
    id: 'fullstack',
    icon: '\u2699\uFE0F',
    description: 'Engineering + Security — development + security audit',
    template: BUILTIN_TEMPLATES[0]!,
  },
  {
    id: 'startup',
    icon: '\uD83D\uDE80',
    description: 'Product + Design — rapid prototyping',
    template: BUILTIN_TEMPLATES[1]!,
  },
  {
    id: 'review',
    icon: '\uD83D\uDD0D',
    description: 'Review + QA — code-quality focus',
    template: BUILTIN_TEMPLATES[2]!,
  },
  {
    id: 'enterprise',
    icon: '\uD83C\uDFE2',
    description: 'Engineering + Design + QA + DevOps — large-scale project',
    template: {
      name: 'Enterprise Team',
      departments: [
        {
          name: 'Engineering',
          leadName: 'Software Architect',
          members: [
            { name: 'FE Dev', preset: 'frontend-developer' },
            { name: 'BE Dev', preset: 'backend-architect' },
            { name: 'Data Engineer', preset: 'data-engineer' },
          ],
        },
        {
          name: 'Design',
          leadName: 'UX Architect',
          members: [
            { name: 'UI Designer', preset: 'ui-designer' },
          ],
        },
        {
          name: 'QA',
          leadName: 'Studio Producer',
          members: [
            { name: 'Tester', preset: 'test-automator' },
            { name: 'Performance', preset: 'performance-benchmarker' },
          ],
        },
        {
          name: 'DevOps',
          leadName: 'DevOps Automator',
          members: [
            { name: 'SRE', preset: 'sre' },
          ],
        },
      ],
    },
  },
  {
    id: 'empty',
    icon: '\uD83D\uDCDD',
    description: 'CEO only — add departments yourself',
    template: {
      name: 'Empty Company',
      departments: [],
    },
  },
];

// ─── Public result type ───────────────────────────────────────────────────────

export interface CompanyTemplateResult {
  name: string;
  template: CompanyTemplate;
  skipPermissions: boolean;
  workDir: string;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CreateCompanyDialogProps {
  onConfirm: (result: CompanyTemplateResult) => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Prettify a preset slug: "frontend-developer" -> "Frontend Developer" */
function presetLabel(preset: string): string {
  return preset
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CreateCompanyDialog({ onConfirm, onCancel }: CreateCompanyDialogProps) {
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState<string>('fullstack');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [workDir, setWorkDir] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // ── Focus management: disable xterm textareas + initial focus ──
  useEffect(() => {
    // Disable xterm helper textareas so they don't steal focus.
    const xtermTextareas = document.querySelectorAll<HTMLTextAreaElement>('.xterm-helper-textarea');
    const xtermPrevStates: { el: HTMLTextAreaElement; disabled: boolean }[] = [];
    xtermTextareas.forEach((ta) => {
      xtermPrevStates.push({ el: ta, disabled: ta.disabled });
      ta.disabled = true;
    });

    // Initial focus with delay to beat xterm's own scheduling.
    const focusInput = () => inputRef.current?.focus();
    let deferredTimer: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      focusInput();
      deferredTimer = setTimeout(focusInput, 120);
    });

    return () => {
      xtermPrevStates.forEach(({ el, disabled }) => { el.disabled = disabled; });
      cancelAnimationFrame(raf);
      if (deferredTimer !== undefined) clearTimeout(deferredTimer);
    };
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────────

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const entry = DIALOG_TEMPLATES.find((t) => t.id === selectedId) ?? DIALOG_TEMPLATES[0]!;
    onConfirm({
      name: trimmed,
      template: entry.template,
      skipPermissions,
      workDir: workDir.trim(),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') onCancel();
  };

  const selectedEntry = DIALOG_TEMPLATES.find((t) => t.id === selectedId);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'var(--backdrop-modal)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="flex flex-col rounded-xl shadow-2xl overflow-y-auto"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxHeight: 'calc(100vh - 80px)',
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          padding: '24px 28px',
          boxShadow: 'var(--shadow-modal-soft)',
        }}
      >
        {/* ── Title ── */}
        <h2
          className="text-base font-bold font-mono mb-1 tracking-wider"
          style={{ color: 'var(--text-main)' }}
        >
          Create Company
        </h2>
        <p
          className="text-[11px] font-mono mb-5"
          style={{ color: 'var(--text-muted)' }}
        >
          Set up your AI team with a name, template, and workspace.
        </p>

        {/* ── Step 1: Company Name ── */}
        <div
          className="mb-5 rounded-lg px-4 py-3"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          <label
            className="block text-[10px] font-mono mb-1.5 uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            Company Name
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. My AI Project"
            className="w-full rounded-md px-3 py-2 text-sm font-mono focus:outline-none transition-all placeholder:text-[color:var(--text-muted)]"
            style={{
              backgroundColor: 'var(--bg-base)',
              color: 'var(--text-main)',
              border: '1px solid var(--bg-surface)',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-blue)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(137,180,250,0.15)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--bg-surface)'; e.currentTarget.style.boxShadow = 'none'; }}
          />
        </div>

        {/* ── Step 2: Template Selection ── */}
        <label
          className="block text-[10px] font-mono mb-2 uppercase tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          Template
        </label>
        <div
          className="grid gap-2 mb-5"
          style={{ gridTemplateColumns: '1fr 1fr' }}
        >
          {DIALOG_TEMPLATES.map((entry, idx) => {
            const isSelected = selectedId === entry.id;
            const isHovered = hoveredId === entry.id;
            const depts = entry.template.departments;
            const totalAgents = depts.reduce((sum, d) => sum + d.members.length + 1, 0);
            // Last item in odd-length list spans full width
            const isLastOdd = DIALOG_TEMPLATES.length % 2 === 1 && idx === DIALOG_TEMPLATES.length - 1;

            return (
              <button
                key={entry.id}
                type="button"
                className="text-left rounded-lg transition-all"
                onClick={() => setSelectedId(entry.id)}
                onMouseEnter={() => setHoveredId(entry.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  gridColumn: isLastOdd ? '1 / -1' : undefined,
                  padding: '12px 14px',
                  minHeight: isLastOdd ? undefined : 110,
                  backgroundColor: isSelected
                    ? 'rgba(137, 180, 250, 0.08)'
                    : 'var(--bg-mantle)',
                  border: isSelected
                    ? '1.5px solid var(--accent-blue)'
                    : '1px solid var(--bg-surface)',
                  boxShadow: isSelected
                    ? '0 0 12px rgba(137, 180, 250, 0.15)'
                    : 'none',
                  transform: isHovered && !isSelected ? 'scale(1.02)' : 'scale(1)',
                  transition: 'all 150ms ease',
                }}
              >
                {/* Icon + Name */}
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base select-none">{entry.icon}</span>
                  <span
                    className="text-[12px] font-mono font-semibold truncate"
                    style={{ color: 'var(--text-main)' }}
                  >
                    {entry.template.name}
                  </span>
                </div>

                {/* Description */}
                <p
                  className="text-[10px] font-mono mb-2 leading-relaxed"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {entry.description}
                </p>

                {/* Stats row */}
                {depts.length > 0 ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--accent-blue)',
                      }}
                    >
                      {totalAgents} agents
                    </span>
                    <span
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: 'var(--bg-surface)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {depts.map((d) => d.name).join(' / ')}
                    </span>
                  </div>
                ) : (
                  <span
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                    style={{
                      backgroundColor: 'var(--bg-surface)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Empty
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Mini org chart preview ── */}
        {selectedEntry && selectedEntry.template.departments.length > 0 && (
          <div
            className="mb-5 rounded-lg px-4 py-3"
            style={{
              backgroundColor: 'var(--bg-mantle)',
              border: '1px solid var(--bg-surface)',
            }}
          >
            <div
              className="text-[9px] font-mono uppercase tracking-widest mb-2"
              style={{ color: 'var(--text-muted)' }}
            >
              Org Preview
            </div>

            {/* CEO node */}
            <div className="flex flex-col items-center mb-2">
              <div
                className="px-3 py-1 rounded-md text-[10px] font-mono font-bold"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--accent-yellow)',
                  border: '1px solid var(--accent-yellow)',
                }}
              >
                CEO
              </div>
              {/* Connector line */}
              <div
                style={{
                  width: 1,
                  height: 10,
                  backgroundColor: 'var(--bg-overlay)',
                }}
              />
            </div>

            {/* Departments row */}
            <div className="flex gap-2 justify-center flex-wrap">
              {selectedEntry.template.departments.map((dept) => (
                <div
                  key={dept.name}
                  className="rounded-md px-3 py-2 text-center min-w-[100px]"
                  style={{
                    backgroundColor: 'var(--bg-base)',
                    border: '1px solid var(--bg-surface)',
                  }}
                >
                  <div
                    className="text-[10px] font-mono font-bold mb-1"
                    style={{ color: 'var(--accent-blue)' }}
                  >
                    {dept.name}
                  </div>
                  <div
                    className="text-[9px] font-mono mb-1"
                    style={{ color: 'var(--accent-yellow)' }}
                  >
                    {dept.leadName}
                  </div>
                  {dept.members.map((m) => (
                    <div
                      key={m.name}
                      className="text-[9px] font-mono flex items-center justify-center gap-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {m.name}
                      {hasSoul(m.preset) && (
                        <span
                          style={{ color: 'var(--accent-blue)', fontSize: 8 }}
                          title="SOUL available"
                        >
                          {'\u2726'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 3: Options ── */}
        <div
          className="mb-5 rounded-lg px-4 py-3"
          style={{ backgroundColor: 'var(--bg-mantle)', border: '1px solid var(--bg-surface)' }}
        >
          <div
            className="text-[9px] font-mono uppercase tracking-widest mb-2"
            style={{ color: 'var(--text-muted)' }}
          >
            Options
          </div>

          {/* Working directory */}
          <label
            className="block text-[10px] font-mono mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            Working Directory
          </label>
          <input
            type="text"
            value={workDir}
            onChange={(e) => setWorkDir(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. D:\projects\my-app  (optional)"
            className="w-full rounded-md px-3 py-1.5 text-[12px] font-mono focus:outline-none transition-all mb-1 placeholder:text-[color:var(--text-muted)]"
            style={{
              backgroundColor: 'var(--bg-base)',
              color: 'var(--text-main)',
              border: '1px solid var(--bg-surface)',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent-blue)'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--bg-surface)'; }}
          />
          <p
            className="text-[9px] font-mono mb-3"
            style={{ color: 'var(--text-muted)' }}
          >
            All agents will work in this directory. Leave empty for current dir.
          </p>

          {/* Permissions toggle */}
          <div
            className="pt-3"
            style={{ borderTop: '1px solid var(--bg-surface)' }}
          >
            <button
              type="button"
              className="w-full flex items-center gap-2"
              onClick={() => setSkipPermissions((v) => !v)}
            >
              <span
                className="text-[10px] font-mono font-semibold min-w-0 shrink truncate"
                style={{ color: 'var(--accent-red)' }}
              >
                --dangerously-skip-permissions
              </span>
              {/* Toggle pill */}
              <div
                className="relative w-8 h-4 rounded-full transition-colors shrink-0 ml-auto"
                style={{ backgroundColor: skipPermissions ? 'var(--accent-red)' : 'var(--bg-surface)' }}
              >
                <div
                  className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all"
                  style={{ left: skipPermissions ? '16px' : '2px' }}
                />
              </div>
            </button>
            {skipPermissions && (
              <p
                className="text-[9px] font-mono mt-1.5"
                style={{ color: 'var(--accent-red)', opacity: 0.7 }}
              >
                All agents will skip permission prompts. Use with caution.
              </p>
            )}
          </div>
        </div>

        {/* ── Action buttons ── */}
        <div className="flex items-center justify-end gap-3 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-[11px] font-mono rounded-lg transition-all"
            style={{
              color: 'var(--text-muted)',
              border: '1px solid var(--bg-surface)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text-main)';
              e.currentTarget.style.borderColor = 'var(--bg-overlay)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-muted)';
              e.currentTarget.style.borderColor = 'var(--bg-surface)';
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="px-5 py-2 text-[11px] font-mono font-bold rounded-lg transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              backgroundColor: 'var(--accent-blue)',
              color: 'var(--bg-base)',
            }}
          >
            Create Company
          </button>
        </div>
      </div>
    </div>
  );
}
