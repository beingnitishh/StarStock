import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  errResponse,
  HttpError,
  readJson,
  requireAdmin,
} from "@/lib/api";
import { hashPassword, type Role } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ROLE_SET = new Set(["admin", "stock_head", "stock_boy"]);

export async function GET() {
  try {
    await requireAdmin();
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(asc(users.id));
    return Response.json({ users: rows });
  } catch (e) {
    return errResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
    const body = await readJson(req);
    const username = String(body.username ?? "").trim().toLowerCase();
    const displayName = String(body.displayName ?? "").trim();
    const password = String(body.password ?? "");
    const role = String(body.role ?? "").trim();

    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      throw new HttpError(
        400,
        "Username must be 3-30 characters: letters, numbers, dot, dash or underscore.",
      );
    }
    if (!displayName || displayName.length > 60) {
      throw new HttpError(400, "Display name is required (max 60 characters).");
    }
    if (password.length < 6 || password.length > 100) {
      throw new HttpError(400, "Password must be between 6 and 100 characters.");
    }
    if (!ROLE_SET.has(role)) {
      throw new HttpError(400, "Role must be admin, stock_head or stock_boy.");
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (existing.length > 0) {
      throw new HttpError(409, `Username "${username}" is already taken.`);
    }

    const [created] = await db
      .insert(users)
      .values({
        username,
        displayName,
        passwordHash: hashPassword(password),
        role: role as Role,
      })
      .returning({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
      });
    return Response.json({ user: created }, { status: 201 });
  } catch (e) {
    return errResponse(e);
  }
}
