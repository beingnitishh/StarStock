import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { products, transactions, warehouseStock, warehouses } from "@/db/schema";
import { HttpError } from "./api";
import type { StockUnit } from "./units";
import { toPieces } from "./units";

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
};

async function totalPiecesFor(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  productId: number,
): Promise<number> {
  const rows = await tx
    .select({ value: sql<number>`coalesce(sum(${warehouseStock.qtyPieces}), 0)::int` })
    .from(warehouseStock)
    .where(eq(warehouseStock.productId, productId));
  return rows[0]?.value ?? 0;
}

async function addStock(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
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

async function getWarehouseName(warehouseId: number): Promise<string> {
  const rows = await db
    .select({ name: warehouses.name })
    .from(warehouses)
    .where(eq(warehouses.id, warehouseId))
    .limit(1);
  return rows[0]?.name ?? `Warehouse #${warehouseId}`;
}

export async function performOperation(input: OpInput): Promise<{
  resultingTotalPieces: number;
}> {
  return db.transaction(async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    if (!product) throw new HttpError(404, "Product not found.");
    const perCarton = Math.max(product.cartonContains, 1);

    const record = async (extra: {
      warehouseId: number | null;
      toWarehouseId?: number | null;
      destination?: string | null;
    }) => {
      const resulting = await totalPiecesFor(tx, product.id);
      await tx.insert(transactions).values({
        type: input.type,
        productId: product.id,
        userId: input.userId,
        enteredQty: input.qty,
        enteredUnit: input.unit,
        qtyPieces: toPieces(input.qty, input.unit, perCarton),
        warehouseId: extra.warehouseId,
        toWarehouseId: extra.toWarehouseId ?? null,
        destination: extra.destination ?? null,
        reason: input.reason?.trim() ? input.reason.trim() : null,
        resultingTotalPieces: resulting,
      });
      return resulting;
    };

    if (input.type === "adjustment") {
      if (!input.warehouseId) {
        throw new HttpError(400, "Select the warehouse this adjustment applies to.");
      }
      const finalPieces = toPieces(input.qty, input.unit, perCarton);
      if (!Number.isInteger(finalPieces) || finalPieces < 0) {
        throw new HttpError(400, "Final stock must be a whole number (0 or more).");
      }
      await tx
        .insert(warehouseStock)
        .values({
          productId: product.id,
          warehouseId: input.warehouseId,
          qtyPieces: finalPieces,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [warehouseStock.productId, warehouseStock.warehouseId],
          set: { qtyPieces: finalPieces, updatedAt: new Date() },
        });
      const resulting = await record({ warehouseId: input.warehouseId });
      return { resultingTotalPieces: resulting };
    }

    const delta = toPieces(input.qty, input.unit, perCarton);
    if (!Number.isInteger(delta) || delta <= 0) {
      throw new HttpError(400, "Quantity must be a whole number greater than zero.");
    }

    if (input.type === "inbound") {
      if (!input.warehouseId) {
        throw new HttpError(400, "Select the destination warehouse for the inbound stock.");
      }
      await addStock(tx, product.id, input.warehouseId, delta);
      const resulting = await record({ warehouseId: input.warehouseId });
      return { resultingTotalPieces: resulting };
    }

    if (input.type === "outbound") {
      if (!input.warehouseId) {
        throw new HttpError(400, "Select the source warehouse for the outbound stock.");
      }
      const available = await lockedStock(tx, product.id, input.warehouseId);
      if (available < delta) {
        const name = await getWarehouseName(input.warehouseId);
        throw new HttpError(
          400,
          `Insufficient stock in ${name}: available ${available} pcs, requested ${delta} pcs.`,
        );
      }
      await tx
        .insert(warehouseStock)
        .values({
          productId: product.id,
          warehouseId: input.warehouseId,
          qtyPieces: available - delta,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [warehouseStock.productId, warehouseStock.warehouseId],
          set: { qtyPieces: available - delta, updatedAt: new Date() },
        });
      const resulting = await record({
        warehouseId: input.warehouseId,
        destination: input.destination,
      });
      return { resultingTotalPieces: resulting };
    }

    // transfer
    if (!input.warehouseId || !input.toWarehouseId) {
      throw new HttpError(400, "Select both the source and destination warehouse.");
    }
    if (input.warehouseId === input.toWarehouseId) {
      throw new HttpError(400, "Source and destination warehouse must be different.");
    }
    const available = await lockedStock(tx, product.id, input.warehouseId);
    if (available < delta) {
      const name = await getWarehouseName(input.warehouseId);
      throw new HttpError(
        400,
        `Insufficient stock in ${name}: available ${available} pcs, requested ${delta} pcs.`,
      );
    }
    await tx
      .insert(warehouseStock)
      .values({
        productId: product.id,
        warehouseId: input.warehouseId,
        qtyPieces: available - delta,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [warehouseStock.productId, warehouseStock.warehouseId],
        set: { qtyPieces: available - delta, updatedAt: new Date() },
      });
    await addStock(tx, product.id, input.toWarehouseId, delta);
    const resulting = await record({
      warehouseId: input.warehouseId,
      toWarehouseId: input.toWarehouseId,
    });
    return { resultingTotalPieces: resulting };
  });
}
