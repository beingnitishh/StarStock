import { eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import {
  errResponse,
  HttpError,
  parseUnit,
  readJson,
  requireUser,
  requireWriter,
} from "@/lib/api";
import { deleteProducts } from "@/lib/products";
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
 * Removes a product from the catalog only after confirming that it holds no
 * stock in any warehouse.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    await requireWriter();
    const { id: rawId } = await ctx.params;
    const id = Number(rawId);
    if (!Number.isInteger(id)) throw new HttpError(400, "Invalid product id.");

    const [deleted] = await deleteProducts([id]);
    if (!deleted) throw new HttpError(404, "Product not found.");
    return Response.json({ ok: true, sku: deleted.sku });
  } catch (e) {
    return errResponse(e);
  }
}
