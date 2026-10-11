import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { products, transactions, warehouseStock, warehouses } from "@/db/schema";
import {
  errResponse,
  HttpError,
  readJson,
  requireUser,
  requireWriter,
} from "@/lib/api";
import { skuCompare } from "@/lib/units";

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

async function getWarehouseOr404(id: number) {
  const [w] = await db.select().from(warehouses).where(eq(warehouses.id, id)).limit(1);
  if (!w) throw new HttpError(404, "Warehouse not found.");
  return w;
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUser();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid warehouse id.");

    const warehouse = await getWarehouseOr404(id);

    // All products, with stock rows for this warehouse joined so we can also
    // surface products that have never had stock here as qty 0.
    const prods = await db.select().from(products).orderBy(asc(products.id));
    const stockRows = await db
      .select({
        productId: warehouseStock.productId,
        qtyPieces: warehouseStock.qtyPieces,
        updatedAt: warehouseStock.updatedAt,
      })
      .from(warehouseStock)
      .where(eq(warehouseStock.warehouseId, id));

    const stockMap = new Map<number, { qtyPieces: number; updatedAt: Date | null }>();
    for (const s of stockRows) {
      stockMap.set(s.productId, { qtyPieces: s.qtyPieces, updatedAt: s.updatedAt });
    }

    const items = prods
      .map((p) => {
        const s = stockMap.get(p.id) ?? { qtyPieces: 0, updatedAt: null };
        return {
          product: {
            ...p,
            // Pad stock shape so ProductThumb etc. can work off the existing type.
            totalPieces: s.qtyPieces,
            stocks: [
              {
                warehouseId: id,
                warehouseName: warehouse.name,
                qtyPieces: s.qtyPieces,
              },
            ],
            createdAt: p.createdAt.toISOString(),
          },
          qtyPieces: s.qtyPieces,
          updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
        };
      })
      // Show products that actually hold stock first, then empty ones, sorted by SKU.
      .sort((a, b) => {
        if ((a.qtyPieces > 0) !== (b.qtyPieces > 0)) return a.qtyPieces > 0 ? -1 : 1;
        return skuCompare(a.product.sku, b.product.sku);
      });

    const skuCount = items.filter((i) => i.qtyPieces > 0).length;
    const totalPieces = items.reduce((acc, i) => acc + i.qtyPieces, 0);

    return Response.json({
      warehouse,
      items,
      skuCount,
      totalPieces,
    });
  } catch (e) {
    return errResponse(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    await requireWriter();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid warehouse id.");
    await getWarehouseOr404(id);

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
    return Response.json({ warehouse: updated });
  } catch (e) {
    return errResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireWriter();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid warehouse id.");
    await getWarehouseOr404(id);

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
