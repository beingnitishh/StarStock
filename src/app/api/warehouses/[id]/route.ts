import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { transactions, warehouseStock, warehouses } from "@/db/schema";
import { errResponse, HttpError, readJson, requireUser } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    await requireUser();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid warehouse id.");
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (name.length < 2 || name.length > 60) {
      throw new HttpError(400, "Warehouse name must be 2-60 characters.");
    }
    const clash = await db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(eq(warehouses.name, name))
      .limit(2);
    if (clash.some((w) => w.id !== id)) {
      throw new HttpError(409, `A warehouse named "${name}" already exists.`);
    }
    const [updated] = await db
      .update(warehouses)
      .set({ name })
      .where(eq(warehouses.id, id))
      .returning();
    if (!updated) throw new HttpError(404, "Warehouse not found.");
    return Response.json({ warehouse: updated });
  } catch (e) {
    return errResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireUser();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid warehouse id.");

    const [stockRow] = await db
      .select({ id: warehouseStock.productId })
      .from(warehouseStock)
      .where(
        and(eq(warehouseStock.warehouseId, id), gt(warehouseStock.qtyPieces, 0)),
      )
      .limit(1);
    if (stockRow) {
      throw new HttpError(
        400,
        "This warehouse still holds stock. Move or adjust the stock to zero before deleting it.",
      );
    }
    const txRefs = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.warehouseId, id))
      .limit(1);
    const txRefs2 = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.toWarehouseId, id))
      .limit(1);
    if (txRefs.length > 0 || txRefs2.length > 0) {
      throw new HttpError(
        400,
        "This warehouse appears in transaction history and cannot be deleted to preserve traceability.",
      );
    }
    const [deleted] = await db
      .delete(warehouses)
      .where(eq(warehouses.id, id))
      .returning();
    if (!deleted) throw new HttpError(404, "Warehouse not found.");
    return Response.json({ ok: true });
  } catch (e) {
    return errResponse(e);
  }
}
