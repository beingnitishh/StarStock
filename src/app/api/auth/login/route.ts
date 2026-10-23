import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { errResponse, HttpError, readJson } from "@/lib/api";
import { createSession, verifyPassword } from "@/lib/auth";
import {
  getClientIp,
  isLoginRateLimited,
  LOGIN_RATE_LIMIT_MESSAGE,
  recordFailedLogin,
} from "@/lib/login-attempts";

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const username = String(body.username ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!username || !password) {
      throw new HttpError(400, "Enter both username and password.");
    }

    // Throttle brute-force attempts: five failures in fifteen minutes for the
    // same username or the same IP lock the endpoint for that window.
    const ip = getClientIp(req);
    if (await isLoginRateLimited(username, ip)) {
      throw new HttpError(429, LOGIN_RATE_LIMIT_MESSAGE);
    }

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.passwordHash)) {
      await recordFailedLogin(username, ip);
      throw new HttpError(401, "Invalid username or password.");
    }
    if (!user.active) {
      throw new HttpError(
        403,
        "This account has been removed. Please contact your Admin.",
      );
    }
    await createSession(user.id);
    return Response.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    });
  } catch (e) {
    return errResponse(e);
  }
}
