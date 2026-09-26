import type { TranslationKey } from '../i18n/locales/en';

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'shortcuts'
  | 'notifications'
  | 'claude-integration'
  | 'accounts'
  | 'orchestrator'
  | 'roles'
  | 'browser'
  | 'remote'
  | 'lanlink'
  | 'about';

export type SettingsNavGroupId = 'app' | 'agents' | 'connections' | 'about';

export interface SettingsCatalogEntry {
  id: string;
  tab: SettingsTabId;
  labelKey: TranslationKey;
  descKey?: TranslationKey;
  /** Extra search terms (English + native-language synonyms). Space-separated. */
  synonyms: string;
}

/**
 * Left-nav order. The first and last groups carry no heading: the app tabs
 * read as the default list and About sits alone at the end. Agents and
 * Connections are headed because they gather several tabs of one kind.
 */
export const SETTINGS_NAV_GROUPS: {
  id: SettingsNavGroupId;
  labelKey?: TranslationKey;
  tabs: SettingsTabId[];
}[] = [
  {
    id: 'app',
    tabs: ['general', 'appearance', 'terminal', 'shortcuts', 'notifications'],
  },
  {
    id: 'agents',
    labelKey: 'settings.navGroupAgents',
    tabs: ['claude-integration', 'accounts', 'orchestrator', 'roles', 'browser'],
  },
  {
    id: 'connections',
    labelKey: 'settings.navGroupConnections',
    tabs: ['remote', 'lanlink'],
  },
  {
    id: 'about',
    tabs: ['about'],
  },
];

/**
 * Tab ids that no longer exist, mapped to the tab that now holds their
 * settings. `agents` was split into Orchestrator and Roles & fan-out; the
 * orchestrator half kept the tab's first section, so an old deep link lands
 * there. Every tab id that survived kept its spelling, so it needs no alias.
 */
export const LEGACY_SETTINGS_TAB_ALIASES: Readonly<Record<string, SettingsTabId>> = {
  agents: 'orchestrator',
};

const TAB_IDS: ReadonlySet<string> = new Set(SETTINGS_NAV_GROUPS.flatMap((g) => g.tabs));

/** Resolve a tab id from any caller (current or legacy) to a tab that exists.
 *  An unknown id opens General rather than a blank panel. */
export function resolveSettingsTab(id: string | null | undefined): SettingsTabId {
  if (!id) return 'general';
  if (TAB_IDS.has(id)) return id as SettingsTabId;
  return LEGACY_SETTINGS_TAB_ALIASES[id] ?? 'general';
}

/**
 * Searchable index over Settings. Labels/descriptions come from i18n at
 * query time so a Korean UI still matches Korean words; `synonyms` covers
 * the words people type before they know the official label (Orca lesson:
 * "언어" finds Language while the UI is still in English).
 */
