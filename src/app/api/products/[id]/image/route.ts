import { errResponse, HttpError, requireUser } from "@/lib/api";
import { readProductImage } from "@/lib/product-images";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Serves an uploaded product photo from the database.
 *
 * The URL carries a `?v=<timestamp>` version, so browsers can cache it
 * forever while a new upload immediately produces a fresh URL.
 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    await requireUser();
    const { id: rawId } = await ctx.params;
    const productId = Number(rawId);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new HttpError(400, "Invalid product id.");
    }
    const image = await readProductImage(productId);
    if (!image) throw new HttpError(404, "No image has been uploaded for this product.");

    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.byteLength === 0) {
      throw new HttpError(404, "No image has been uploaded for this product.");
    }
    const isSvg = image.mimeType === "image/svg+xml";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": image.mimeType,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        // Uploaded SVGs are rendered as images only; never let them execute.
        ...(isSvg
          ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" }
          : {}),
      },
    });
  } catch (e) {
    return errResponse(e);
  }
}
