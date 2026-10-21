import type { Connector, ConnectorDraft } from './botConnector';

/** Endpoint configuration authored from vendor documentation, checked 2026-10-20.
 * No vendor server code is bundled. Hosted services retain their own terms.
 * Entries are setup recipes, not claims of account-level E2E certification.
 */
export interface ConnectorService {
  id: string;
  name: string;
  category: 'communication' | 'productivity' | 'files' | 'development' | 'design' | 'business';
  url: string;
  documentation: string;
  setup: 'oauth' | 'google' | 'slack' | 'client' | 'paypal';
}
export const CONNECTOR_SERVICES: readonly ConnectorService[] = [
  {"id": "gmail", "name": "Gmail", "category": "communication", "url": "https://gmailmcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-calendar", "name": "Google Calendar", "category": "productivity", "url": "https://calendarmcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-drive", "name": "Google Drive", "category": "files", "url": "https://drivemcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-docs", "name": "Google Docs", "category": "files", "url": "https://docsmcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-sheets", "name": "Google Sheets", "category": "files", "url": "https://sheetsmcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-slides", "name": "Google Slides", "category": "files", "url": "https://slidesmcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-chat", "name": "Google Chat", "category": "communication", "url": "https://chatmcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-contacts", "name": "Google Contacts", "category": "productivity", "url": "https://people.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "google-classroom", "name": "Google Classroom", "category": "productivity", "url": "https://classroommcp.googleapis.com/mcp/v1", "documentation": "https://developers.google.com/workspace/guides/configure-mcp-servers", "setup": "google"},
  {"id": "slack", "name": "Slack", "category": "communication", "url": "https://mcp.slack.com/mcp", "documentation": "https://docs.slack.dev/ai/slack-mcp-server/", "setup": "slack"},
  {"id": "notion", "name": "Notion", "category": "productivity", "url": "https://mcp.notion.com/mcp", "documentation": "https://developers.notion.com/guides/mcp/get-started-with-mcp", "setup": "oauth"},
  {"id": "linear", "name": "Linear", "category": "development", "url": "https://mcp.linear.app/mcp", "documentation": "https://linear.app/docs/mcp", "setup": "oauth"},
  {"id": "atlassian", "name": "Atlassian (Jira, Confluence, Bitbucket)", "category": "development", "url": "https://mcp.atlassian.com/v2/mcp", "documentation": "https://atlassian.github.io/atlassian-mcp-server/", "setup": "oauth"},
  {"id": "figma", "name": "Figma", "category": "design", "url": "https://mcp.figma.com/mcp", "documentation": "https://help.figma.com/hc/en-us/articles/39216419318551-Get-started-with-the-Figma-MCP-server", "setup": "oauth"},
  {"id": "asana", "name": "Asana", "category": "productivity", "url": "https://mcp.asana.com/v2/command/mcp", "documentation": "https://developers.asana.com/docs/using-asanas-command-mcp-server", "setup": "oauth"},
  {"id": "sentry", "name": "Sentry", "category": "development", "url": "https://mcp.sentry.dev/mcp", "documentation": "https://mcp.sentry.dev/", "setup": "oauth"},
  {"id": "stripe", "name": "Stripe", "category": "business", "url": "https://mcp.stripe.com", "documentation": "https://docs.stripe.com/mcp", "setup": "oauth"},
  {"id": "vercel", "name": "Vercel", "category": "development", "url": "https://mcp.vercel.com", "documentation": "https://vercel.com/docs/agent-resources/vercel-mcp", "setup": "oauth"},
  {"id": "supabase", "name": "Supabase", "category": "development", "url": "https://mcp.supabase.com/mcp?read_only=true", "documentation": "https://supabase.com/docs/guides/ai-tools/mcp", "setup": "oauth"},
  {"id": "cloudflare", "name": "Cloudflare", "category": "development", "url": "https://mcp.cloudflare.com/mcp", "documentation": "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/", "setup": "oauth"},
  {"id": "canva", "name": "Canva", "category": "design", "url": "https://mcp.canva.com/mcp", "documentation": "https://www.canva.dev/docs/apps/mcp/verify-app/", "setup": "oauth"},
  {"id": "hubspot", "name": "HubSpot", "category": "business", "url": "https://mcp.hubspot.com", "documentation": "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server", "setup": "client"},
  {"id": "paypal", "name": "PayPal Sandbox", "category": "business", "url": "https://mcp.sandbox.paypal.com/http", "documentation": "https://developer.paypal.com/ai-tools/mcp-server", "setup": "paypal"},
  {"id": "dropbox", "name": "Dropbox", "category": "files", "url": "https://mcp.dropbox.com/mcp", "documentation": "https://help.dropbox.com/integrations/connect-dropbox-mcp-server", "setup": "oauth"},
 ];

/** Whether a connection is a sign-in service of the catalog (its endpoint is
 *  a CONNECTOR_SERVICES one, and it holds no key of its own): such a
 *  connection reaches a worker only through the gateway
 *  (main/connectors/workerGateway.ts), never directly. Pure. */
export function isSignInService(c: Pick<Connector, 'transport' | 'remote' | 'secrets'>): boolean {
  if (c.transport !== 'http' || !c.remote || c.secrets.length > 0) return false;
  if (Object.keys(c.remote.headers).some((h) => /authorization|cookie/i.test(h))) return false;
  return CONNECTOR_SERVICES.some((s) => s.url === c.remote!.url);
}

/** A recipe grants no tools or bot access and never installs a server. */
export function serviceConnectorDraft(service: ConnectorService): ConnectorDraft {
  return {
    name: service.id, transport: 'http', remote: { url: service.url, headers: {} },
    secrets: [], tools: { mode: 'listed', allowed: [] },
    scope: { kind: 'bots', botIds: [] },
    enabled: false,
  };
}
