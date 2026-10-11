import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { warehouses } from "@/db/schema";
import {
  errResponse,
  HttpError,
  readJson,
  requireUser,
  requireWriter,
} from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    const rows = await db
      .select()
      .from(warehouses)
      .orderBy(asc(warehouses.id));
    return Response.json({ warehouses: rows });
  } catch (e) {
    return errResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireWriter();
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (name.length < 2 || name.length > 60) {
      throw new HttpError(400, "Warehouse name must be 2-60 characters.");
    }
    const existing = await db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(eq(warehouses.name, name))
      .limit(1);
    if (existing.length > 0) {
      throw new HttpError(409, `A warehouse named "${name}" already exists.`);
    }
    const [created] = await db
      .insert(warehouses)
      .values({ name, createdBy: user.id })
      .returning();
    return Response.json({ warehouse: created }, { status: 201 });
  } catch (e) {
    return errResponse(e);
  }
}
