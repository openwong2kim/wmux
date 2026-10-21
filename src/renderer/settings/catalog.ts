import type { TranslationKey } from '../i18n/locales/en';

export type SettingsTabId =
  | 'general'
  | 'appearance'
  | 'terminal'
  | 'shortcuts'
  | 'notifications'
  | 'claude-integration'
  | 'accounts'
  | 'factory'
  | 'roles'
  | 'tokens'
  | 'browser'
  | 'computer-use'
  | 'remote'
  | 'plugins'
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
  /** Rendered only on these platforms; search leaves it out elsewhere. */
  platform?: NodeJS.Platform | readonly NodeJS.Platform[];
}

/** Whether an entry is rendered on this platform (no `platform` means everywhere). */
export function catalogEntryOnPlatform(entry: SettingsCatalogEntry, platform: string | undefined): boolean {
  if (!entry.platform) return true;
  const list: readonly string[] = typeof entry.platform === 'string' ? [entry.platform] : entry.platform;
  return platform !== undefined && list.includes(platform);
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
    tabs: ['claude-integration', 'accounts', 'factory', 'roles', 'tokens', 'browser', 'computer-use'],
  },
  {
    id: 'connections',
    labelKey: 'settings.navGroupConnections',
    tabs: ['plugins', 'remote', 'lanlink'],
  },
  {
    id: 'about',
    tabs: ['about'],
  },
];

/**
 * Tab ids that no longer exist, mapped to the tab that now holds their
 * settings. `agents` was split into Orchestrator and Roles & fan-out;
 * Orchestrator then became Moa (the HQ main bot), and Moa's tab gave way to
 * the agent factory's. Every other tab id kept its spelling, so it needs no
 * alias.
 */
