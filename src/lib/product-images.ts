import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { productImages, products } from "@/db/schema";
import type { DbTransaction } from "./db-transaction";
import { HttpError } from "./api";
import { isStoredImageUrl, parseImageDataUrl, type ParsedImage } from "./images";

/**
 * Storage helpers for uploaded product photos.
 *
 * The table is created on demand (`CREATE TABLE IF NOT EXISTS`) so image
 * uploads work on a fresh deployment without a manual migration step; the
 * definition also lives in `src/db/schema.ts` for Drizzle.
 */

const globalForImages = globalThis as typeof globalThis & {
  __starstockProductImagesTable?: Promise<void>;
};

const CREATE_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS product_images (
    product_id integer PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    mime_type text NOT NULL DEFAULT 'image/jpeg',
    data text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

export function ensureProductImagesTable(): Promise<void> {
  if (!globalForImages.__starstockProductImagesTable) {
    globalForImages.__starstockProductImagesTable = (async () => {
      await db.execute(CREATE_TABLE_SQL);
    })().catch((e) => {
      // Allow a later request to retry (e.g. transient connection failure).
      delete globalForImages.__starstockProductImagesTable;
      throw e;
    });
  }
  return globalForImages.__starstockProductImagesTable;
}

export function storedImageUrl(productId: number, updatedAt: Date | string): string {
  const version = new Date(updatedAt).getTime();
  return `/api/products/${productId}/image?v=${Number.isFinite(version) ? version : Date.now()}`;
}

export function isOwnStoredImageUrl(productId: number, value: string): boolean {
  if (!isStoredImageUrl(value)) return false;
  const match = /^\/api\/products\/(\d+)\/image/.exec(value);
  return match ? Number(match[1]) === productId : false;
}

async function clearStoredImage(productId: number): Promise<void> {
  try {
    await ensureProductImagesTable();
    await db.delete(productImages).where(eq(productImages.productId, productId));
  } catch (e) {
    // A missing table simply means nothing was ever stored.
    if (isMissingTableError(e)) return;
    throw e;
  }
}

function isMissingTableError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "42P01") return true;
  return e instanceof Error && /relation .*product_images.* does not exist/i.test(e.message);
}

/** Stores the bytes and rewrites `products.image_url` to the served URL. */
export async function saveProductImage(
  productId: number,
  parsed: ParsedImage,
): Promise<string> {
  await ensureProductImagesTable();
  const [row] = await db
    .insert(productImages)
    .values({
      productId,
      mimeType: parsed.mimeType,
      data: parsed.base64,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: productImages.productId,
      set: { mimeType: parsed.mimeType, data: parsed.base64, updatedAt: new Date() },
    })
    .returning({ updatedAt: productImages.updatedAt });

  const url = storedImageUrl(productId, row?.updatedAt ?? new Date());
  await db.update(products).set({ imageUrl: url }).where(eq(products.id, productId));
  return url;
}

/** Stores a validated upload inside the caller's transaction. */
async function saveProductImageInTransaction(
  tx: DbTransaction,
  productId: number,
  parsed: ParsedImage,
): Promise<string> {
  const [row] = await tx
    .insert(productImages)
    .values({
      productId,
      mimeType: parsed.mimeType,
      data: parsed.base64,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: productImages.productId,
      set: { mimeType: parsed.mimeType, data: parsed.base64, updatedAt: new Date() },
    })
    .returning({ updatedAt: productImages.updatedAt });

  const url = storedImageUrl(productId, row?.updatedAt ?? new Date());
  await tx.update(products).set({ imageUrl: url }).where(eq(products.id, productId));
  return url;
}

/**
 * Transactional equivalent of `applyProductImage`, used by one-time upload
 * links so the stored bytes, product URL, and token consumption commit or roll
 * back together.
 */
export async function applyProductImageInTransaction(
  tx: DbTransaction,
  productId: number,
  rawValue: string,
): Promise<string> {
  await ensureProductImagesTable();
  const value = rawValue.trim();

  if (isOwnStoredImageUrl(productId, value)) return value;

  if (!value) {
    await tx.delete(productImages).where(eq(productImages.productId, productId));
    return "";
  }

  if (/^data:/i.test(value)) {
    const parsed = parseImageDataUrl(value);
    if (!parsed) {
      throw new HttpError(
        400,
        "That image could not be stored. It may be damaged, unsupported, or larger than 1.5 MB — re-upload it from the product screen.",
      );
    }
    return saveProductImageInTransaction(tx, productId, parsed);
  }

  await tx.delete(productImages).where(eq(productImages.productId, productId));
  return value;
}

/**
 * Applies any accepted image value to a product and returns what should be
 * stored in `products.image_url`:
 *  - a data URL is moved into `product_images` and replaced by a served URL
 *  - an http(s) link / site path replaces any stored blob
 *  - an empty string removes the photo
 */
export async function applyProductImage(productId: number, rawValue: string): Promise<string> {
  const value = rawValue.trim();

  // Re-saving the preview URL of an already stored image must not wipe it.
  if (isOwnStoredImageUrl(productId, value)) return value;

  if (!value) {
    await clearStoredImage(productId);
    return "";
  }

  if (/^data:/i.test(value)) {
    const parsed = parseImageDataUrl(value);
    if (!parsed) {
      throw new HttpError(
        400,
        "That image could not be stored. It may be damaged, unsupported, or larger than 1.5 MB — re-upload it from the product screen.",
      );
    }
    return saveProductImage(productId, parsed);
  }

  // External link or site path: remove the previous upload (if any).
  await clearStoredImage(productId);
  return value;
}

export async function readProductImage(
  productId: number,
): Promise<{ mimeType: string; base64: string } | null> {
  try {
    await ensureProductImagesTable();
    const rows = await db
      .select({ mimeType: productImages.mimeType, data: productImages.data })
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .limit(1);
    const row = rows[0];
    if (!row || !row.data) return null;
    return { mimeType: row.mimeType || "image/jpeg", base64: row.data };
  } catch (e) {
    if (isMissingTableError(e)) return null;
    throw e;
  }
}

/**
 * Older versions stored (sometimes truncated) data URLs directly in
 * `products.image_url`. Move any that are still readable into the image table
 * so existing listings heal automatically and the list payload stays small.
 */
export async function migrateLegacyProductImages<T extends { id: number; imageUrl: string }>(
  rows: T[],
): Promise<void> {
  const legacy = rows.filter((row) => /^data:image\//i.test(row.imageUrl ?? ""));
  if (legacy.length === 0) return;

  for (const row of legacy) {
    try {
      const parsed = parseImageDataUrl(row.imageUrl);
      if (!parsed) {
        // Corrupt/truncated value from the old 60k cut-off: clear it so the UI
        // shows an empty placeholder instead of a broken image.
        await db.update(products).set({ imageUrl: "" }).where(eq(products.id, row.id));
        row.imageUrl = "";
        continue;
      }
      row.imageUrl = await saveProductImage(row.id, parsed);
    } catch (e) {
      console.error(`[images] could not migrate legacy image for product ${row.id}`, e);
    }
  }
}
