import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { errResponse, HttpError, readJson } from "@/lib/api";
import { createSession, verifyPassword } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    const body = await readJson(req);
    const username = String(body.username ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!username || !password) {
      throw new HttpError(400, "Enter both username and password.");
    }
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.passwordHash)) {
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