export const LEGACY_SETTINGS_TAB_ALIASES: Readonly<Record<string, SettingsTabId>> = {
  agents: 'factory',
  orchestrator: 'factory',
  moa: 'factory',
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
  { id: 'plugins', tab: 'plugins', labelKey: 'plugins.settings.title', descKey: 'plugins.settings.description', synonyms: 'connector extension install Gmail GitHub MCP 플러그인 커넥터 插件 wtyczki' },
  { id: 'language', tab: 'general', labelKey: 'settings.language', synonyms: 'locale 언어 language 日本語 中文 idioma' },
  { id: 'autoupdate', tab: 'general', labelKey: 'settings.autoUpdate', descKey: 'settings.autoUpdateDesc', synonyms: 'update upgrade version' },
  { id: 'checkupdate', tab: 'general', labelKey: 'settings.checkUpdate', synonyms: 'update now latest release' },
  { id: 'secretguard', tab: 'general', labelKey: 'settings.secretGuard', descKey: 'settings.secretGuardDesc', synonyms: 'git secret password key token env commit push pr 비밀번호 키' },
  { id: 'startup', tab: 'general', labelKey: 'settings.startup', synonyms: 'autostart boot login launch 시작' },
  { id: 'tutorial', tab: 'general', labelKey: 'settings.restartTutorial', descKey: 'settings.restartTutorialDesc', synonyms: 'onboarding tour help 튜토리얼' },
  { id: 'firstrun', tab: 'general', labelKey: 'settings.firstRunSetup', descKey: 'settings.firstRunSetupDesc', synonyms: 'first run setup doctor diagnose' },
  { id: 'reset', tab: 'general', labelKey: 'settings.reset', synonyms: 'factory default wipe 초기화' },

  { id: 'terminal-engine', tab: 'terminal', labelKey: 'settings.terminalEngine', descKey: 'settings.terminalEngineDesc', synonyms: 'rust node engine pty buffer memory 러스트 엔진 메모리' },
  { id: 'shell', tab: 'terminal', labelKey: 'settings.defaultShell', synonyms: 'zsh bash powershell pwsh fish 셸' },
  { id: 'startdir', tab: 'terminal', labelKey: 'settings.startupDirectory', descKey: 'settings.startupDirectoryDesc', synonyms: 'cwd home folder path' },
  { id: 'splitcwd', tab: 'terminal', labelKey: 'settings.splitInheritsCwd', descKey: 'settings.splitInheritsCwdDesc', synonyms: 'cwd split inherit' },
  { id: 'closeonexit', tab: 'terminal', labelKey: 'settings.closeTabOnShellExit', descKey: 'settings.closeTabOnShellExitDesc', synonyms: 'exit close tab shell ctrl+d' },
  { id: 'plaindragselect', tab: 'terminal', labelKey: 'settings.plainDragSelect', descKey: 'settings.plainDragSelectDesc', synonyms: 'mouse drag select selection copy highlight codex tracking shift option alt 드래그 선택 마우스' },
  { id: 'ime', tab: 'terminal', labelKey: 'settings.imeResidueGuard', descKey: 'settings.imeResidueGuardDesc', synonyms: 'ime korean cjk hangul 한글 입력' },
  { id: 'retention', tab: 'terminal', labelKey: 'settings.hiddenPaneRetention', descKey: 'settings.hiddenPaneRetentionDesc', synonyms: 'hidden render cpu park' },
  { id: 'coldpark', tab: 'terminal', labelKey: 'settings.coldPark', descKey: 'settings.coldParkDesc', synonyms: 'memory ram park idle unmount' },
  { id: 'inlineimages', tab: 'terminal', labelKey: 'settings.inlineImages', descKey: 'settings.inlineImagesDesc', synonyms: 'image sixel iterm2 osc 1337 picture graphics inline 이미지 画像' },
  { id: 'scrollback', tab: 'terminal', labelKey: 'settings.scrollbackLines', descKey: 'settings.scrollbackDesc', synonyms: 'history buffer lines scroll' },
  { id: 'restore', tab: 'terminal', labelKey: 'settings.scrollbackRestore', descKey: 'settings.scrollbackRestoreDesc', synonyms: 'restore persist reboot' },
  { id: 'imagepaste', tab: 'terminal', labelKey: 'settings.imagePaste', descKey: 'settings.imagePasteDesc', synonyms: 'image paste screenshot clipboard png inline native wsl 이미지 붙여넣기 스크린샷 클립보드' },

  { id: 'theme', tab: 'appearance', labelKey: 'settings.theme', synonyms: 'color colour dark light palette 테마' },
  { id: 'fontsize', tab: 'appearance', labelKey: 'settings.fontSize', synonyms: 'type size zoom text 글자' },
  { id: 'fontfamily', tab: 'appearance', labelKey: 'settings.fontFamily', descKey: 'settings.fontFamilyDesc', synonyms: 'typeface mono cascadia jetbrains 폰트' },
  { id: 'cursorshape', tab: 'appearance', labelKey: 'settings.cursorShape', descKey: 'settings.cursorShapeDesc', synonyms: 'cursor caret bar block underline beam 커서 캐럿 막대 블록 shape type style' },
  { id: 'windowglass', tab: 'appearance', labelKey: 'settings.windowGlass', descKey: 'settings.windowGlassDesc', synonyms: 'transparent translucent transparency vibrancy acrylic blur glass opacity 투명 반투명 투명도 유리 블러', platform: ['darwin', 'win32'] },
  { id: 'chrome', tab: 'appearance', labelKey: 'settings.chromePreset', descKey: 'settings.chromePresetDesc', synonyms: 'density compact comfortable' },
  { id: 'sidebarpos', tab: 'appearance', labelKey: 'settings.sidebarPosition', descKey: 'settings.sidebarPositionDesc', synonyms: 'sidebar left right dock' },
  { id: 'sidebarattention', tab: 'appearance', labelKey: 'settings.sidebarSort', descKey: 'settings.sidebarSortDesc', synonyms: 'needs you waiting attention sort order recent activity manual pin top 대기 정렬 순서 최근' },
  { id: 'sidebarexplorerbutton', tab: 'appearance', labelKey: 'settings.sidebarShowExplorerButton', descKey: 'settings.sidebarShowExplorerButtonDesc', synonyms: 'sidebar folder file explorer finder open button hover 사이드바 폴더 탐색기 버튼' },
  { id: 'sidebarcopyinfobutton', tab: 'appearance', labelKey: 'settings.sidebarShowCopyInfoButton', descKey: 'settings.sidebarShowCopyInfoButtonDesc', synonyms: 'sidebar copy session info clipboard button hover 사이드바 세션 정보 복사 버튼' },
  { id: 'sidebarports', tab: 'appearance', labelKey: 'settings.sidebarShowPorts', descKey: 'settings.sidebarShowPortsDesc', synonyms: 'sidebar port ports localhost listening number 사이드바 포트 번호 표시' },
  { id: 'sidebarpanecoordinates', tab: 'appearance', labelKey: 'settings.sidebarShowPaneCoordinates', descKey: 'settings.sidebarShowPaneCoordinatesDesc', synonyms: 'roster coordinate w1-2 pane name label unnamed clutter agent' },
  { id: 'attentionblink', tab: 'appearance', labelKey: 'settings.attentionBlink', descKey: 'settings.attentionBlinkDesc', synonyms: 'blink pulse flash animate needs you waiting question approval remind 깜빡임 알림' },
  { id: 'attentionblinkfinished', tab: 'appearance', labelKey: 'settings.attentionBlinkFinished', descKey: 'settings.attentionBlinkFinishedDesc', synonyms: 'finished done dot turn complete pulse 완료 점' },
  { id: 'fleetlayout', tab: 'appearance', labelKey: 'settings.fleetLayout', descKey: 'settings.fleetLayoutDesc', synonyms: 'fleet board kanban columns list layout view 보드 칸반 목록 레이아웃' },
  { id: 'workspacesettleidle', tab: 'appearance', labelKey: 'settings.workspaceSettleIdleDays', descKey: 'settings.workspaceSettleIdleDaysDesc', synonyms: 'settle settled idle days finished snooze hide quiet sidebar 마무리 미뤄두기 유휴' },
  { id: 'multiview', tab: 'appearance', labelKey: 'settings.multiviewArrangement', descKey: 'settings.multiviewArrangementDesc', synonyms: 'grid split stack columns rows' },
  { id: 'uiscale', tab: 'appearance', labelKey: 'settings.uiScale', descKey: 'settings.uiScaleDesc', synonyms: 'zoom dpi accessibility scale 배율' },
  { id: 'titlebarvitals', tab: 'appearance', labelKey: 'settings.titlebarVitals', descKey: 'settings.titlebarVitalsDesc', synonyms: 'memory ram cpu usage gauge chip titlebar status vitals 메모리 사용량 타이틀바' },
  { id: 'toolbar', tab: 'appearance', labelKey: 'settings.agentToolbarShow', descKey: 'settings.agentToolbarShowDesc', synonyms: 'toolbar compose files snippets schedule multi task' },

  { id: 'sound', tab: 'notifications', labelKey: 'settings.sound', descKey: 'settings.soundDesc', synonyms: 'sound audio beep alarm 소리' },
  { id: 'toast', tab: 'notifications', labelKey: 'settings.toast', descKey: 'settings.toastDesc', synonyms: 'toast popup banner' },
  { id: 'osnotify', tab: 'notifications', labelKey: 'settings.ring', descKey: 'settings.ringDesc', synonyms: 'system toast windows macos banner' },
  { id: 'catmute', tab: 'notifications', labelKey: 'settings.notificationCategories', descKey: 'settings.notificationCategoriesDesc', synonyms: 'mute category subagent approval' },
  { id: 'wsmute', tab: 'notifications', labelKey: 'settings.perWorkspaceNotifications', descKey: 'settings.perWorkspaceNotificationsDesc', synonyms: 'mute workspace quiet' },
  { id: 'wsprwake', tab: 'notifications', labelKey: 'settings.prWake', descKey: 'settings.prWakeDesc', synonyms: 'pull request ci checks review comment conflict nudge agent' },

  { id: 'quicklaunch', tab: 'shortcuts', labelKey: 'settings.quickLaunch', descKey: 'settings.quickLaunchDesc', synonyms: 'quick launch global shortcut hotkey composer spotlight launcher prompt 빠른 실행 전역 단축키' },
  { id: 'quicklaunchkey', tab: 'shortcuts', labelKey: 'settings.quickLaunchShortcut', descKey: 'settings.quickLaunchShortcutDesc', synonyms: 'quick launch global hotkey cmd shift space 빠른 실행 단축키' },
  { id: 'prefix', tab: 'shortcuts', labelKey: 'settings.prefixKey', synonyms: 'prefix tmux ctrl+b leader' },
  { id: 'customkeys', tab: 'shortcuts', labelKey: 'settings.customKeybindings', synonyms: 'hotkey shortcut keymap bind 단축키' },

  { id: 'plugin', tab: 'claude-integration', labelKey: 'claudeIntegration.signalHealth.title', synonyms: 'integration hook plugin setup install claude 계정' },
  { id: 'setup', tab: 'claude-integration', labelKey: 'integrationSetup.title', descKey: 'integrationSetup.description', synonyms: 'hooks hook bridge statusline status line mcp install setup 훅 설치' },
  { id: 'usage', tab: 'claude-integration', labelKey: 'claudeIntegration.usage.title', descKey: 'claudeIntegration.usage.description', synonyms: 'usage quota limit 5h 7d meter anthropic 사용량' },
  { id: 'usagelimitresume', tab: 'claude-integration', labelKey: 'claudeIntegration.usageLimit.autoResume', descKey: 'claudeIntegration.usageLimit.autoResumeDesc', synonyms: 'usage limit rate resume continue reset pause codex 한도 이어가기 재개' },
  { id: 'clauderesumeonstart', tab: 'claude-integration', labelKey: 'claudeIntegration.resumeOnStart', descKey: 'claudeIntegration.resumeOnStartDesc', synonyms: 'resume restart recover continue launch boot session 재시작 이어가기 복원' },
  { id: 'mcp', tab: 'claude-integration', labelKey: 'settings.mcpServers', synonyms: 'mcp plugin tools broker register codex' },

  { id: 'claudeacct', tab: 'accounts', labelKey: 'accounts.title', synonyms: 'claude account login subscription max usage quota 계정' },

  { id: 'factoryswitch', tab: 'factory', labelKey: 'settings.factory.enabled', descKey: 'settings.factory.enabledDesc', synonyms: 'bots run bots factory agent on off enable rooms 봇 실행 공장' },
  { id: 'factorytrustedauthors', tab: 'factory', labelKey: 'settings.factory.trustedAuthors', descKey: 'settings.factory.trustedAuthorsDesc', synonyms: 'trusted author login github verifier pr' },
  { id: 'factorymorning', tab: 'factory', labelKey: 'settings.factory.morning', descKey: 'settings.factory.morningDesc', synonyms: 'morning report time schedule weekday wake 아침 보고' },
  { id: 'factoryverifierownprs', tab: 'factory', labelKey: 'settings.factory.verifierOwnPrs', descKey: 'settings.factory.verifierOwnPrsDesc', synonyms: 'verifier own pull request owner verify' },
  { id: 'factoryengine', tab: 'factory', labelKey: 'settings.factory.engine', descKey: 'settings.factory.engineDesc', synonyms: 'engine claude sdk pty acp hermes command bot runtime' },
  { id: 'factoryclaudeauth', tab: 'factory', labelKey: 'settings.factory.claudeAuth.mode', descKey: 'settings.factory.claudeAuth.modeDesc', synonyms: 'api key anthropic claude subscription sign in login billing connection check 연결 키 구독 로그인' },
  { id: 'factoryconcurrency', tab: 'factory', labelKey: 'settings.factory.concurrency', descKey: 'settings.factory.concurrencyDesc', synonyms: 'concurrent bots limit cap parallel turn' },
  { id: 'factorymaxagents', tab: 'factory', labelKey: 'settings.factory.maxAgents', descKey: 'settings.factory.maxAgentsDesc', synonyms: 'agents workers memory budget slots limit cap queue' },
  { id: 'factorycommandreviewer', tab: 'factory', labelKey: 'bots.commands.reviewerSetting', synonyms: 'bot command reviewer review unlisted shell sandbox model 명령 검토' },
  { id: 'factorylaneautomerge', tab: 'factory', labelKey: 'settings.factory.laneAutoMerge', descKey: 'settings.factory.laneAutoMergeDesc', synonyms: 'merge lane auto merge automatic pull request verifier ci 자동 머지' },
  { id: 'factorylanedailycap', tab: 'factory', labelKey: 'settings.factory.laneDailyCap', descKey: 'settings.factory.laneDailyCapDesc', synonyms: 'merge lane daily cap limit per day' },
  { id: 'factoryphonebot', tab: 'factory', labelKey: 'settings.factory.phoneBot', descKey: 'settings.factory.phoneBotDesc', synonyms: 'phone mobile ios bot addressee moa coordinator 폰 휴대폰' },
  { id: 'factorybots', tab: 'factory', labelKey: 'settings.factory.bots', descKey: 'settings.factory.botsDesc', synonyms: 'bots add bot profile lead triage verifier maintainer budget workspace repository 봇 추가' },
  { id: 'factoryconnections', tab: 'factory', labelKey: 'settings.factory.connections.section', descKey: 'settings.factory.connections.sectionDesc', synonyms: 'connections connectors mcp server tools github filesystem 연결 커넥터 서버 도구' },
  { id: 'factorykeys', tab: 'factory', labelKey: 'settings.factory.keys', descKey: 'settings.factory.keysDesc', synonyms: 'keys secrets api key token env environment variable credential 키 비밀 토큰' },

  { id: 'roles', tab: 'roles', labelKey: 'settings.roleBindings', descKey: 'settings.roleBindingsDesc', synonyms: 'role reviewer tester planner model bind' },
  { id: 'a2a', tab: 'roles', labelKey: 'settings.a2aAutoApproveExecute', descKey: 'settings.a2aAutoApproveExecuteDesc', synonyms: 'a2a execute approve' },
  { id: 'fanoutapproval', tab: 'roles', labelKey: 'settings.fanoutRequireApproval', descKey: 'settings.fanoutRequireApprovalDesc', synonyms: 'fanout fan-out approval approve prompt unattended ask' },
  { id: 'fanoutagytrust', tab: 'roles', labelKey: 'settings.fanoutTrustAgyFolders', descKey: 'settings.fanoutTrustAgyFoldersDesc', synonyms: 'agy antigravity trust trusted folder workspace fanout fan-out' },
  { id: 'fanoutworkers', tab: 'roles', labelKey: 'settings.fanoutWorkerPermissionMode', descKey: 'settings.fanoutWorkerPermissionModeDesc', synonyms: 'fanout fan-out worker permission auto bypass sandbox' },
  { id: 'fanoutpresets', tab: 'roles', labelKey: 'settings.fanoutPresets', descKey: 'settings.fanoutPresetsDesc', synonyms: 'fanout fan-out preset image video agents codex grok output folder worktree' },
  { id: 'fanoutallowtools', tab: 'roles', labelKey: 'settings.fanoutAllowWorkerTools', descKey: 'settings.fanoutAllowWorkerToolsDesc', synonyms: 'fanout worker allow tools permissions settings.json' },

  { id: 'tokenprofile', tab: 'tokens', labelKey: 'settings.tokenProfile', descKey: 'settings.tokenProfileDesc', synonyms: 'token usage cost cheap minimal balanced effort model profile' },

  { id: 'browserbackend', tab: 'browser', labelKey: 'settings.browserBackend', descKey: 'settings.browserBackendDesc', synonyms: 'browser chrome chromium external builtin' },
  { id: 'browserlight', tab: 'browser', labelKey: 'settings.browserLightweight', descKey: 'settings.browserLightweightDesc', synonyms: 'browser throttle cpu lightweight' },
  { id: 'sitememory', tab: 'browser', labelKey: 'settings.siteMemory', descKey: 'settings.siteMemoryDesc', synonyms: 'browser site memory domain replay failure remember' },
  { id: 'computeruse', tab: 'computer-use', labelKey: 'settings.computerUse', descKey: 'settings.computerUseDesc', synonyms: 'computer use desktop control apps screenshot click automation 컴퓨터 사용 데스크톱 조작' },
  { id: 'computerusehelper', tab: 'computer-use', labelKey: 'settings.computerUseHelper', descKey: 'settings.computerUseHelperDesc', synonyms: 'computer use helper native uia accessibility screen recording permissions reset access tcc 헬퍼 권한 화면 기록' },
  { id: 'computerusestop', tab: 'computer-use', labelKey: 'settings.computerUseStopKey', descKey: 'settings.computerUseStopKeyDesc', synonyms: 'computer use stop abort kill emergency hotkey 정지 중단' },
  { id: 'computeruseask', tab: 'computer-use', labelKey: 'settings.computerUseConsent', descKey: 'settings.computerUseConsentDesc', synonyms: 'computer use consent ask each app prompt permission 앱마다 묻기 동의' },
  { id: 'computeruseoverlay', tab: 'computer-use', labelKey: 'settings.computerUseOverlay', descKey: 'settings.computerUseOverlayDesc', synonyms: 'computer use agent cursor halo overlay highlight 테두리' },
  { id: 'siteguides', tab: 'browser', labelKey: 'settings.siteGuides', descKey: 'settings.siteGuidesDesc', synonyms: 'browser site guides notes chrome agent' },

  { id: 'paireddevices', tab: 'remote', labelKey: 'web.devicesTitle', descKey: 'web.devicesSubtitle', synonyms: 'phone mobile device paired revoke remote web 휴대폰 기기' },
  { id: 'quickcommands', tab: 'remote', labelKey: 'settings.quickCommands', synonyms: 'quick command snippet phone reusable instruction 빠른 명령' },

  { id: 'lanenable', tab: 'lanlink', labelKey: 'settings.lanlinkEnable', descKey: 'settings.lanlinkEnableDesc', synonyms: 'lan link network peer remote pair' },
  { id: 'lannic', tab: 'lanlink', labelKey: 'settings.lanlinkNic', descKey: 'settings.lanlinkNicDesc', synonyms: 'nic interface ethernet wifi mac' },
  { id: 'lanpair', tab: 'lanlink', labelKey: 'settings.lanlinkPair', synonyms: 'pin pair join revoke peer' },

  { id: 'version', tab: 'about', labelKey: 'settings.aboutTagline', synonyms: 'version about changelog release 버전' },
];
