// ─── Superpowers Workflow Templates ───────────────────────────────────────────
// Standard workflow definitions for agent teams to follow.
// WorkflowStep.skill maps 1:1 to agency-agents "superpowers" skill names.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  /** agency-agents superpowers skill name */
  skill: string;
  required: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  /** Categories for which this workflow is the default recommendation */
  recommendedFor: string[];
}

// ─── Workflow Definitions ─────────────────────────────────────────────────────

export const WORKFLOWS: WorkflowTemplate[] = [
  // ── Standard Development ──────────────────────────────────────────────────
  {
    id: 'standard-dev',
    name: 'Standard Development',
    description: 'Brainstorm → Plan → TDD → Review → Verify',
    steps: [
      {
        id: 'brainstorm',
        name: 'Brainstorming',
        description: 'Refine design and confirm requirements. Discuss all edge cases before implementation.',
        skill: 'brainstorming',
        required: true,
      },
      {
        id: 'plan',
        name: 'Write Plan',
        description: 'Write an execution plan broken into 2–5 minute tasks.',
        skill: 'writing-plans',
        required: true,
      },
      {
        id: 'tdd',
        name: 'Test-Driven Development',
        description: 'Implement using the RED → GREEN → REFACTOR cycle.',
        skill: 'test-driven-development',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute Plan',
        description: 'Execute the plan step by step, checking off checkpoints.',
        skill: 'executing-plans',
        required: true,
      },
      {
        id: 'review',
        name: 'Code Review',
        description: 'Request review and incorporate feedback.',
        skill: 'requesting-code-review',
        required: true,
      },
      {
        id: 'verify',
        name: 'Verification',
        description: 'Verify all requirements are met before completion.',
        skill: 'verification-before-completion',
        required: true,
      },
    ],
    recommendedFor: ['engineering', 'game-dev'],
  },

  // ── Design Workflow ───────────────────────────────────────────────────────
  {
    id: 'design-flow',
    name: 'Design Workflow',
    description: 'Brainstorm → Plan → Execute → Review',
    steps: [
      {
        id: 'brainstorm',
        name: 'Brainstorming',
        description: 'Integrate design concepts and user research insights.',
        skill: 'brainstorming',
        required: true,
      },
      {
        id: 'plan',
        name: 'Write Plan',
        description: 'Break design tasks into steps.',
        skill: 'writing-plans',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute Plan',
        description: 'Produce design deliverables according to the plan.',
        skill: 'executing-plans',
        required: true,
      },
      {
        id: 'review',
        name: 'Design Review',
        description: 'Incorporate feedback after stakeholder review.',
        skill: 'requesting-code-review',
        required: false,
      },
    ],
    recommendedFor: ['design', 'product'],
  },

  // ── Security Audit ────────────────────────────────────────────────────────
  {
    id: 'security-audit',
    name: 'Security Audit',
    description: 'Debug → Review → Verify',
    steps: [
      {
        id: 'debug',
        name: 'Systematic Analysis',
        description: 'Systematic vulnerability analysis: attack surface mapping → hypothesis → verification.',
        skill: 'systematic-debugging',
        required: true,
      },
      {
        id: 'review',
        name: 'Code Review',
        description: 'Security-focused code review and remediation suggestions.',
        skill: 'requesting-code-review',
        required: true,
      },
      {
        id: 'verify',
        name: 'Verification',
        description: 'Re-verify after patch application and final security sign-off.',
        skill: 'verification-before-completion',
        required: true,
      },
    ],
    recommendedFor: ['testing', 'specialized'],
  },

  // ── Rapid Prototyping ─────────────────────────────────────────────────────
  {
    id: 'rapid-prototype',
    name: 'Rapid Prototyping',
    description: 'Brainstorm → Execute (rapid prototyping)',
    steps: [
      {
        id: 'brainstorm',
        name: 'Brainstorming',
        description: 'Quickly refine ideas and define core assumptions.',
        skill: 'brainstorming',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute',
        description: 'Quickly implement a minimum viable prototype.',
        skill: 'executing-plans',
        required: true,
      },
    ],
    recommendedFor: ['marketing', 'sales', 'support'],
  },

  // ── Project Management ────────────────────────────────────────────────────
  {
    id: 'project-management',
    name: 'Project Management',
    description: 'Plan → Execute → Verify',
    steps: [
      {
        id: 'plan',
        name: 'Write Plan',
        description: 'Define milestones and subtasks and assign owners.',
        skill: 'writing-plans',
        required: true,
      },
      {
        id: 'execute',
        name: 'Execute Plan',
        description: 'Track progress checkpoint-by-checkpoint and execute.',
        skill: 'executing-plans',
        required: true,
      },
      {
        id: 'verify',
        name: 'Verification',
        description: 'Confirm deliverable quality and completion criteria are met.',
        skill: 'verification-before-completion',
        required: true,
      },
    ],
    recommendedFor: ['project-management'],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the recommended workflow for a category. Falls back to standard-dev if no match. */
export function getRecommendedWorkflow(category: string): WorkflowTemplate {
  return (
    WORKFLOWS.find((w) => w.recommendedFor.includes(category)) ?? WORKFLOWS[0]
  );
}

/** Returns WorkflowTemplate by id, or undefined if not found. */
export function getWorkflowById(id: string): WorkflowTemplate | undefined {
  return WORKFLOWS.find((w) => w.id === id);
}
