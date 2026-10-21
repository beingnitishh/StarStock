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
import { checkImageUrl } from "@/lib/images";
import { applyProductImage, isOwnStoredImageUrl } from "@/lib/product-images";
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
    let imageChanged = false;

    if (body.name !== undefined) {
      updates.name = String(body.name).trim().slice(0, 120);
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

    if (body.imageUrl !== undefined) {
      const checked = checkImageUrl(body.imageUrl);
      if (!checked.ok) throw new HttpError(400, checked.error);

      const currentRows = await db
        .select({ imageUrl: products.imageUrl })
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      if (!currentRows[0]) throw new HttpError(404, "Product not found.");

      const unchanged =
        checked.value === currentRows[0].imageUrl ||
        (isOwnStoredImageUrl(id, checked.value) && isOwnStoredImageUrl(id, currentRows[0].imageUrl));

      if (!unchanged) {
        // Uploaded photos move into the image table; links replace old uploads.
        updates.imageUrl = await applyProductImage(id, checked.value);
        imageChanged = true;
      }
    }
    if (Object.keys(updates).length === 0) {
      // Nothing actually changed (e.g. the form re-sent the existing photo).
      return Response.json({ ok: true, unchanged: true });
    }

    const [updated] = await db
      .update(products)
      .set(updates)
      .where(eq(products.id, id))
      .returning({ id: products.id, imageUrl: products.imageUrl });
    if (!updated) throw new HttpError(404, "Product not found.");
    return Response.json({ ok: true, imageChanged, imageUrl: updated.imageUrl });
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
