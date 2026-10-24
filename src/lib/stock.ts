import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  products,
  transactions,
  warehouseStock,
  warehouses,
  type Transaction,
} from "@/db/schema";
import { HttpError } from "./api";
import type { DbTransaction } from "./db-transaction";
import { ensureMcpInventorySchema } from "./mcp-schema";
import type { ApplicationSource } from "./source-app";
import { MAX_STOCK_PIECES, toPieces, type StockUnit } from "./units";

export type OpType = "inbound" | "outbound" | "transfer" | "adjustment";

export type OpInput = {
  type: OpType;
  productId: number;
  qty: number;
  unit: StockUnit;
  warehouseId: number | null;
  toWarehouseId: number | null;
  destination: string | null;
  reason: string | null;
  userId: number;
  /** Internal server attribution only; web callers default to `web`. */
  sourceApp?: ApplicationSource;
  /** Optional MCP retry key persisted with the resulting audit transaction. */
  clientRequestId?: string | null;
};

export type PerformOperationDetailedResult = {
  resultingTotalPieces: number;
  transaction: Transaction;
  warehouseName: string | null;
  toWarehouseName: string | null;
  previousWarehousePieces: number | null;
  resultingWarehousePieces: number | null;
};

async function totalPiecesFor(tx: DbTransaction, productId: number): Promise<number> {
  const rows = await tx
    .select({ value: sql<string>`coalesce(sum(${warehouseStock.qtyPieces}), 0)::text` })
    .from(warehouseStock)
    .where(eq(warehouseStock.productId, productId));
  return Number(rows[0]?.value ?? 0);
}

async function addStock(
  tx: DbTransaction,
  productId: number,
  warehouseId: number,
  delta: number,
): Promise<void> {
  await tx
    .insert(warehouseStock)
    .values({ productId, warehouseId, qtyPieces: delta, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [warehouseStock.productId, warehouseStock.warehouseId],
      set: {
        qtyPieces: sql`${warehouseStock.qtyPieces} + ${delta}`,
        updatedAt: new Date(),
      },
    });
}

async function lockedStock(
  tx: DbTransaction,
  productId: number,
  warehouseId: number,
): Promise<number> {
  const rows = await tx
    .select()
    .from(warehouseStock)
    .where(
      and(
        eq(warehouseStock.productId, productId),
        eq(warehouseStock.warehouseId, warehouseId),
      ),
    )
    .for("update");
  return rows[0]?.qtyPieces ?? 0;
}

