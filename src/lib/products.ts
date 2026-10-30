import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  products,
  transactions,
  warehouseStock,
  warehouses,
  type Product,
  type Transaction,
} from "@/db/schema";
import { HttpError } from "./api";
import type { DbTransaction } from "./db-transaction";
import { ensureMcpInventorySchema } from "./mcp-schema";
import type { ApplicationSource } from "./source-app";
import { performOperationDetailedInTransaction } from "./stock";
import { MAX_STOCK_PIECES, toPieces, type StockUnit } from "./units";

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

export type OpeningTransactionAudit = {
  transaction: Transaction;
  warehouseName: string;
};

export type RegisterProductDetailedResult = {
  product: Product;
  stockWarehouses: Array<{ id: number; name: string }>;
  openingTransactions: OpeningTransactionAudit[];
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

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

/**
 * Detailed product registration used by MCP. The compatibility wrapper below
 * retains the original web/seed return contract while sharing this one atomic
 * implementation.
 */
export async function registerProductDetailedInTransaction(
  tx: DbTransaction,
  input: RegisterInput,
  userId: number,
  sourceApp: ApplicationSource = "web",
  clientRequestId: string | null = null,
): Promise<RegisterProductDetailedResult> {
  const sku = input.sku.trim();
  if (!sku || sku.length > 60) {
    throw new HttpError(400, "SKU is required (max 60 characters).");
  }
  if (input.name.length > 120) {
    throw new HttpError(400, "Product name must be 120 characters or fewer.");
  }
  if (
    !Number.isInteger(input.cartonContains) ||
    input.cartonContains < 1 ||
    input.cartonContains > MAX_STOCK_PIECES
  ) {
    throw new HttpError(400, "Carton Contains must be a whole number of at least 1.");
  }
  if (!Number.isInteger(input.openingQty) || input.openingQty < 0) {
    throw new HttpError(400, "Opening stock must be a whole number (0 or more).");
  }

  const openingPieces = toPieces(
    input.openingQty,
    input.stockUnit,
    input.cartonContains,
  );
  if (!Number.isSafeInteger(openingPieces) || openingPieces > MAX_STOCK_PIECES) {
    throw new HttpError(400, "Opening stock is too large for StarStock's quantity limits.");
  }

  try {
    const existing = await tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.sku, sku))
      .limit(1);
    if (existing.length > 0) {
      throw new HttpError(409, `A product with SKU "${sku}" already exists.`);
    }

    // Resolve ALL warehouses case. A fixed order also makes the opening
    // transaction sequence deterministic.
    const isAll = input.warehouseId === ALL_WAREHOUSES;
    let selectedWarehouses: Array<{ id: number; name: string }> = [];
    if (isAll) {
      selectedWarehouses = await tx
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .orderBy(asc(warehouses.id));
      if (selectedWarehouses.length === 0) {
        throw new HttpError(400, "Create a warehouse before listing products.");
      }
    } else {
      if (!Number.isInteger(input.warehouseId) || (input.warehouseId as number) <= 0) {
        throw new HttpError(400, "Select the warehouse where the opening stock is stored.");
      }
      const selected = await tx
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .where(eq(warehouses.id, input.warehouseId as number))
        .limit(1);
      if (!selected[0]) {
        throw new HttpError(400, "Selected warehouse does not exist.");
      }
      selectedWarehouses = selected;
    }

    const totalOpeningPieces = isAll
      ? openingPieces * selectedWarehouses.length
      : openingPieces;
    if (!Number.isSafeInteger(totalOpeningPieces) || totalOpeningPieces > MAX_STOCK_PIECES) {
      throw new HttpError(400, "Opening stock is too large for StarStock's quantity limits.");
    }

    const [product] = await tx
      .insert(products)
      .values({
        sku,
        name: input.name,
        imageUrl: input.imageUrl,
        stockUnit: input.stockUnit,
        cartonContains: input.cartonContains,
        openingStockPieces: totalOpeningPieces,
        createdBy: userId,
      })
      .returning();
    if (!product) throw new Error("Product insert returned no row.");

    const openingTransactions: OpeningTransactionAudit[] = [];

    if (openingPieces > 0) {
      // One stock row and one inbound transaction per selected warehouse.
      // For ALL, resulting totals increase in the same deterministic order.
      for (let index = 0; index < selectedWarehouses.length; index++) {
        const warehouse = selectedWarehouses[index];
        await tx.insert(warehouseStock).values({
          productId: product.id,
          warehouseId: warehouse.id,
          qtyPieces: openingPieces,
          updatedAt: new Date(),
        });
        const previousTotalPieces = openingPieces * index;
        const resultingTotalPieces = openingPieces * (index + 1);
        const [transaction] = await tx
          .insert(transactions)
          .values({
            type: "inbound",
            productId: product.id,
            userId,
            enteredQty: input.openingQty,
            enteredUnit: input.stockUnit,
            qtyPieces: openingPieces,
            warehouseId: warehouse.id,
            reason: "Opening stock",
            sourceApp,
            previousTotalPieces,
            clientRequestId,
            resultingTotalPieces,
          })
          .returning();
        if (!transaction) throw new Error("Opening-stock transaction insert returned no row.");
        openingTransactions.push({ transaction, warehouseName: warehouse.name });
      }
    } else {
      // Preserve the existing listing behaviour: zero-opening products get
      // zero-quantity rows in their selected warehouse(s), but no zero-qty
      // movement is invented in transaction history.
      for (const warehouse of selectedWarehouses) {
        await tx.insert(warehouseStock).values({
          productId: product.id,
          warehouseId: warehouse.id,
          qtyPieces: 0,
          updatedAt: new Date(),
        });
      }
    }

    return { product, stockWarehouses: selectedWarehouses, openingTransactions };
  } catch (error) {
    // The unique constraint remains the final guard when two registrations
    // race after the pre-check. Never turn that race into a false success.
    if (isUniqueViolation(error)) {
      throw new HttpError(409, `A product with SKU "${sku}" already exists.`);
    }
    throw error;
  }
}

