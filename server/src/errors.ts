/** An Error that sendError() turns into an HTTP status. */
export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** OpenCode's answer to a reply for a permission request it no longer holds. */
export function permissionGone(error: unknown): boolean {
  if (!error) return false;
  return /PermissionNotFound|Permission request not found/i.test(typeof error === "string" ? error : JSON.stringify(error));
}
