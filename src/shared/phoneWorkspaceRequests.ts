/** Retain issued request IDs even after their workspace is closed or archived. */
export const PHONE_WORKSPACE_REQUEST_LIMIT = 10_000;
export function isPhoneWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && /^ws-phone-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