export const SETTINGS_CATALOG: SettingsCatalogEntry[] = [
  { id: 'language', tab: 'general', labelKey: 'settings.language', synonyms: 'locale 언어 language 日本語 中文 idioma' },
  { id: 'autoupdate', tab: 'general', labelKey: 'settings.autoUpdate', descKey: 'settings.autoUpdateDesc', synonyms: 'update upgrade version' },
  { id: 'checkupdate', tab: 'general', labelKey: 'settings.checkUpdate', synonyms: 'update now latest release' },
  { id: 'startup', tab: 'general', labelKey: 'settings.startup', synonyms: 'autostart boot login launch 시작' },
  { id: 'tutorial', tab: 'general', labelKey: 'settings.restartTutorial', descKey: 'settings.restartTutorialDesc', synonyms: 'onboarding tour help 튜토리얼' },
  { id: 'firstrun', tab: 'general', labelKey: 'settings.firstRunSetup', descKey: 'settings.firstRunSetupDesc', synonyms: 'first run setup doctor diagnose' },
  { id: 'reset', tab: 'general', labelKey: 'settings.reset', synonyms: 'factory default wipe 초기화' },

  { id: 'shell', tab: 'terminal', labelKey: 'settings.defaultShell', synonyms: 'zsh bash powershell pwsh fish 셸' },
  { id: 'startdir', tab: 'terminal', labelKey: 'settings.startupDirectory', descKey: 'settings.startupDirectoryDesc', synonyms: 'cwd home folder path' },
  { id: 'splitcwd', tab: 'terminal', labelKey: 'settings.splitInheritsCwd', descKey: 'settings.splitInheritsCwdDesc', synonyms: 'cwd split inherit' },
  { id: 'ime', tab: 'terminal', labelKey: 'settings.imeResidueGuard', descKey: 'settings.imeResidueGuardDesc', synonyms: 'ime korean cjk hangul 한글 입력' },
  { id: 'retention', tab: 'terminal', labelKey: 'settings.hiddenPaneRetention', descKey: 'settings.hiddenPaneRetentionDesc', synonyms: 'hidden render cpu park' },
  { id: 'coldpark', tab: 'terminal', labelKey: 'settings.coldPark', descKey: 'settings.coldParkDesc', synonyms: 'memory ram park idle unmount' },
  { id: 'scrollback', tab: 'terminal', labelKey: 'settings.scrollbackLines', descKey: 'settings.scrollbackDesc', synonyms: 'history buffer lines scroll' },
  { id: 'restore', tab: 'terminal', labelKey: 'settings.scrollbackRestore', descKey: 'settings.scrollbackRestoreDesc', synonyms: 'restore persist reboot' },
  { id: 'imagepaste', tab: 'terminal', labelKey: 'settings.imagePaste', descKey: 'settings.imagePasteDesc', synonyms: 'image paste screenshot clipboard png inline native wsl 이미지 붙여넣기 스크린샷 클립보드' },

  { id: 'theme', tab: 'appearance', labelKey: 'settings.theme', synonyms: 'color colour dark light palette 테마' },
  { id: 'fontsize', tab: 'appearance', labelKey: 'settings.fontSize', synonyms: 'type size zoom text 글자' },
  { id: 'fontfamily', tab: 'appearance', labelKey: 'settings.fontFamily', descKey: 'settings.fontFamilyDesc', synonyms: 'typeface mono cascadia jetbrains 폰트' },
  { id: 'cursorshape', tab: 'appearance', labelKey: 'settings.cursorShape', descKey: 'settings.cursorShapeDesc', synonyms: 'cursor caret bar block underline beam 커서 캐럿 막대 블록 shape type style' },
  { id: 'chrome', tab: 'appearance', labelKey: 'settings.chromePreset', descKey: 'settings.chromePresetDesc', synonyms: 'density compact comfortable' },
  { id: 'sidebarpos', tab: 'appearance', labelKey: 'settings.sidebarPosition', descKey: 'settings.sidebarPositionDesc', synonyms: 'sidebar left right dock' },
  { id: 'sidebarattention', tab: 'appearance', labelKey: 'settings.sidebarSort', descKey: 'settings.sidebarSortDesc', synonyms: 'needs you waiting attention sort order recent activity manual pin top 대기 정렬 순서 최근' },
  { id: 'sidebarpanecoordinates', tab: 'appearance', labelKey: 'settings.sidebarShowPaneCoordinates', descKey: 'settings.sidebarShowPaneCoordinatesDesc', synonyms: 'roster coordinate w1-2 pane name label unnamed clutter agent' },
  { id: 'multiview', tab: 'appearance', labelKey: 'settings.multiviewArrangement', descKey: 'settings.multiviewArrangementDesc', synonyms: 'grid split stack columns rows' },
  { id: 'uiscale', tab: 'appearance', labelKey: 'settings.uiScale', descKey: 'settings.uiScaleDesc', synonyms: 'zoom dpi accessibility scale 배율' },
  { id: 'toolbar', tab: 'appearance', labelKey: 'settings.agentToolbarShow', descKey: 'settings.agentToolbarShowDesc', synonyms: 'toolbar compose new chat' },

  { id: 'sound', tab: 'notifications', labelKey: 'settings.sound', descKey: 'settings.soundDesc', synonyms: 'sound audio beep alarm 소리' },
  { id: 'toast', tab: 'notifications', labelKey: 'settings.toast', descKey: 'settings.toastDesc', synonyms: 'toast popup banner' },
  { id: 'osnotify', tab: 'notifications', labelKey: 'settings.ring', descKey: 'settings.ringDesc', synonyms: 'system toast windows macos banner' },
  { id: 'catmute', tab: 'notifications', labelKey: 'settings.notificationCategories', descKey: 'settings.notificationCategoriesDesc', synonyms: 'mute category subagent approval' },
  { id: 'wsmute', tab: 'notifications', labelKey: 'settings.perWorkspaceNotifications', descKey: 'settings.perWorkspaceNotificationsDesc', synonyms: 'mute workspace quiet' },

  { id: 'prefix', tab: 'shortcuts', labelKey: 'settings.prefixKey', synonyms: 'prefix tmux ctrl+b leader' },
  { id: 'customkeys', tab: 'shortcuts', labelKey: 'settings.customKeybindings', synonyms: 'hotkey shortcut keymap bind 단축키' },

  { id: 'plugin', tab: 'claude-integration', labelKey: 'claudeIntegration.signalHealth.title', synonyms: 'integration hook plugin setup install claude 계정' },
  { id: 'setup', tab: 'claude-integration', labelKey: 'integrationSetup.title', descKey: 'integrationSetup.description', synonyms: 'hooks hook bridge statusline status line mcp install setup 훅 설치' },
  { id: 'usage', tab: 'claude-integration', labelKey: 'claudeIntegration.usage.title', descKey: 'claudeIntegration.usage.description', synonyms: 'usage quota limit 5h 7d meter anthropic 사용량' },
  { id: 'mcp', tab: 'claude-integration', labelKey: 'settings.mcpServers', synonyms: 'mcp plugin tools broker register codex' },

  { id: 'claudeacct', tab: 'accounts', labelKey: 'accounts.title', synonyms: 'claude account login subscription max usage quota 계정' },

  { id: 'brain', tab: 'orchestrator', labelKey: 'settings.orchestratorBrain', descKey: 'settings.orchestratorBrainDesc', synonyms: 'orchestrator brain hermes claude acp' },
  { id: 'model', tab: 'orchestrator', labelKey: 'settings.orchestratorModel', descKey: 'settings.orchestratorModelDesc', synonyms: 'model opus sonnet haiku' },
  { id: 'autowake', tab: 'orchestrator', labelKey: 'settings.autoWake', descKey: 'settings.autoWakeDesc', synonyms: 'autowake wake event push tokens' },
  { id: 'fullpower', tab: 'orchestrator', labelKey: 'settings.orchestratorFullPower', synonyms: 'full power sdk settings sources tools' },
  { id: 'ledgergate', tab: 'orchestrator', labelKey: 'settings.ledgerGate', descKey: 'settings.ledgerGateDesc', synonyms: 'ledger gate stop task orchestrator delegated experimental' },
  { id: 'briefing', tab: 'orchestrator', labelKey: 'settings.briefing', descKey: 'settings.briefingDesc', synonyms: 'briefing welcome home summary' },

  { id: 'roles', tab: 'roles', labelKey: 'settings.roleBindings', descKey: 'settings.roleBindingsDesc', synonyms: 'role reviewer tester planner model bind' },
  { id: 'a2a', tab: 'roles', labelKey: 'settings.a2aAutoApproveExecute', descKey: 'settings.a2aAutoApproveExecuteDesc', synonyms: 'a2a execute approve' },
  { id: 'fanoutapproval', tab: 'roles', labelKey: 'settings.fanoutRequireApproval', descKey: 'settings.fanoutRequireApprovalDesc', synonyms: 'fanout fan-out approval approve prompt unattended ask' },
  { id: 'fanoutworkers', tab: 'roles', labelKey: 'settings.fanoutWorkerPermissionMode', descKey: 'settings.fanoutWorkerPermissionModeDesc', synonyms: 'fanout fan-out worker permission auto bypass sandbox' },
  { id: 'fanoutpresets', tab: 'roles', labelKey: 'settings.fanoutPresets', descKey: 'settings.fanoutPresetsDesc', synonyms: 'fanout fan-out preset image video agents codex grok output folder worktree' },
  { id: 'fanoutallowtools', tab: 'roles', labelKey: 'settings.fanoutAllowWorkerTools', descKey: 'settings.fanoutAllowWorkerToolsDesc', synonyms: 'fanout worker allow tools permissions settings.json' },

  { id: 'browserbackend', tab: 'browser', labelKey: 'settings.browserBackend', descKey: 'settings.browserBackendDesc', synonyms: 'browser chrome chromium external builtin' },
  { id: 'browserlight', tab: 'browser', labelKey: 'settings.browserLightweight', descKey: 'settings.browserLightweightDesc', synonyms: 'browser throttle cpu lightweight' },
  { id: 'sitememory', tab: 'browser', labelKey: 'settings.siteMemory', descKey: 'settings.siteMemoryDesc', synonyms: 'browser site memory domain replay failure remember' },
  { id: 'siteguides', tab: 'browser', labelKey: 'settings.siteGuides', descKey: 'settings.siteGuidesDesc', synonyms: 'browser site guides notes chrome agent' },

  { id: 'paireddevices', tab: 'remote', labelKey: 'web.devicesTitle', descKey: 'web.devicesSubtitle', synonyms: 'phone mobile device paired revoke remote web 휴대폰 기기' },
  { id: 'quickcommands', tab: 'remote', labelKey: 'settings.quickCommands', synonyms: 'quick command snippet phone reusable instruction 빠른 명령' },

  { id: 'lanenable', tab: 'lanlink', labelKey: 'settings.lanlinkEnable', descKey: 'settings.lanlinkEnableDesc', synonyms: 'lan link network peer remote pair' },
  { id: 'lannic', tab: 'lanlink', labelKey: 'settings.lanlinkNic', descKey: 'settings.lanlinkNicDesc', synonyms: 'nic interface ethernet wifi mac' },
  { id: 'lanpair', tab: 'lanlink', labelKey: 'settings.lanlinkPair', synonyms: 'pin pair join revoke peer' },

  { id: 'version', tab: 'about', labelKey: 'settings.aboutTagline', synonyms: 'version about changelog release 버전' },
];
