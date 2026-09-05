import type { TranslationKey } from '../i18n/locales/en';

export type SettingsTabId =
  | 'general'
  | 'terminal'
  | 'appearance'
  | 'notifications'
  | 'shortcuts'
  | 'claude-integration'
  | 'agents'
  | 'lanlink'
  | 'about';

export type SettingsNavGroupId = 'app' | 'agents' | 'system';

export interface SettingsCatalogEntry {
  id: string;
  tab: SettingsTabId;
  labelKey: TranslationKey;
  descKey?: TranslationKey;
  /** Extra search terms (English + native-language synonyms). Space-separated. */
  synonyms: string;
}

export const SETTINGS_NAV_GROUPS: {
  id: SettingsNavGroupId;
  labelKey: TranslationKey;
  tabs: SettingsTabId[];
}[] = [
  {
    id: 'app',
    labelKey: 'settings.navGroupApp',
    tabs: ['general', 'terminal', 'appearance', 'notifications', 'shortcuts'],
  },
  {
    id: 'agents',
    labelKey: 'settings.navGroupAgents',
    tabs: ['claude-integration', 'agents'],
  },
  {
    id: 'system',
    labelKey: 'settings.navGroupSystem',
    tabs: ['lanlink', 'about'],
  },
];

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
  { id: 'reset', tab: 'general', labelKey: 'settings.reset', synonyms: 'factory default wipe 초기화' },

  { id: 'shell', tab: 'terminal', labelKey: 'settings.defaultShell', synonyms: 'zsh bash powershell pwsh fish 셸' },
  { id: 'startdir', tab: 'terminal', labelKey: 'settings.startupDirectory', descKey: 'settings.startupDirectoryDesc', synonyms: 'cwd home folder path' },
  { id: 'splitcwd', tab: 'terminal', labelKey: 'settings.splitInheritsCwd', descKey: 'settings.splitInheritsCwdDesc', synonyms: 'cwd split inherit' },
  { id: 'ime', tab: 'terminal', labelKey: 'settings.imeResidueGuard', descKey: 'settings.imeResidueGuardDesc', synonyms: 'ime korean cjk hangul 한글 입력' },
  { id: 'retention', tab: 'terminal', labelKey: 'settings.hiddenPaneRetention', descKey: 'settings.hiddenPaneRetentionDesc', synonyms: 'hidden render cpu park' },
  { id: 'coldpark', tab: 'terminal', labelKey: 'settings.coldPark', descKey: 'settings.coldParkDesc', synonyms: 'memory ram park idle unmount' },
  { id: 'browserbackend', tab: 'terminal', labelKey: 'settings.browserBackend', descKey: 'settings.browserBackendDesc', synonyms: 'browser chrome chromium external builtin' },
  { id: 'browserlight', tab: 'terminal', labelKey: 'settings.browserLightweight', descKey: 'settings.browserLightweightDesc', synonyms: 'browser throttle cpu lightweight' },
  { id: 'scrollback', tab: 'terminal', labelKey: 'settings.scrollbackLines', descKey: 'settings.scrollbackDesc', synonyms: 'history buffer lines scroll' },
  { id: 'restore', tab: 'terminal', labelKey: 'settings.scrollbackRestore', descKey: 'settings.scrollbackRestoreDesc', synonyms: 'restore persist reboot' },
  { id: 'imagepaste', tab: 'terminal', labelKey: 'settings.imagePaste', descKey: 'settings.imagePasteDesc', synonyms: 'image paste screenshot clipboard png inline native wsl 이미지 붙여넣기 스크린샷 클립보드' },

  { id: 'theme', tab: 'appearance', labelKey: 'settings.theme', synonyms: 'color colour dark light palette 테마' },
  { id: 'fontsize', tab: 'appearance', labelKey: 'settings.fontSize', synonyms: 'type size zoom text 글자' },
  { id: 'fontfamily', tab: 'appearance', labelKey: 'settings.fontFamily', descKey: 'settings.fontFamilyDesc', synonyms: 'typeface mono cascadia jetbrains 폰트' },
  { id: 'cursorshape', tab: 'appearance', labelKey: 'settings.cursorShape', descKey: 'settings.cursorShapeDesc', synonyms: 'cursor caret bar block underline beam 커서 캐럿 막대 블록 shape type style' },
  { id: 'chrome', tab: 'appearance', labelKey: 'settings.chromePreset', descKey: 'settings.chromePresetDesc', synonyms: 'density compact comfortable' },
  { id: 'sidebarpos', tab: 'appearance', labelKey: 'settings.sidebarPosition', descKey: 'settings.sidebarPositionDesc', synonyms: 'sidebar left right dock' },
  { id: 'sidebarattention', tab: 'appearance', labelKey: 'settings.sidebarAttentionFirst', descKey: 'settings.sidebarAttentionFirstDesc', synonyms: 'needs you waiting attention sort pin top 대기 정렬' },
  { id: 'multiview', tab: 'appearance', labelKey: 'settings.multiviewArrangement', descKey: 'settings.multiviewArrangementDesc', synonyms: 'grid split stack columns rows' },
  { id: 'uiscale', tab: 'appearance', labelKey: 'settings.uiScale', descKey: 'settings.uiScaleDesc', synonyms: 'zoom dpi accessibility scale 배율' },

  { id: 'sound', tab: 'notifications', labelKey: 'settings.sound', descKey: 'settings.soundDesc', synonyms: 'sound audio beep alarm 소리' },
  { id: 'toast', tab: 'notifications', labelKey: 'settings.toast', descKey: 'settings.toastDesc', synonyms: 'toast popup banner' },
  { id: 'osnotify', tab: 'notifications', labelKey: 'settings.ring', descKey: 'settings.ringDesc', synonyms: 'system toast windows macos banner' },
  { id: 'catmute', tab: 'notifications', labelKey: 'settings.notificationCategories', descKey: 'settings.notificationCategoriesDesc', synonyms: 'mute category subagent approval' },
  { id: 'wsmute', tab: 'notifications', labelKey: 'settings.perWorkspaceNotifications', descKey: 'settings.perWorkspaceNotificationsDesc', synonyms: 'mute workspace quiet' },

  { id: 'prefix', tab: 'shortcuts', labelKey: 'settings.prefixKey', synonyms: 'prefix tmux ctrl+b leader' },
  { id: 'customkeys', tab: 'shortcuts', labelKey: 'settings.customKeybindings', synonyms: 'hotkey shortcut keymap bind 단축키' },

  // Labelled by the tab's CURRENT name. `claudeIntegration.tab` still says
  // "Claude Integration", which this PR renamed the tab away from — a result
  // row naming a tab that no longer exists by that name sends the user looking
  // for the wrong thing.
  { id: 'plugin', tab: 'claude-integration', labelKey: 'settings.tabAccounts', synonyms: 'integration hook plugin setup install claude 계정' },
  { id: 'claudeacct', tab: 'claude-integration', labelKey: 'accounts.title', synonyms: 'claude account login subscription max usage quota 계정' },

  { id: 'brain', tab: 'agents', labelKey: 'settings.orchestratorBrain', descKey: 'settings.orchestratorBrainDesc', synonyms: 'orchestrator brain hermes claude acp' },
  { id: 'model', tab: 'agents', labelKey: 'settings.orchestratorModel', descKey: 'settings.orchestratorModelDesc', synonyms: 'model opus sonnet haiku' },
  { id: 'autowake', tab: 'agents', labelKey: 'settings.autoWake', descKey: 'settings.autoWakeDesc', synonyms: 'autowake wake event push tokens' },
  { id: 'ledgergate', tab: 'agents', labelKey: 'settings.ledgerGate', descKey: 'settings.ledgerGateDesc', synonyms: 'ledger gate stop task orchestrator delegated experimental' },
  { id: 'roles', tab: 'agents', labelKey: 'settings.roleBindings', descKey: 'settings.roleBindingsDesc', synonyms: 'role reviewer tester planner model bind' },
  { id: 'a2a', tab: 'agents', labelKey: 'settings.a2aAutoApproveExecute', descKey: 'settings.a2aAutoApproveExecuteDesc', synonyms: 'a2a execute approve' },
  { id: 'mcp', tab: 'agents', labelKey: 'settings.mcpServers', synonyms: 'mcp plugin tools broker register' },
  { id: 'toolbar', tab: 'agents', labelKey: 'settings.agentToolbarShow', descKey: 'settings.agentToolbarShowDesc', synonyms: 'toolbar compose new chat' },

  { id: 'lanenable', tab: 'lanlink', labelKey: 'settings.lanlinkEnable', descKey: 'settings.lanlinkEnableDesc', synonyms: 'lan link network peer remote pair' },
  { id: 'lannic', tab: 'lanlink', labelKey: 'settings.lanlinkNic', descKey: 'settings.lanlinkNicDesc', synonyms: 'nic interface ethernet wifi mac' },
  { id: 'lanpair', tab: 'lanlink', labelKey: 'settings.lanlinkPair', synonyms: 'pin pair join revoke peer' },

  { id: 'version', tab: 'about', labelKey: 'settings.aboutTagline', synonyms: 'version about changelog release 버전' },
  { id: 'firstrun', tab: 'about', labelKey: 'settings.firstRunSetup', descKey: 'settings.firstRunSetupDesc', synonyms: 'first run setup doctor diagnose' },
];
