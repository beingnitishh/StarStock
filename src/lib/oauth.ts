import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { db } from "@/db";
import {
  oauthClients,
  oauthCodes,
  oauthRegistrations,
  oauthTokens,
  users,
} from "@/db/schema";

/**
 * Minimal OAuth 2.1 authorization server for the StarStock MCP endpoint.
 *
 * Only what an MCP client (ChatGPT / Claude custom connectors) needs:
 *   - dynamic client registration (public clients, no secret)
 *   - authorization code + PKCE (S256 only)
 *   - refresh tokens with rotation
 *
 * Codes and tokens are opaque random strings. Only their SHA-256 hashes are
 * persisted, so the database never contains a usable credential. The tables
 * are declared in `src/db/schema.ts`; they are also created on demand below so
 * a deployment without a migration step still works.
 */

export const OAUTH_SCOPE = "starstock.read";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const AUTH_CODE_TTL_SECONDS = 10 * 60; // 10 minutes

/** Dynamic client registration is limited per IP to stop table flooding. */
export const REGISTRATION_MAX_PER_HOUR = 10;
export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
export const REGISTRATION_RATE_LIMIT_MESSAGE =
  "Too many app registrations from this address. Please try again later.";

/** Unused clients (never completed an authorization) are pruned after a day. */
const CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Registration rows older than the window never affect the limit. */
const REGISTRATION_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Thrown for protocol-level failures; rendered as an OAuth error response. */
export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "OAuthError";
  }

  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

export type OAuthClientRecord = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
};

/* ------------------------------- primitives ------------------------------- */

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(prefix: string): string {
  return `${prefix}${base64Url(randomBytes(32))}`;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * PKCE check (RFC 7636). Only S256 is supported: `code_challenge` must equal
 * base64url(sha256(code_verifier)).
 */
export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  if (method !== "S256") return false;
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const computed = base64Url(createHash("sha256").update(codeVerifier).digest());
  return safeEqual(computed, codeChallenge);
}

/** True when the string is a redirect URI we are willing to register. */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  // Loopback HTTP is allowed for clients that cannot get a certificate
  // (the MCP Inspector and other local tools). Everything else must be https.
  if (url.protocol === "http:") {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  }
  return false;
}

/* ------------------------------ table setup ------------------------------- */

const globalForOAuth = globalThis as typeof globalThis & {
  __starstockOAuthTables?: Promise<void>;
};

