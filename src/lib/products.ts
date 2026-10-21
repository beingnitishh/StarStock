import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { products, transactions, warehouseStock, warehouses } from "@/db/schema";
import { HttpError } from "./api";
import { toPieces, type StockUnit } from "./units";

export const ALL_WAREHOUSES = "ALL" as const;
export type WarehouseId = number | typeof ALL_WAREHOUSES;

export type RegisterInput = {
  sku: string;
  name: string;
  imageUrl: string;
  stockUnit: StockUnit;
  cartonContains: number;
  openingQty: number;
  warehouseId: WarehouseId;
};

export function isAllWarehouses(value: unknown): boolean {
  if (value === ALL_WAREHOUSES) return true;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return (
    v === "all" ||
    v === "all warehouses" ||
    v === "all warehouse" ||
    v === "all_warehouses" ||
    v === "all-warehouses" ||
    v === "all_warehouse" ||
    v === "all-warehouse"
  );
}

export function normalizeWarehouseId(value: unknown): WarehouseId | null {
  if (value === null || value === undefined || value === "") return null;
  if (isAllWarehouses(value)) return ALL_WAREHOUSES;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  // Allow string numeric like "3"
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed > 0) return parsed;
  }
  return null;
}

/**
 * Creates a product, applies its opening stock to a warehouse and records the
 * opening stock as the first inbound transaction.
 * When warehouseId is "ALL", the opening stock is replicated to every
 * warehouse that exists at creation time. The product will then appear in the
 * inventory panel under each warehouse, and the aggregate total is the sum
 * across all warehouses.
 */
export async function registerProduct(input: RegisterInput, userId: number) {
  return db.transaction(async (tx) => {
    const openingPieces = toPieces(
      input.openingQty,
      input.stockUnit,
      input.cartonContains,
    );

    // Resolve ALL warehouses case
    const isAll = input.warehouseId === ALL_WAREHOUSES;

    let allWarehouseIds: number[] | null = null;
    if (isAll) {
      const whRows = await tx
        .select({ id: warehouses.id })
        .from(warehouses);
      if (whRows.length === 0) {
        throw new HttpError(400, "Create a warehouse before listing products.");
      }
      allWarehouseIds = whRows.map((w) => w.id);
    }

    const totalOpeningPieces = isAll
      ? openingPieces * (allWarehouseIds?.length ?? 0)
      : openingPieces;

    const [p] = await tx
      .insert(products)
      .values({
        sku: input.sku,
        name: input.name,
        imageUrl: input.imageUrl,
        stockUnit: input.stockUnit,
        cartonContains: input.cartonContains,
        openingStockPieces: totalOpeningPieces,
        createdBy: userId,
      })
      .returning();

    if (isAll && allWarehouseIds) {
      if (openingPieces > 0) {
        // Replicate opening stock to every warehouse, creating one inbound
        // transaction per warehouse so history is traceable per warehouse.
        for (let i = 0; i < allWarehouseIds.length; i++) {
          const whId = allWarehouseIds[i];
          await tx.insert(warehouseStock).values({
            productId: p.id,
            warehouseId: whId,
            qtyPieces: openingPieces,
            updatedAt: new Date(),
          });
          // Incremental total so transactions reflect the growing aggregate.
          const resultingTotalPieces = openingPieces * (i + 1);
          await tx.insert(transactions).values({
            type: "inbound",
            productId: p.id,
            userId,
            enteredQty: input.openingQty,
            enteredUnit: input.stockUnit,
            qtyPieces: openingPieces,
            warehouseId: whId,
            reason: "Opening stock",
            resultingTotalPieces,
          });
        }
      } else {
        // Opening qty is 0 but user explicitly chose All Warehouses: create
        // zero-quantity rows so the product is visibly listed in every
        // warehouse on the inventory panel (stock by warehouse).
        for (const whId of allWarehouseIds) {
          await tx.insert(warehouseStock).values({
            productId: p.id,
            warehouseId: whId,
            qtyPieces: 0,
            updatedAt: new Date(),
          });
        }
      }
    } else {
      // Single warehouse
      if (openingPieces > 0) {
        const singleId = input.warehouseId as number;
        await tx.insert(warehouseStock).values({
          productId: p.id,
          warehouseId: singleId,
          qtyPieces: openingPieces,
          updatedAt: new Date(),
        });
        await tx.insert(transactions).values({
          type: "inbound",
          productId: p.id,
          userId,
          enteredQty: input.openingQty,
          enteredUnit: input.stockUnit,
          qtyPieces: openingPieces,
          warehouseId: singleId,
          reason: "Opening stock",
          resultingTotalPieces: openingPieces,
        });
      }
    }
    return p;
  });
}

/**
 * Deletes a set of products as one atomic action, but only when every selected
 * SKU has zero stock. Product and stock rows are locked while checking so a
 * stock movement cannot race the validation and silently remove live stock.
 */
export async function deleteProducts(ids: number[]) {
  const uniqueIds = [...new Set(ids)].sort((a, b) => a - b);
  if (uniqueIds.length === 0) {
    throw new HttpError(400, "Select at least one product to delete.");
  }

  return db.transaction(async (tx) => {
    const selectedProducts = await tx
      .select({ id: products.id, sku: products.sku })
      .from(products)
      .where(inArray(products.id, uniqueIds))
      .orderBy(asc(products.id))
      .for("update");

    if (selectedProducts.length !== uniqueIds.length) {
      throw new HttpError(
        404,
        "One or more selected products could not be found. Refresh inventory and try again.",
      );
    }

    const stockRows = await tx
      .select({ productId: warehouseStock.productId, qtyPieces: warehouseStock.qtyPieces })
      .from(warehouseStock)
      .where(inArray(warehouseStock.productId, uniqueIds))
      .orderBy(asc(warehouseStock.productId), asc(warehouseStock.warehouseId))
      .for("update");

    const positiveStock = new Map<number, { pieces: number; warehouses: number }>();
    for (const row of stockRows) {
      if (row.qtyPieces <= 0) continue;
      const current = positiveStock.get(row.productId) ?? { pieces: 0, warehouses: 0 };
      positiveStock.set(row.productId, {
        pieces: current.pieces + row.qtyPieces,
        warehouses: current.warehouses + 1,
      });
    }

    const blocked = selectedProducts.flatMap((product) => {
      const stock = positiveStock.get(product.id);
      return stock ? [{ ...product, ...stock }] : [];
    });

    if (blocked.length > 0) {
      if (uniqueIds.length === 1) {
        const product = blocked[0];
        throw new HttpError(
          400,
          `"${product.sku}" still holds ${product.pieces} pcs across ${product.warehouses} warehouse${
            product.warehouses === 1 ? "" : "s"
          }. Record an outbound or adjustment to bring the stock to zero before deleting it.`,
        );
      }

      const details = blocked
        .slice(0, 8)
        .map((product) => `${product.sku} (${product.pieces} pcs)`)
        .join(", ");
      const remaining = blocked.length - Math.min(blocked.length, 8);
      throw new HttpError(
        400,
        `Cannot delete selected products because stock remains for: ${details}${
          remaining > 0 ? `, and ${remaining} more` : ""
        }. Bring stock to zero or deselect those SKUs.`,
      );
    }

    return tx
      .delete(products)
      .where(inArray(products.id, uniqueIds))
      .returning({ id: products.id, sku: products.sku });
  });
}
