import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { products, warehouseStock } from "@/db/schema";
import {
  errResponse,
  HttpError,
  parseUnit,
  readJson,
  requireUser,
  requireWriter,
} from "@/lib/api";
import { fetchProductRow, fetchTransactionRows } from "@/lib/query";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUser();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid product id.");
    const product = await fetchProductRow(id);
    if (!product) throw new HttpError(404, "Product not found.");
    const history = await fetchTransactionRows({ productId: id, sinceDays: 30, limit: 500 });
    return Response.json({ product, history });
  } catch (e) {
    return errResponse(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    await requireWriter();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid product id.");
    const body = await readJson(req);

    const updates: {
      name?: string;
      imageUrl?: string;
      cartonContains?: number;
      stockUnit?: "piece" | "carton";
    } = {};

    if (body.name !== undefined) {
      updates.name = String(body.name).trim().slice(0, 120);
    }
    if (body.imageUrl !== undefined) {
      const url = String(body.imageUrl).trim().slice(0, 60_000);
      if (url && !/^(https?:\/\/|data:image\/)/i.test(url)) {
        throw new HttpError(400, "Product image must be an http(s) URL or an uploaded image.");
      }
      updates.imageUrl = url;
    }
    if (body.cartonContains !== undefined) {
      const c = Number(body.cartonContains);
      if (!Number.isInteger(c) || c < 1) {
        throw new HttpError(400, "Carton Contains must be a whole number of at least 1.");
      }
      updates.cartonContains = c;
    }
    if (body.stockUnit !== undefined) {
      updates.stockUnit = parseUnit(body.stockUnit);
    }
    if (Object.keys(updates).length === 0) {
      throw new HttpError(400, "No fields to update.");
    }

    const [updated] = await db
      .update(products)
      .set(updates)
      .where(eq(products.id, id))
      .returning({ id: products.id });
    if (!updated) throw new HttpError(404, "Product not found.");
    return Response.json({ ok: true });
  } catch (e) {
    return errResponse(e);
  }
}

/**
 * Removes a product from the catalog. Deleting a product that still holds
 * stock would silently wipe real inventory, so it is blocked until the stock
 * is brought to zero with an outbound or adjustment entry.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireWriter();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid product id.");

    const [product] = await db
      .select({ id: products.id, sku: products.sku })
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    if (!product) throw new HttpError(404, "Product not found.");

    const stockRows = await db
      .select({
        warehouseId: warehouseStock.warehouseId,
        qtyPieces: warehouseStock.qtyPieces,
      })
      .from(warehouseStock)
      .where(
        and(
          eq(warehouseStock.productId, id),
          gt(warehouseStock.qtyPieces, 0),
        ),
      );
    if (stockRows.length > 0) {
      const totalPieces = stockRows.reduce((acc, r) => acc + r.qtyPieces, 0);
      throw new HttpError(
        400,
        `"${product.sku}" still holds ${totalPieces} pcs across ${stockRows.length} warehouse${
          stockRows.length === 1 ? "" : "s"
        }. Record an outbound or adjustment to bring the stock to zero before deleting it.`,
      );
    }

    const [deleted] = await db
      .delete(products)
      .where(eq(products.id, id))
      .returning({ id: products.id, sku: products.sku });
    if (!deleted) throw new HttpError(404, "Product not found.");
    return Response.json({ ok: true, sku: deleted.sku });
  } catch (e) {
    return errResponse(e);
  }
}
