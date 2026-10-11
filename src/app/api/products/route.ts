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
    const imageUrl = String(body.imageUrl ?? "").trim().slice(0, 60_000);
    const stockUnit = parseUnit(body.stockUnit ?? "piece");
    const cartonContains = Number(body.cartonContains);
    const openingQty = parseNonNegativeInt(body.openingQty ?? 0, "Opening stock");

    if (!sku || sku.length > 60) {
      throw new HttpError(400, "SKU is required (max 60 characters).");
    }
    if (!Number.isInteger(cartonContains) || cartonContains < 1) {
      throw new HttpError(400, "Carton Contains must be a whole number of at least 1.");
    }
    if (imageUrl && !/^(https?:\/\/|data:image\/)/i.test(imageUrl)) {
      throw new HttpError(400, "Product image must be an http(s) URL or an uploaded image.");
    }

    const existing = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.sku, sku))
      .limit(1);
    if (existing.length > 0) {
      throw new HttpError(409, `A product with SKU "${sku}" already exists.`);
    }

    let warehouseId = body.warehouseId ? Number(body.warehouseId) : 0;
    if (openingQty > 0) {
      if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
        throw new HttpError(400, "Select the warehouse where the opening stock is stored.");
      }
      const wh = await db
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(eq(warehouses.id, warehouseId))
        .limit(1);
      if (wh.length === 0) throw new HttpError(400, "Selected warehouse does not exist.");
    } else {
      const [first] = await db
        .select({ id: warehouses.id })
        .from(warehouses)
        .orderBy(asc(warehouses.id))
        .limit(1);
      warehouseId = first?.id ?? 0;
    }
    if (!warehouseId) {
      throw new HttpError(400, "Create a warehouse before listing products.");
    }

    const created = await registerProduct(
      { sku, name, imageUrl, stockUnit, cartonContains, openingQty, warehouseId },
      user.id,
    );
    return Response.json({ productId: created.id }, { status: 201 });
  } catch (e) {
    return errResponse(e);
  }
}
