import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { productImageUploadTokens, products } from "@/db/schema";
import type { DbTransaction } from "@/lib/db-transaction";
import { HttpError } from "@/lib/api";
import { checkImageUrl } from "@/lib/images";
import { ensureProductImagesTable, applyProductImageInTransaction } from "@/lib/product-images";

export const PRODUCT_IMAGE_UPLOAD_TTL_MS = 15 * 60 * 1000;

const INVALID_LINK_MESSAGE =
  "This upload link is invalid or no longer available. Ask your AI assistant for a new link.";
const OTHER_USER_MESSAGE =
  "This upload link was issued to a different StarStock account. Sign in with the account that requested it.";
const EXPIRED_MESSAGE = "This upload link has expired. Ask your AI assistant for a new one.";
const USED_MESSAGE = "This upload link has already been used. Ask your AI assistant for a new one.";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const globalForProductImageUploads = globalThis as typeof globalThis & {
  __starstockProductImageUploadTokensTable?: Promise<void>;
};

const CREATE_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS product_image_upload_tokens (
    token_hash text PRIMARY KEY,
    product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
  )
`;

/** Create the one-time upload table on first use; safe to run repeatedly. */
export function ensureProductImageUploadTokensTable(): Promise<void> {
  if (!globalForProductImageUploads.__starstockProductImageUploadTokensTable) {
    globalForProductImageUploads.__starstockProductImageUploadTokensTable = db
      .execute(CREATE_TABLE_SQL)
      .then(() => undefined)
      .catch((error) => {
        delete globalForProductImageUploads.__starstockProductImageUploadTokensTable;
        throw error;
      });
  }
  return globalForProductImageUploads.__starstockProductImageUploadTokensTable;
}

/** SHA-256 digest used as the persistent lookup key; the bearer token is never stored here. */
export function hashProductImageUploadToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Creates a random 256-bit token while persisting only its SHA-256 digest. */
export async function createProductImageUploadTokenInTransaction(
  tx: DbTransaction,
  productId: number,
  userId: number,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + PRODUCT_IMAGE_UPLOAD_TTL_MS);
  await tx.insert(productImageUploadTokens).values({
    tokenHash: hashProductImageUploadToken(token),
    productId,
    userId,
    expiresAt,
  });
  return { token, expiresAt };
}

function hashForLookup(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new HttpError(404, INVALID_LINK_MESSAGE);
  return hashProductImageUploadToken(token);
}

type UploadTokenState = {
  userId: number;
  expiresAt: Date;
  usedAt: Date | null;
};

function assertUsableToken(
  row: UploadTokenState | undefined,
  userId: number,
  now: Date,
): asserts row is UploadTokenState {
  if (!row) throw new HttpError(404, INVALID_LINK_MESSAGE);
  if (row.userId !== userId) throw new HttpError(403, OTHER_USER_MESSAGE);
  if (row.usedAt) throw new HttpError(410, USED_MESSAGE);
  if (row.expiresAt.getTime() <= now.getTime()) throw new HttpError(410, EXPIRED_MESSAGE);
}

export type ProductImageUploadProduct = { id: number; sku: string; name: string };

/** Validates a link for the upload page without consuming it. */
export async function getProductImageUploadDetails(
  token: string,
  userId: number,
  now = new Date(),
): Promise<ProductImageUploadProduct> {
  await ensureProductImageUploadTokensTable();
  const tokenHash = hashForLookup(token);
  const rows = await db
    .select({
      userId: productImageUploadTokens.userId,
      expiresAt: productImageUploadTokens.expiresAt,
      usedAt: productImageUploadTokens.usedAt,
      productId: products.id,
      sku: products.sku,
      name: products.name,
    })
    .from(productImageUploadTokens)
    .innerJoin(products, eq(productImageUploadTokens.productId, products.id))
    .where(eq(productImageUploadTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  assertUsableToken(row, userId, now);
  return { id: row.productId, sku: row.sku, name: row.name };
}

export type ProductImageUploadResult = {
  product: ProductImageUploadProduct;
  imageUrl: string;
  message: "Image saved";
};

/**
 * Saves the prepared image and consumes its link in one transaction. The row
 * lock ensures simultaneous submissions cannot use one token twice, and a
 * failed image write leaves the token available for a retry.
 */
export async function consumeProductImageUploadToken(
  token: string,
  userId: number,
  rawImageUrl: unknown,
  now = new Date(),
): Promise<ProductImageUploadResult> {
  const checked = checkImageUrl(rawImageUrl, { allowEmpty: false });
  if (!checked.ok) throw new HttpError(400, checked.error);
  if (!/^data:image\//i.test(checked.value)) {
    throw new HttpError(400, "Choose an image file from your device before saving.");
  }

  await ensureProductImageUploadTokensTable();
  await ensureProductImagesTable();
  const tokenHash = hashForLookup(token);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        userId: productImageUploadTokens.userId,
        productId: productImageUploadTokens.productId,
        expiresAt: productImageUploadTokens.expiresAt,
        usedAt: productImageUploadTokens.usedAt,
      })
      .from(productImageUploadTokens)
      .where(eq(productImageUploadTokens.tokenHash, tokenHash))
      .limit(1)
      .for("update");
    const row = rows[0];
    assertUsableToken(row, userId, now);

    const productRows = await tx
      .select({ id: products.id, sku: products.sku, name: products.name })
      .from(products)
      .where(eq(products.id, row.productId))
      .limit(1);
    const product = productRows[0];
    if (!product) throw new HttpError(404, INVALID_LINK_MESSAGE);

    const imageUrl = await applyProductImageInTransaction(tx, product.id, checked.value);
    const used = await tx
      .update(productImageUploadTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(productImageUploadTokens.tokenHash, tokenHash),
          isNull(productImageUploadTokens.usedAt),
        ),
      )
      .returning({ tokenHash: productImageUploadTokens.tokenHash });
    if (used.length !== 1) throw new HttpError(410, USED_MESSAGE);

    return { product, imageUrl, message: "Image saved" };
  });
}
