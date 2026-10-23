import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  errResponse,
  HttpError,
  readJson,
  requireAdmin,
} from "@/lib/api";
import { hashPassword, revokeUserSessions } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/roles";

export const dynamic = "force-dynamic";

const ROLE_SET = new Set<string>(ROLES);

type Ctx = { params: Promise<{ id: string }> };

/**
 * Updates an account. Accepts any combination of:
 *   { "active": boolean }   remove / restore the account
 *   { "password": string }  set a new password (6-100 chars) and sign the
 *                           user out everywhere
 *   { "role": Role }        change the role (an Admin cannot change their own)
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const admin = await requireAdmin();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) {
      throw new HttpError(400, "Invalid user id.");
    }
    const body = await readJson(req);

    const updates: {
      active?: boolean;
      deactivatedAt?: Date | null;
      passwordHash?: string;
      role?: Role;
    } = {};
    let revokeSessions = false;

    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") {
        throw new HttpError(400, '"active" must be true or false.');
      }
      const active = body.active;
      if (!active && id === admin.id) {
        throw new HttpError(
          400,
          "You can't remove your own account. Ask another Admin to do it.",
        );
      }
      updates.active = active;
      updates.deactivatedAt = active ? null : new Date();
    }

    if (body.password !== undefined) {
      const password = String(body.password ?? "");
      if (password.length < 6 || password.length > 100) {
        throw new HttpError(400, "Password must be between 6 and 100 characters.");
      }
      updates.passwordHash = hashPassword(password);
      revokeSessions = true;
    }

    if (body.role !== undefined) {
      const role = String(body.role ?? "").trim();
      if (!ROLE_SET.has(role)) {
        throw new HttpError(400, `Role must be one of: ${ROLES.join(", ")}.`);
      }
      if (id === admin.id) {
        throw new HttpError(
          400,
          "You can't change your own role. Ask another Admin to do it.",
        );
      }
      updates.role = role as Role;
    }

    if (Object.keys(updates).length === 0) {
      throw new HttpError(
        400,
        'Send { "active": true|false }, { "password": "..." } and/or { "role": "..." }.',
      );
    }

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        active: users.active,
        createdAt: users.createdAt,
        deactivatedAt: users.deactivatedAt,
      });
    if (!updated) throw new HttpError(404, "User not found.");

    if (!updated.active || revokeSessions) {
      await revokeUserSessions(id);
    }
    return Response.json({ user: updated });
  } catch (e) {
    return errResponse(e);
  }
}