/** Standalone/web entry point; MCP uses the transaction-aware variant above. */
export async function registerProductDetailed(
  input: RegisterInput,
  userId: number,
  sourceApp: ApplicationSource = "web",
): Promise<RegisterProductDetailedResult> {
  await ensureMcpInventorySchema();
  return db.transaction((tx) =>
    registerProductDetailedInTransaction(tx, input, userId, sourceApp),
  );
}

/**
 * Original product-registration API used by the website, bulk import and seed.
 * Its return value and web source default remain backward-compatible.
 */
export async function registerProduct(
  input: RegisterInput,
  userId: number,
): Promise<Product> {
  const result = await registerProductDetailed(input, userId, "web");
  return result.product;
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

export type AddProductWarehouseInput = {
  warehouseId: number;
  openingQty: number;
  unit?: StockUnit;
};

export type AddedProductWarehouse = {
  warehouseId: number;
  warehouseName: string;
  qtyPieces: number;
  transaction: Transaction | null;
};

export type AddProductToWarehousesResult = {
  productId: number;
  sku: string;
  added: AddedProductWarehouse[];
  skippedWarehouseIds: number[];
  resultingTotalPieces: number;
};

/**
 * Lists an existing product in one or more additional warehouses inside a
 * single database transaction.
 *
 * - Validates that the product and every requested warehouse exist.
 * - Deduplicates repeated warehouse IDs in the payload and skips warehouses
 *   that already have a `warehouse_stock` row for this product.
 * - Creates a 0-qty `warehouse_stock` row when opening stock is 0 (matching
 *   `registerProduct`), and uses `performOperationDetailedInTransaction`
 *   (`inbound` with reason `"Opening stock"`) when opening stock > 0 so audit
 *   history and running totals stay accurate.
 */
export async function addProductToWarehousesInTransaction(
  tx: DbTransaction,
  productId: number,
  entries: AddProductWarehouseInput[],
  userId: number,
): Promise<AddProductToWarehousesResult> {
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new HttpError(400, "Invalid product id.");
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new HttpError(400, "Select at least one warehouse.");
  }

  const byWarehouse = new Map<number, AddProductWarehouseInput>();
  const skippedDuplicatePayloadIds: number[] = [];
  for (const entry of entries) {
    if (!Number.isInteger(entry.warehouseId) || entry.warehouseId <= 0) {
      throw new HttpError(400, "Warehouse is invalid.");
    }
    if (!Number.isInteger(entry.openingQty) || entry.openingQty < 0) {
      throw new HttpError(400, "Opening stock must be a whole number (0 or more).");
    }
    if (byWarehouse.has(entry.warehouseId)) {
      if (!skippedDuplicatePayloadIds.includes(entry.warehouseId)) {
        skippedDuplicatePayloadIds.push(entry.warehouseId);
      }
      continue;
    }
    byWarehouse.set(entry.warehouseId, entry);
  }

  const deduped = [...byWarehouse.values()].sort(
    (a, b) => a.warehouseId - b.warehouseId,
  );

  const [product] = await tx
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1)
    .for("update");
  if (!product) {
    throw new HttpError(404, "Product not found.");
  }

  const requestedIds = deduped.map((e) => e.warehouseId);
  const warehouseRows = await tx
    .select({ id: warehouses.id, name: warehouses.name })
    .from(warehouses)
    .where(inArray(warehouses.id, requestedIds))
    .orderBy(asc(warehouses.id))
    .for("update");
  if (warehouseRows.length !== requestedIds.length) {
    throw new HttpError(400, "One or more selected warehouses do not exist.");
  }
  const warehouseNameById = new Map(warehouseRows.map((w) => [w.id, w.name]));

  const existingStockRows = await tx
    .select({ warehouseId: warehouseStock.warehouseId })
    .from(warehouseStock)
    .where(
      and(
        eq(warehouseStock.productId, product.id),
        inArray(warehouseStock.warehouseId, requestedIds),
      ),
    )
    .orderBy(asc(warehouseStock.warehouseId))
    .for("update");
  const existingWarehouseIds = new Set(
    existingStockRows.map((row) => row.warehouseId),
  );

  const perCarton = Math.max(product.cartonContains, 1);
  for (const entry of deduped) {
    if (existingWarehouseIds.has(entry.warehouseId)) continue;
    const unit = entry.unit ?? product.stockUnit;
    const pieces = toPieces(entry.openingQty, unit, perCarton);
    if (!Number.isSafeInteger(pieces) || pieces > MAX_STOCK_PIECES) {
      throw new HttpError(
        400,
        "Opening stock is too large for StarStock's quantity limits.",
      );
    }
  }

  const added: AddedProductWarehouse[] = [];
  const skippedSet = new Set<number>(skippedDuplicatePayloadIds);

  for (const entry of deduped) {
    if (existingWarehouseIds.has(entry.warehouseId)) {
      skippedSet.add(entry.warehouseId);
      continue;
    }

    const warehouseName = warehouseNameById.get(entry.warehouseId) ?? "";
    const unit = entry.unit ?? product.stockUnit;

    if (entry.openingQty === 0) {
      const inserted = await tx
        .insert(warehouseStock)
        .values({
          productId: product.id,
          warehouseId: entry.warehouseId,
          qtyPieces: 0,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [warehouseStock.productId, warehouseStock.warehouseId],
        })
        .returning({ warehouseId: warehouseStock.warehouseId });

      if (inserted.length === 0) {
        skippedSet.add(entry.warehouseId);
        continue;
      }

      added.push({
        warehouseId: entry.warehouseId,
        warehouseName,
        qtyPieces: 0,
        transaction: null,
      });
    } else {
      const opResult = await performOperationDetailedInTransaction(tx, {
        type: "inbound",
        productId: product.id,
        qty: entry.openingQty,
        unit,
        warehouseId: entry.warehouseId,
        toWarehouseId: null,
        destination: null,
        reason: "Opening stock",
        userId,
        sourceApp: "web",
      });

      added.push({
        warehouseId: entry.warehouseId,
        warehouseName,
        qtyPieces: opResult.resultingWarehousePieces ?? opResult.transaction.qtyPieces,
        transaction: opResult.transaction,
      });
    }
  }

  const totalRows = await tx
    .select({
      value: sql<string>`coalesce(sum(${warehouseStock.qtyPieces}), 0)::text`,
    })
    .from(warehouseStock)
    .where(eq(warehouseStock.productId, product.id));
  const resultingTotalPieces = Number(totalRows[0]?.value ?? 0);
  if (
    !Number.isSafeInteger(resultingTotalPieces) ||
    resultingTotalPieces > MAX_STOCK_PIECES
  ) {
    throw new HttpError(
      400,
      "Resulting total stock exceeds StarStock's quantity limits.",
    );
  }

  return {
    productId: product.id,
    sku: product.sku,
    added,
    skippedWarehouseIds: [...skippedSet].sort((a, b) => a - b),
    resultingTotalPieces,
  };
}

export async function addProductToWarehouses(
  productId: number,
  entries: AddProductWarehouseInput[],
  userId: number,
): Promise<AddProductToWarehousesResult> {
  await ensureMcpInventorySchema();
  return db.transaction((tx) =>
    addProductToWarehousesInTransaction(tx, productId, entries, userId),
  );
}
