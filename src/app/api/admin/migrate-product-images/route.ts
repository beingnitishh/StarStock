import { like } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { errResponse, requireAdmin } from "@/lib/api";
import { migrateLegacyProductImages } from "@/lib/product-images";

export const dynamic = "force-dynamic";

/**
 * One-time admin maintenance endpoint.
 *
 * Older versions stored (sometimes truncated) data URLs directly in
 * `products.image_url`. This moves any that are still readable into the
 * `product_images` table and rewrites `image_url` to the lightweight served
 * URL. It used to run on every product listing request; it now runs only
 * here, on demand.
 *
 *   curl -X POST https://<host>/api/admin/migrate-product-images \
 *        -H 'cookie: ss_session=<admin session token>'
 *
 * It is safe to call more than once: once nothing is left to migrate the
 * response reports `found: 0` and no rows are touched.
 */
export async function POST() {
  try {
    await requireAdmin();

    // Only legacy inline images are read — never the whole catalogue.
    const rows = await db
      .select({ id: products.id, imageUrl: products.imageUrl })
      .from(products)
      .where(like(products.imageUrl, "data:image/%"));

    const original = new Map(rows.map((row) => [row.id, row.imageUrl]));
    await migrateLegacyProductImages(rows);

    const stored = rows.filter(
      (row) => row.imageUrl !== original.get(row.id) && row.imageUrl !== "",
    ).length;
    const cleared = rows.filter(
      (row) => row.imageUrl === "" && original.get(row.id) !== "",
    ).length;

    return Response.json({
      found: rows.length,
      stored,
      cleared,
      remaining: rows.length - stored - cleared,
    });
  } catch (e) {
    return errResponse(e);
  }
}
