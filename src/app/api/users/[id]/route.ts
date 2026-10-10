import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  errResponse,
  HttpError,
  readJson,
  requireAdmin,
} from "@/lib/api";
import { revokeUserSessions } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const admin = await requireAdmin();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 1) {
      throw new HttpError(400, "Invalid user id.");
    }
    const body = await readJson(req);
    if (typeof body.active !== "boolean") {
      throw new HttpError(
        400,
        'Send { "active": true } or { "active": false }.',
      );
    }
    const active = body.active;
    if (!active && id === admin.id) {
      throw new HttpError(
        400,
        "You can't remove your own account. Ask another Admin to do it.",
      );
    }

    const [updated] = await db
      .update(users)
      .set({ active, deactivatedAt: active ? null : new Date() })
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

    if (!active) {
      await revokeUserSessions(id);
    }
    return Response.json({ user: updated });
  } catch (e) {
    return errResponse(e);
  }
}
