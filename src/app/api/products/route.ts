import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { products, warehouses } from "@/db/schema";
import {
  errResponse,
  HttpError,
  parseNonNegativeInt,
  parseUnit,
  readJson,
  requireUser,
  requireWriter,
} from "@/lib/api";
import { checkImageUrl } from "@/lib/images";
import { applyProductImage } from "@/lib/product-images";
import { fetchProductRows } from "@/lib/query";
import { registerProduct } from "@/lib/products";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireUser();
    const rows = await fetchProductRows();
    return Response.json({ products: rows });
  } catch (e) {
    return errResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireWriter();
    const body = await readJson(req);

    const sku = String(body.sku ?? "").trim();
    const name = String(body.name ?? "").trim().slice(0, 120);
    const imageCheck = checkImageUrl(body.imageUrl ?? "");
    if (!imageCheck.ok) throw new HttpError(400, imageCheck.error);
    const requestedImage = imageCheck.value;
    const isUpload = /^data:/i.test(requestedImage);
    const stockUnit = parseUnit(body.stockUnit ?? "piece");
    const cartonContains = Number(body.cartonContains);
    const openingQty = parseNonNegativeInt(body.openingQty ?? 0, "Opening stock");

    if (!sku || sku.length > 60) {
      throw new HttpError(400, "SKU is required (max 60 characters).");
    }
    if (!Number.isInteger(cartonContains) || cartonContains < 1) {
      throw new HttpError(400, "Carton Contains must be a whole number of at least 1.");
    }
    const existing = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.sku, sku))
      .limit(1);
    if (existing.length > 0) {
      throw new HttpError(409, `A product with SKU "${sku}" already exists.`);
    }

    // Opening stock warehouse is required — no default. Supports single
    // warehouse id or the sentinel "ALL" for all warehouses.
    const rawWarehouse = body.warehouseId ?? body.warehouse ?? body.openingStockWarehouse;
    let warehouseId: number | "ALL" | null = null;
    if (typeof rawWarehouse === "string" && rawWarehouse.trim().toLowerCase() === "all") {
      warehouseId = "ALL";
    } else if (typeof rawWarehouse === "string" && ["all warehouses", "all warehouse"].includes(rawWarehouse.trim().toLowerCase())) {
      warehouseId = "ALL";
    } else if (rawWarehouse === "ALL") {
      warehouseId = "ALL";
    } else if (rawWarehouse !== undefined && rawWarehouse !== null && String(rawWarehouse).trim() !== "") {
      const n = Number(rawWarehouse);
      if (Number.isInteger(n) && n > 0) warehouseId = n;
    }

    if (warehouseId === null) {
      throw new HttpError(400, "Select the warehouse where the opening stock is stored.");
    }

    if (warehouseId === "ALL") {
      const all = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
      if (all.length === 0) {
        throw new HttpError(400, "Create a warehouse before listing products.");
      }
    } else {
      const wh = await db
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(eq(warehouses.id, warehouseId))
        .limit(1);
      if (wh.length === 0) throw new HttpError(400, "Selected warehouse does not exist.");
    }

    const created = await registerProduct(
      {
        sku,
        name,
        // The photo is attached right after the product row exists (it needs
        // the id for the served image URL).
        imageUrl: isUpload ? "" : requestedImage,
        stockUnit,
        cartonContains,
        openingQty,
        warehouseId,
      },
      user.id,
    );

    let imageUrl = isUpload ? "" : requestedImage;
    let imageWarning: string | null = null;
    if (isUpload) {
      try {
        imageUrl = await applyProductImage(created.id, requestedImage);
      } catch (e) {
        // The listing itself was created; report a warning instead of failing
        // so the user does not retry and hit a duplicate SKU.
        console.error("[products] could not store uploaded image", e);
        imageWarning =
          "The product was listed, but its photo could not be saved. Open the product and upload the image again.";
      }
    }

    return Response.json({ productId: created.id, imageUrl, imageWarning }, { status: 201 });
  } catch (e) {
    return errResponse(e);
  }
}
