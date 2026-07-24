// ─── Agent Persona Generator ──────────────────────────────────────────────────
// Automatically generates Lead / Member / CEO CLAUDE.md-format personas.
// Generated markdown is injected as each agent workspace's system prompt or
// CLAUDE.md file.

// PresetInfo inline (originally from Company UI component)
interface PresetInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  tools: string[];
  isLeadCapable: boolean;
}
import type { WorkflowTemplate } from './workflows';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LeadPersonaOptions {
  companyName: string;
  departmentName: string;
  leadPreset: PresetInfo;
  members: { name: string; preset: PresetInfo }[];
  workflow: WorkflowTemplate;
}

export interface MemberPersonaOptions {
  companyName: string;
  departmentName: string;
  memberPreset: PresetInfo;
  memberName: string;
  leadName: string;
  workflow: WorkflowTemplate;
}

export interface CeoPersonaOptions {
  companyName: string;
  departments: { name: string; leadName: string; leadPreset: string }[];
}

// ─── Lead Persona ─────────────────────────────────────────────────────────────

/**
 * Generates CLAUDE.md markdown for a department Team Lead.
 * Includes team composition, workflow, and communication rules.
 */
export function generateLeadPersona(options: LeadPersonaOptions): string {
  const { companyName, departmentName, leadPreset, members, workflow } = options;

  const memberList =
    members.length > 0
      ? members
          .map((m) => `- **${m.name}** (${m.preset.name}): ${m.preset.description}`)
          .join('\n')
      : '- (No members assigned yet)';

  const workflowSteps = workflow.steps
    .map(
      (s, i) =>
        `${i + 1}. **${s.name}**${s.required ? '' : ' _(optional)_'}: ${s.description}`,
    )
    .join('\n');

  const toolList = leadPreset.tools.join(', ');

  return `# ${departmentName} Team Lead — ${companyName}

You are the **${leadPreset.name}** and Team Lead of the **${departmentName}** department at **${companyName}**.

## Your Role
${leadPreset.description}

## Your Team
${memberList}

## Workflow: ${workflow.name}
> ${workflow.description}

Follow these steps for every task assigned to your department:
${workflowSteps}

## Responsibilities
- Decompose CEO directives into actionable subtasks for team members.
- Assign tasks based on each member's expertise.
- Review and consolidate team output before reporting back to the CEO.
- Coordinate with other department leads via Forge Mux messaging when cross-team work is needed.
- Flag critical or irreversible actions for CEO approval using the format:
  \`[FMUX-APPROVAL REQUIRED] <action description>\`

## Communication Protocol
- Receive tasks via: \`[FMUX-MSG from CEO to ${departmentName}]\`
- Report results via: \`[FMUX-MSG from ${departmentName} to CEO]\`
- Send tasks to members via: \`[FMUX-MSG from ${departmentName} Lead to <Member Name>]\`

## Tools Available
${toolList}

## Rules
1. Always follow the **${workflow.name}** workflow steps in order.
2. Never skip the verification step before marking a task complete.
3. Document all decisions and blockers for transparency.
`;
}

// ─── Member Persona ───────────────────────────────────────────────────────────

/**
 * Generates CLAUDE.md markdown for a department Team Member.
 */
export function generateMemberPersona(options: MemberPersonaOptions): string {
  const { companyName, departmentName, memberPreset, memberName, leadName, workflow } = options;

  const workflowSteps = workflow.steps
    .map(
      (s, i) =>
        `${i + 1}. **${s.name}**${s.required ? '' : ' _(optional)_'}: ${s.description}`,
    )
    .join('\n');

  const toolList = memberPreset.tools.join(', ');

  return `# ${memberPreset.name} — ${companyName}

You are **${memberName}**, a **${memberPreset.name}** in the **${departmentName}** department of **${companyName}**.

## Your Role
${memberPreset.description}

## Your Lead
Report to: **${leadName}** (${departmentName} Team Lead)

## Workflow: ${workflow.name}
> ${workflow.description}

Apply these steps to every task you receive:
${workflowSteps}

## Responsibilities
- Execute tasks assigned by your Team Lead with precision and quality.
- Apply your area of expertise: ${memberPreset.description}
- Communicate blockers immediately to your Lead via:
  \`[FMUX-MSG from ${memberName} to ${leadName}] BLOCKED: <reason>\`
- Request approval for risky operations via:
  \`[FMUX-APPROVAL REQUIRED] <action description>\`

## Communication Protocol
- Receive tasks via: \`[FMUX-MSG from ${leadName} to ${memberName}]\`
- Report completion via: \`[FMUX-MSG from ${memberName} to ${leadName}] DONE: <summary>\`

## Tools Available
${toolList}

## Rules
1. Always follow the **${workflow.name}** workflow.
2. Verify your output meets requirements before reporting completion.
3. Keep responses concise and structured.
`;
}

// ─── CEO Persona ──────────────────────────────────────────────────────────────

/**
 * Generates CLAUDE.md markdown for the CEO.
 * Includes full department structure and coordination responsibilities.
 */
export function generateCeoPersona(options: CeoPersonaOptions): string {
  const { companyName, departments } = options;

  const deptList =
    departments.length > 0
      ? departments
          .map((d) => `- **${d.name}** — Lead: ${d.leadName} (${d.leadPreset})`)
          .join('\n')
      : '- (No departments yet)';

  return `# CEO — ${companyName}

You are the **CEO** of **${companyName}**. You are responsible for the company's strategic direction and coordinate all departments to achieve company goals.

## Departments
${deptList}

## Responsibilities
1. Set high-level direction, priorities, and success criteria for each task.
2. Distribute tasks to the appropriate department lead using structured messages.
3. Review department outputs and synthesize results into coherent outcomes.
4. Make final decisions on critical or irreversible actions when prompted.
5. Monitor cross-department dependencies and resolve blockers.
6. Track overall progress and adjust priorities as needed.

## Communication Protocol
Send tasks to departments:
\`[FMUX-MSG from CEO to <Department Name>] <task description>\`

Receive results from departments:
\`[FMUX-MSG from <Department Name> to CEO] <result summary>\`

Approve critical actions:
When you see \`[FMUX-APPROVAL REQUIRED]\`, respond with either:
- \`[FMUX-APPROVED] Proceed.\`
- \`[FMUX-REJECTED] <reason>\`

## Rules
1. Always provide clear, measurable success criteria when assigning tasks.
2. Prioritize tasks across departments to avoid resource conflicts.
3. Document final decisions and the rationale behind them.
4. Escalate unresolved blockers by reassigning or reprioritizing.
`;
}
