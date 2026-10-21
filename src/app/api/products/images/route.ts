import { sql } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { errResponse, HttpError, readJson, requireWriter } from "@/lib/api";
import { checkImageUrl, MAX_IMAGE_DATA_URL_CHARS } from "@/lib/images";
import { applyProductImage } from "@/lib/product-images";

export const dynamic = "force-dynamic";

const MAX_ITEMS_PER_REQUEST = 50;
const MAX_TOTAL_CHARS = 4_000_000;

type IncomingImage = { sku?: unknown; fileName?: unknown; imageUrl?: unknown };

/**
 * Attaches already-compressed images to existing products, matched by SKU.
 *
 * The bulk upload screen sends images here in small batches after the sheet
 * has been imported. This is also how photos can be added later to listings
 * that were created without an image link.
 */
export async function POST(req: Request) {
  try {
    await requireWriter();
    const body = await readJson(req);
    const rawItems = body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new HttpError(400, "Add at least one image to upload.");
    }
    if (rawItems.length > MAX_ITEMS_PER_REQUEST) {
      throw new HttpError(
        400,
        `Send at most ${MAX_ITEMS_PER_REQUEST} images per request — the upload is batched automatically.`,
      );
    }

    const items = rawItems as IncomingImage[];
    let totalChars = 0;
    for (const item of items) {
      const imageUrl = typeof item?.imageUrl === "string" ? item.imageUrl : "";
      totalChars += imageUrl.length;
    }
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new HttpError(413, "This batch of images is too large. Try uploading fewer images at a time.");
    }

    type Failure = { sku: string; fileName: string; message: string };
    const errors: Failure[] = [];
    let updated = 0;
    const seen = new Set<string>();

    for (const item of items) {
      const sku = String(item?.sku ?? "").trim();
      const fileName = String(item?.fileName ?? "").trim();
      const imageUrl = typeof item?.imageUrl === "string" ? item.imageUrl : "";

      if (!sku) {
        errors.push({ sku: "", fileName, message: "No SKU was found for this image." });
        continue;
      }
      if (imageUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
        errors.push({ sku, fileName, message: "Image is too large after processing (max 1.5 MB)." });
        continue;
      }
      const checked = checkImageUrl(imageUrl, { allowEmpty: false });
      if (!checked.ok) {
        errors.push({ sku, fileName, message: checked.error });
        continue;
      }
      if (seen.has(sku.toLowerCase())) continue;
      seen.add(sku.toLowerCase());

      const match = await db
        .select({ id: products.id, sku: products.sku })
        .from(products)
        .where(sql`lower(${products.sku}) = ${sku.toLowerCase()}`)
        .limit(1);
      const product = match[0];
      if (!product) {
        errors.push({
          sku,
          fileName,
          message: `No product with SKU "${sku}". The image file must be named after the SKU, e.g. ${sku || "BTL-750"}.jpg`,
        });
        continue;
      }

      try {
        await applyProductImage(product.id, checked.value);
        updated += 1;
      } catch (e) {
        errors.push({
          sku: product.sku,
          fileName,
          message: e instanceof HttpError ? e.message : "Could not save this image. Please retry.",
        });
      }
    }

    return Response.json({
      updated,
      failed: errors.length,
      errors: errors.slice(0, 100),
      total: items.length,
    });
  } catch (e) {
    return errResponse(e);
  }
}