const CREATE_TABLES_SQL = [
  sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id serial PRIMARY KEY,
      client_id text NOT NULL UNIQUE,
      client_name text NOT NULL DEFAULT '',
      redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
      grant_types jsonb NOT NULL DEFAULT '["authorization_code", "refresh_token"]'::jsonb,
      token_endpoint_auth_method text NOT NULL DEFAULT 'none',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash text PRIMARY KEY,
      client_id text NOT NULL,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      code_challenge text NOT NULL,
      code_challenge_method text NOT NULL DEFAULT 'S256',
      scope text NOT NULL DEFAULT '',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash text PRIMARY KEY,
      kind text NOT NULL,
      client_id text NOT NULL,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope text NOT NULL DEFAULT '',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `,
  sql`
    CREATE TABLE IF NOT EXISTS oauth_registrations (
      id serial PRIMARY KEY,
      ip text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `,
  sql`
    CREATE INDEX IF NOT EXISTS oauth_registrations_ip_created_idx
      ON oauth_registrations (ip, created_at)
  `,
  sql`CREATE INDEX IF NOT EXISTS oauth_tokens_user_idx ON oauth_tokens (user_id)`,
  sql`CREATE INDEX IF NOT EXISTS oauth_tokens_client_idx ON oauth_tokens (client_id)`,
];

export function ensureOAuthTables(): Promise<void> {
  if (!globalForOAuth.__starstockOAuthTables) {
    globalForOAuth.__starstockOAuthTables = (async () => {
      for (const statement of CREATE_TABLES_SQL) {
        await db.execute(statement);
      }
    })().catch((e) => {
      delete globalForOAuth.__starstockOAuthTables;
      throw e;
    });
  }
  return globalForOAuth.__starstockOAuthTables;
}

/* --------------------------------- clients -------------------------------- */

/**
 * Deletes clients registered more than 24 hours ago that were never used: no
 * tokens issued and no authorization code outstanding. Clients that completed
 * (or are mid-way through) a flow are kept.
 */
async function deleteUnusedOAuthClients(): Promise<void> {
  const cutoff = new Date(Date.now() - CLIENT_RETENTION_MS);
  await db.delete(oauthClients).where(
    and(
      lt(oauthClients.createdAt, cutoff),
      sql`NOT EXISTS (SELECT 1 FROM ${oauthTokens} WHERE ${oauthTokens.clientId} = ${oauthClients.clientId})`,
      sql`NOT EXISTS (SELECT 1 FROM ${oauthCodes} WHERE ${oauthCodes.clientId} = ${oauthClients.clientId})`,
    ),
  );
}

/** True when this IP has already created the maximum clients this hour. */
export async function isRegistrationRateLimited(ip: string): Promise<boolean> {
  if (!ip) return false;
  try {
    await ensureOAuthTables();
    const since = new Date(Date.now() - REGISTRATION_WINDOW_MS);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(oauthRegistrations)
      .where(
        and(eq(oauthRegistrations.ip, ip), gte(oauthRegistrations.createdAt, since)),
      );
    return (row?.count ?? 0) >= REGISTRATION_MAX_PER_HOUR;
  } catch (e) {
    // Never block a legitimate client because the limiter itself failed.
    console.error("[oauth] could not check the registration rate limit", e);
    return false;
  }
}

/** Records one successful registration for this IP and prunes old rows. */
export async function recordOAuthRegistration(ip: string): Promise<void> {
  try {
    await ensureOAuthTables();
    await db.insert(oauthRegistrations).values({ ip });
    await db
      .delete(oauthRegistrations)
      .where(
        lt(
          oauthRegistrations.createdAt,
          new Date(Date.now() - REGISTRATION_RETENTION_MS),
        ),
      );
  } catch (e) {
    // The client is already registered; a missing counter row is tolerable.
    console.error("[oauth] could not record a client registration", e);
  }
}

export async function registerOAuthClient(input: {
  clientName: string;
  redirectUris: string[];
  grantTypes?: string[];
}): Promise<OAuthClientRecord> {
  await ensureOAuthTables();
  // Housekeeping: drop stale, never-used client registrations.
  await deleteUnusedOAuthClients();
  const clientId = randomToken("ss_client_");
  const clientName = input.clientName.trim().slice(0, 120) || "MCP client";
  const [row] = await db
    .insert(oauthClients)
    .values({
      clientId,
      clientName,
      redirectUris: input.redirectUris,
      grantTypes:
        input.grantTypes && input.grantTypes.length > 0
          ? input.grantTypes
          : ["authorization_code", "refresh_token"],
    })
    .returning({
      clientId: oauthClients.clientId,
      clientName: oauthClients.clientName,
      redirectUris: oauthClients.redirectUris,
    });
  return row;
}

export async function getOAuthClient(
  clientId: string,
): Promise<OAuthClientRecord | null> {
  if (!clientId) return null;
  await ensureOAuthTables();
  const rows = await db
    .select({
      clientId: oauthClients.clientId,
      clientName: oauthClients.clientName,
      redirectUris: oauthClients.redirectUris,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return rows[0] ?? null;
}

/* ----------------------------- authorization ------------------------------ */

export async function createAuthorizationCode(input: {
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}): Promise<string> {
  await ensureOAuthTables();
  const code = randomToken("ss_code_");
  await db.insert(oauthCodes).values({
    codeHash: sha256Hex(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000),
  });
  // Opportunistic cleanup of codes that can no longer be redeemed.
  await db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date()));
  return code;
}

/**
 * Redeems an authorization code. Codes are single-use: the row is removed as
 * soon as it is read, whether or not the rest of the exchange succeeds.
 */
export async function redeemAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ userId: number; scope: string }> {
  await ensureOAuthTables();
  const codeHash = sha256Hex(input.code);
  const [row] = await db
    .delete(oauthCodes)
    .where(eq(oauthCodes.codeHash, codeHash))
    .returning();

  if (!row) {
    throw new OAuthError("invalid_grant", "That authorization code is unknown or was already used.");
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new OAuthError("invalid_grant", "That authorization code has expired. Start again.");
  }
  if (row.clientId !== input.clientId) {
    throw new OAuthError("invalid_grant", "That code was issued to a different client.");
  }
  if (row.redirectUri !== input.redirectUri) {
    throw new OAuthError("invalid_grant", "The redirect_uri does not match the one used to authorize.");
  }
  if (!verifyPkce(input.codeVerifier, row.codeChallenge, row.codeChallengeMethod)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed.");
  }

  const [user] = await db
    .select({ active: users.active })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user || !user.active) {
    throw new OAuthError("invalid_grant", "That account is no longer active.");
  }
  return { userId: row.userId, scope: row.scope };
}

/* --------------------------------- tokens --------------------------------- */

export type IssuedTokens = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

async function persistTokenPair(
  clientId: string,
  userId: number,
  scope: string,
): Promise<IssuedTokens> {
  const accessToken = randomToken("ss_at_");
  const refreshToken = randomToken("ss_rt_");
  const now = Date.now();
  await db.insert(oauthTokens).values([
    {
      tokenHash: sha256Hex(accessToken),
      kind: "access" as const,
      clientId,
      userId,
      scope,
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000),
    },
    {
      tokenHash: sha256Hex(refreshToken),
      kind: "refresh" as const,
      clientId,
      userId,
      scope,
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1000),
    },
  ]);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  };
}

export async function issueTokens(
  clientId: string,
  userId: number,
  scope: string,
): Promise<IssuedTokens> {
  await ensureOAuthTables();
  await db.delete(oauthTokens).where(lt(oauthTokens.expiresAt, new Date()));
  return persistTokenPair(clientId, userId, scope);
}

/** Rotates a refresh token: the presented token is deleted, a new pair issued. */
export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string,
): Promise<IssuedTokens> {
  await ensureOAuthTables();
  const [row] = await db
    .delete(oauthTokens)
    .where(
      and(
        eq(oauthTokens.tokenHash, sha256Hex(refreshToken)),
        eq(oauthTokens.kind, "refresh"),
      ),
    )
    .returning();

  if (!row) {
    throw new OAuthError("invalid_grant", "That refresh token is unknown or was already used.");
  }
  if (row.clientId !== clientId) {
    throw new OAuthError("invalid_grant", "That refresh token was issued to a different client.");
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new OAuthError("invalid_grant", "That refresh token has expired. Sign in again.");
  }

  const [user] = await db
    .select({ active: users.active })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user || !user.active) {
    throw new OAuthError("invalid_grant", "That account is no longer active.");
  }
  return persistTokenPair(row.clientId, row.userId, row.scope);
}

/** Revokes every token issued to a user (called when an account is removed). */
export async function revokeUserOAuthTokens(userId: number): Promise<void> {
  await ensureOAuthTables();
  await db.delete(oauthTokens).where(eq(oauthTokens.userId, userId));
  await db.delete(oauthCodes).where(eq(oauthCodes.userId, userId));
}

/**
 * Resolves a Bearer access token to the account it was issued for.
 *
 * Returns `undefined` for unknown, expired or revoked tokens, and also when
 * the account has been deactivated — a removed user loses MCP access at once.
 */
export async function verifyAccessToken(
  token: string | undefined,
): Promise<AuthInfo | undefined> {
  if (!token) return undefined;
  await ensureOAuthTables();
  const rows = await db
    .select({
      clientId: oauthTokens.clientId,
      scope: oauthTokens.scope,
      expiresAt: oauthTokens.expiresAt,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      active: users.active,
    })
    .from(oauthTokens)
    .innerJoin(users, eq(oauthTokens.userId, users.id))
    .where(
      and(
        eq(oauthTokens.tokenHash, sha256Hex(token)),
        eq(oauthTokens.kind, "access"),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(oauthTokens).where(eq(oauthTokens.tokenHash, sha256Hex(token)));
    return undefined;
  }
  if (!row.active) return undefined;

  return {
    token,
    clientId: row.clientId,
    scopes: row.scope ? row.scope.split(/\s+/).filter(Boolean) : [],
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    extra: {
      userId: row.userId,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
    },
  };
}
