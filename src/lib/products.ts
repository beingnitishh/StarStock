import { db } from "@/db";
import { products, transactions, warehouseStock } from "@/db/schema";
import { toPieces, type StockUnit } from "./units";

export type RegisterInput = {
  sku: string;
  name: string;
  imageUrl: string;
  stockUnit: StockUnit;
  cartonContains: number;
  openingQty: number;
  warehouseId: number;
};

/**
 * Creates a product, applies its opening stock to a warehouse and records the
 * opening stock as the first inbound transaction.
 */
export async function registerProduct(input: RegisterInput, userId: number) {
  return db.transaction(async (tx) => {
    const openingPieces = toPieces(
      input.openingQty,
      input.stockUnit,
      input.cartonContains,
    );
    const [p] = await tx
      .insert(products)
      .values({
        sku: input.sku,
        name: input.name,
        imageUrl: input.imageUrl,
        stockUnit: input.stockUnit,
        cartonContains: input.cartonContains,
        openingStockPieces: openingPieces,
        createdBy: userId,
      })
      .returning();
    if (openingPieces > 0) {
      await tx.insert(warehouseStock).values({
        productId: p.id,
        warehouseId: input.warehouseId,
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
        warehouseId: input.warehouseId,
        reason: "Opening stock",
        resultingTotalPieces: openingPieces,
      });
    }
    return p;
  });
}
