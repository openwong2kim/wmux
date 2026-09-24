/** Display metadata only. No file contents, filesystem paths or executable flags. */
export interface ChatSkill { name: string; description: string; invocation: string; source: string }
export interface ChatSkillCatalog { skills: ChatSkill[]; state: 'ready' | 'partial' | 'unavailable'; reason?: 'bridge-outdated' }
