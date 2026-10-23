import { and, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { loginAttempts } from "@/db/schema";

/**
 * Login rate limiting.
 *
 * Every failed sign-in is stored in `login_attempts` (username, IP, time).
 * Once five failures have happened within fifteen minutes for the same
 * username *or* the same IP, further attempts are rejected with 429 until the
 * oldest failures fall out of the window.
 *
 * The table is created on demand (`CREATE TABLE IF NOT EXISTS`) so a
 * deployment without a migration step still throttles brute-force attempts;
 * the definition also lives in `src/db/schema.ts` for Drizzle.
 */

export const LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_WINDOW_MS = LOGIN_WINDOW_MINUTES * 60 * 1000;
export const LOGIN_RATE_LIMIT_MESSAGE = `Too many failed sign-in attempts. Please wait ${LOGIN_WINDOW_MINUTES} minutes and try again.`;

/** Failed attempts are pruned after this long; they never affect the limit. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

const globalForLoginAttempts = globalThis as typeof globalThis & {
  __starstockLoginAttemptsTable?: Promise<void>;
};

const CREATE_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS login_attempts (
    id serial PRIMARY KEY,
    username text NOT NULL DEFAULT '',
    ip text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;

const CREATE_INDEX_SQL = sql`
  CREATE INDEX IF NOT EXISTS login_attempts_created_idx
    ON login_attempts (created_at)
`;

function ensureLoginAttemptsTable(): Promise<void> {
  if (!globalForLoginAttempts.__starstockLoginAttemptsTable) {
    globalForLoginAttempts.__starstockLoginAttemptsTable = (async () => {
      await db.execute(CREATE_TABLE_SQL);
      await db.execute(CREATE_INDEX_SQL);
    })().catch((e) => {
      // Allow a later request to retry (e.g. transient connection failure).
      delete globalForLoginAttempts.__starstockLoginAttemptsTable;
      throw e;
    });
  }
  return globalForLoginAttempts.__starstockLoginAttemptsTable;
}

/**
 * Best-effort client IP. Vercel (and most proxies) put the caller first in
 * `x-forwarded-for`; returns an empty string when nothing is available, in
 * which case only the username is rate-limited.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "";
}

/** True when this username or IP has hit the failure limit in the window. */
export async function isLoginRateLimited(
  username: string,
  ip: string,
): Promise<boolean> {
  try {
    const matches: SQL[] = [];
    if (username) matches.push(eq(loginAttempts.username, username));
    if (ip) matches.push(eq(loginAttempts.ip, ip));
    if (matches.length === 0) return false;

    await ensureLoginAttemptsTable();
    const since = new Date(Date.now() - LOGIN_WINDOW_MS);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(and(gte(loginAttempts.createdAt, since), or(...matches)));
    return (row?.count ?? 0) >= LOGIN_MAX_FAILED_ATTEMPTS;
  } catch (e) {
    // Never lock everyone out because the limiter itself failed.
    console.error("[auth] could not check the login rate limit", e);
    return false;
  }
}

/** Records a failed sign-in and prunes attempts that are past retention. */
export async function recordFailedLogin(
  username: string,
  ip: string,
): Promise<void> {
  try {
    await ensureLoginAttemptsTable();
    await db.insert(loginAttempts).values({ username, ip });
    await db
      .delete(loginAttempts)
      .where(lt(loginAttempts.createdAt, new Date(Date.now() - RETENTION_MS)));
  } catch (e) {
    // The 401 is still the right answer for the caller.
    console.error("[auth] could not record a failed login attempt", e);
  }
}