/** Detailed audit API; all website and MCP operations share this transaction. */
export async function performOperationDetailedInTransaction(
  tx: DbTransaction,
  input: OpInput,
): Promise<PerformOperationDetailedResult> {
  // Serialize every stock movement for this product. In addition to the
  // existing outbound protection, this makes before/after totals consistent
  // when concurrent MCP and web operations target different warehouses.
  const [product] = await tx
    .select()
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1)
    .for("update");
  if (!product) throw new HttpError(404, "Product not found.");
  const perCarton = Math.max(product.cartonContains, 1);
  const sourceApp = input.sourceApp ?? "web";
  const warehouseNames = new Map<number, string>();

  const requireWarehouse = async (warehouseId: number): Promise<string> => {
    const cached = warehouseNames.get(warehouseId);
    if (cached) return cached;
    const rows = await tx
      .select({ name: warehouses.name })
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .limit(1)
      .for("update");
    if (!rows[0]) throw new HttpError(400, "Selected warehouse does not exist.");
    warehouseNames.set(warehouseId, rows[0].name);
    return rows[0].name;
  };

  const convertedPieces = toPieces(input.qty, input.unit, perCarton);
  if (!Number.isSafeInteger(convertedPieces) || convertedPieces > MAX_STOCK_PIECES) {
    throw new HttpError(400, "Quantity is too large for StarStock's quantity limits.");
  }
  if (input.type === "adjustment") {
    if (convertedPieces < 0) {
      throw new HttpError(400, "Final stock must be a whole number (0 or more).");
    }
  } else if (convertedPieces <= 0) {
    throw new HttpError(400, "Quantity must be a whole number greater than zero.");
  }

  // Captured after the product lock and before any stock write.
  const previousTotalPieces = await totalPiecesFor(tx, product.id);

  const record = async (extra: {
    warehouseId: number | null;
    toWarehouseId?: number | null;
    destination?: string | null;
    previousWarehousePieces?: number | null;
    resultingWarehousePieces?: number | null;
  }): Promise<PerformOperationDetailedResult> => {
    const resultingTotalPieces = await totalPiecesFor(tx, product.id);
    if (
      !Number.isSafeInteger(resultingTotalPieces) ||
      resultingTotalPieces > MAX_STOCK_PIECES
    ) {
      throw new HttpError(400, "Resulting total stock exceeds StarStock's quantity limits.");
    }
    const [transaction] = await tx
      .insert(transactions)
      .values({
        type: input.type,
        productId: product.id,
        userId: input.userId,
        enteredQty: input.qty,
        enteredUnit: input.unit,
        qtyPieces: convertedPieces,
        warehouseId: extra.warehouseId,
        toWarehouseId: extra.toWarehouseId ?? null,
        destination: extra.destination ?? null,
        reason: input.reason?.trim() ? input.reason.trim() : null,
        sourceApp,
        previousTotalPieces,
        clientRequestId: input.clientRequestId ?? null,
        resultingTotalPieces,
      })
      .returning();
    if (!transaction) throw new Error("Stock transaction insert returned no row.");

    return {
      resultingTotalPieces,
      transaction,
      warehouseName: extra.warehouseId
        ? (warehouseNames.get(extra.warehouseId) ?? null)
        : null,
      toWarehouseName: extra.toWarehouseId
        ? (warehouseNames.get(extra.toWarehouseId) ?? null)
        : null,
      previousWarehousePieces: extra.previousWarehousePieces ?? null,
      resultingWarehousePieces: extra.resultingWarehousePieces ?? null,
    };
  };

  if (input.type === "adjustment") {
    if (!input.warehouseId) {
      throw new HttpError(400, "Select the warehouse this adjustment applies to.");
    }
    await requireWarehouse(input.warehouseId);
    const previousWarehousePieces = await lockedStock(tx, product.id, input.warehouseId);
    await tx
      .insert(warehouseStock)
      .values({
        productId: product.id,
        warehouseId: input.warehouseId,
        qtyPieces: convertedPieces,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [warehouseStock.productId, warehouseStock.warehouseId],
        set: { qtyPieces: convertedPieces, updatedAt: new Date() },
      });
    return record({
      warehouseId: input.warehouseId,
      previousWarehousePieces,
      resultingWarehousePieces: convertedPieces,
    });
  }

  if (input.type === "inbound") {
    if (!input.warehouseId) {
      throw new HttpError(400, "Select the destination warehouse for the inbound stock.");
    }
    await requireWarehouse(input.warehouseId);
    const previousWarehousePieces = await lockedStock(tx, product.id, input.warehouseId);
    await addStock(tx, product.id, input.warehouseId, convertedPieces);
    return record({
      warehouseId: input.warehouseId,
      previousWarehousePieces,
      resultingWarehousePieces: previousWarehousePieces + convertedPieces,
    });
  }

  if (input.type === "outbound") {
    if (!input.warehouseId) {
      throw new HttpError(400, "Select the source warehouse for the outbound stock.");
    }
    const warehouseName = await requireWarehouse(input.warehouseId);
    const available = await lockedStock(tx, product.id, input.warehouseId);
    if (available < convertedPieces) {
      throw new HttpError(
        400,
        `Insufficient stock in ${warehouseName}: available ${available} pcs, requested ${convertedPieces} pcs.`,
      );
    }
    const resultingWarehousePieces = available - convertedPieces;
    await tx
      .insert(warehouseStock)
      .values({
        productId: product.id,
        warehouseId: input.warehouseId,
        qtyPieces: resultingWarehousePieces,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [warehouseStock.productId, warehouseStock.warehouseId],
        set: { qtyPieces: resultingWarehousePieces, updatedAt: new Date() },
      });
    return record({
      warehouseId: input.warehouseId,
      destination: input.destination,
      previousWarehousePieces: available,
      resultingWarehousePieces,
    });
  }

  // transfer
  if (!input.warehouseId || !input.toWarehouseId) {
    throw new HttpError(400, "Select both the source and destination warehouse.");
  }
  if (input.warehouseId === input.toWarehouseId) {
    throw new HttpError(400, "Source and destination warehouse must be different.");
  }
  const warehouseName = await requireWarehouse(input.warehouseId);
  await requireWarehouse(input.toWarehouseId);
  const available = await lockedStock(tx, product.id, input.warehouseId);
  if (available < convertedPieces) {
    throw new HttpError(
      400,
      `Insufficient stock in ${warehouseName}: available ${available} pcs, requested ${convertedPieces} pcs.`,
    );
  }
  const resultingWarehousePieces = available - convertedPieces;
  await tx
    .insert(warehouseStock)
    .values({
      productId: product.id,
      warehouseId: input.warehouseId,
      qtyPieces: resultingWarehousePieces,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [warehouseStock.productId, warehouseStock.warehouseId],
      set: { qtyPieces: resultingWarehousePieces, updatedAt: new Date() },
    });
  await addStock(tx, product.id, input.toWarehouseId, convertedPieces);
  return record({
    warehouseId: input.warehouseId,
    toWarehouseId: input.toWarehouseId,
    previousWarehousePieces: available,
    resultingWarehousePieces,
  });
}

/** Standalone/web entry point; MCP uses the transaction-aware variant above. */
export async function performOperationDetailed(
  input: OpInput,
): Promise<PerformOperationDetailedResult> {
  await ensureMcpInventorySchema();
  return db.transaction((tx) => performOperationDetailedInTransaction(tx, input));
}

/**
 * Original website/seed API. Keep its response shape unchanged while using
 * the same detailed transaction implementation as MCP.
 */
export async function performOperation(
  input: OpInput,
): Promise<{ resultingTotalPieces: number }> {
  const result = await performOperationDetailed({ ...input, sourceApp: "web" });
  return { resultingTotalPieces: result.resultingTotalPieces };
}
