export const BROWSER_TABS_ACTIONS = ['list', 'new', 'select', 'close'] as const;

export type BrowserTabsAction = (typeof BROWSER_TABS_ACTIONS)[number];

export interface BrowserTabDescriptor {
  /** Stable wmux browser-surface identity. Never a list index or CDP target id. */
  surfaceId: string;
  /** Leaf pane that owns the browser surface. */
  paneId: string;
  /** Last URL persisted on the logical browser surface. */
  url: string;
  /** Last logical surface title (currently usually "Browser"). */
  title: string;
  /** Active surface of the workspace's active pane. */
  selected: boolean;
}

export const BROWSER_TABS_ERROR_CODES = [
  'BROWSER_TABS_WORKSPACE_UNRESOLVED',
  'BROWSER_TABS_UNSUPPORTED',
  'BROWSER_TABS_UNAVAILABLE',
  'BROWSER_TABS_INVALID_ARGUMENT',
  'BROWSER_TAB_NOT_FOUND',
  'BROWSER_TAB_URL_BLOCKED',
  'BROWSER_TAB_CREATE_FAILED',
] as const;

export type BrowserTabsErrorCode = (typeof BROWSER_TABS_ERROR_CODES)[number];

export interface BrowserTabsErrorResult {
  ok: false;
  error: {
    code: BrowserTabsErrorCode;
    message: string;
  };
}

export type BrowserTabsSuccessResult =
  | { ok: true; action: 'list'; tabs: BrowserTabDescriptor[] }
  | { ok: true; action: 'new'; tab: BrowserTabDescriptor }
  | { ok: true; action: 'select'; tab: BrowserTabDescriptor }
  | { ok: true; action: 'close'; closed: BrowserTabDescriptor };

export type BrowserTabsResult = BrowserTabsSuccessResult | BrowserTabsErrorResult;

export function browserTabsError(
  code: BrowserTabsErrorCode,
  message: string,
): BrowserTabsErrorResult {
  return { ok: false, error: { code, message } };
}

function isBrowserTabDescriptor(value: unknown): value is BrowserTabDescriptor {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab['surfaceId'] === 'string'
    && tab['surfaceId'].length > 0
    && typeof tab['paneId'] === 'string'
    && tab['paneId'].length > 0
    && typeof tab['url'] === 'string'
    && typeof tab['title'] === 'string'
    && typeof tab['selected'] === 'boolean'
  );
}

export function isBrowserTabsResult(value: unknown): value is BrowserTabsResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (result['ok'] === true) {
    switch (result['action']) {
      case 'list':
        return (
          Array.isArray(result['tabs'])
          && result['tabs'].every(isBrowserTabDescriptor)
        );
      case 'new':
      case 'select':
        return isBrowserTabDescriptor(result['tab']);
      case 'close':
        return isBrowserTabDescriptor(result['closed']);
      default:
        return false;
    }
  }
  if (result['ok'] !== false || !result['error'] || typeof result['error'] !== 'object') {
    return false;
  }
  const error = result['error'] as Record<string, unknown>;
  return (
    typeof error['code'] === 'string'
    && (BROWSER_TABS_ERROR_CODES as readonly string[]).includes(error['code'])
    && typeof error['message'] === 'string'
  );
}
