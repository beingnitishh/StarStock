import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { HttpError } from "./api";
import type { SessionUser } from "./auth";
import { OAUTH_WRITE_SCOPE, verifyAccessToken } from "./oauth";
import { canWriteStock, ROLES, type Role } from "./roles";
import { normalizeApplicationSource, type ApplicationSource } from "./source-app";

export type McpWriter = {
  user: SessionUser;
  sourceApp: ApplicationSource;
  clientId: string;
};

/**
 * Re-verifies the opaque bearer token at tool execution time. This deliberately
 * does not use a role/user/source supplied in tool arguments or stale auth
 * metadata: verifyAccessToken re-reads the token, active account, current role,
 * and server-held OAuth client registration.
 */
export async function requireMcpWriter(authInfo: AuthInfo | undefined): Promise<McpWriter> {
  if (!authInfo?.token) {
    throw new HttpError(401, "Not authenticated. Connect with a valid StarStock OAuth token.");
  }
  const verified = await verifyAccessToken(authInfo.token);
  if (!verified) {
    throw new HttpError(401, "Your StarStock OAuth token is invalid, expired, or no longer active.");
  }
  if (!verified.scopes.includes(OAUTH_WRITE_SCOPE)) {
    throw new HttpError(
      403,
      "This connection has read-only OAuth scope. Reconnect and approve starstock.write to change inventory.",
    );
  }

  const userId = verified.extra?.userId;
  const username = verified.extra?.username;
  const displayName = verified.extra?.displayName;
  const rawRole = verified.extra?.role;
  if (
    typeof userId !== "number" ||
    !Number.isInteger(userId) ||
    typeof username !== "string" ||
    typeof displayName !== "string" ||
    typeof rawRole !== "string" ||
    !ROLES.includes(rawRole as Role)
  ) {
    throw new HttpError(401, "The authenticated StarStock account could not be resolved.");
  }

  const role = rawRole as Role;
  if (!canWriteStock(role)) {
    throw new HttpError(
      403,
      "Your Member account is read-only. You can view stock but not make changes.",
    );
  }

  return {
    user: { id: userId, username, displayName, role },
    sourceApp: normalizeApplicationSource(verified.extra?.sourceApp),
    clientId: verified.clientId,
  };
}
