import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { products, transactions, users, warehouseStock } from "@/db/schema";
import { errResponse, HttpError, readJson, requireAdmin } from "@/lib/api";
import { verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Force delete a selected group of products, even when they still hold stock.
 *
 * Only an Admin may call this endpoint, and the Admin's own password must be
 * verified before anything is removed. Stock rows and movement history are
 * deleted together with the products, so nothing is left behind.
 */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    const body = await readJson(req);
    const rawIds = body.ids;
    const password = String(body.password ?? "");

    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new HttpError(400, "Select at least one product to delete.");
    }
    if (rawIds.length > 5000) {
      throw new HttpError(400, "Delete at most 5,000 products at a time.");
    }

    const ids = rawIds.map((value) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new HttpError(400, "Selected product IDs must be positive whole numbers.");
      }
      return value;
    });

    if (!password.trim()) {
      throw new HttpError(400, "Enter your admin password to verify.");
    }

    const deleted = await db.transaction(async (tx) => {
      // 1. Verify the signed-in Admin's password before anything is removed.
      const [account] = await tx
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, admin.id))
        .limit(1);
      if (!account || !verifyPassword(password.trim(), account.passwordHash)) {
        throw new HttpError(403, "Incorrect admin password. Force delete cancelled.");
      }

      // 2. Lock and confirm every selected product still exists.
      const selectedProducts = await tx
        .select({ id: products.id, sku: products.sku })
        .from(products)
        .where(inArray(products.id, ids))
        .orderBy(asc(products.id))
        .for("update");

      if (selectedProducts.length !== ids.length) {
        throw new HttpError(
          404,
          "One or more selected products could not be found. Refresh inventory and try again.",
        );
      }

      // 3. Remove dependent rows first, then the products themselves.
      await tx.delete(warehouseStock).where(inArray(warehouseStock.productId, ids));
      await tx.delete(transactions).where(inArray(transactions.productId, ids));
      return tx
        .delete(products)
        .where(inArray(products.id, ids))
        .returning({ id: products.id, sku: products.sku });
    });

    return Response.json({ ok: true, deleted });
  } catch (e) {
    return errResponse(e);
  }
}
