import { and, desc, eq, gte, ilike, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  products,
  transactions,
  users,
  warehouseStock,
  warehouses,
} from "@/db/schema";
import { migrateLegacyProductImages } from "./product-images";
import { skuCompare, type StockUnit } from "./units";

export type ProductStock = {
  warehouseId: number;
  warehouseName: string;
  qtyPieces: number;
};

export type ProductRow = {
  id: number;
  sku: string;
  name: string;
  imageUrl: string;
  stockUnit: StockUnit;
  cartonContains: number;
  openingStockPieces: number;
  createdAt: Date;
  totalPieces: number;
  stocks: ProductStock[];
};

export async function fetchProductRows(): Promise<ProductRow[]> {
  const [prods, stockRows] = await Promise.all([
    db.select().from(products),
    db
      .select({
        productId: warehouseStock.productId,
        warehouseId: warehouseStock.warehouseId,
        qtyPieces: warehouseStock.qtyPieces,
        warehouseName: warehouses.name,
      })
      .from(warehouseStock)
      .innerJoin(warehouses, eq(warehouseStock.warehouseId, warehouses.id)),
  ]);
  const byProduct = new Map<number, ProductStock[]>();
  for (const s of stockRows) {
    const arr = byProduct.get(s.productId) ?? [];
    arr.push({
      warehouseId: s.warehouseId,
      warehouseName: s.warehouseName,
      qtyPieces: s.qtyPieces,
    });
    byProduct.set(s.productId, arr);
  }
  const rows: ProductRow[] = prods
    .map((p) => {
      const stocks = (byProduct.get(p.id) ?? []).sort(
        (a, b) => a.warehouseId - b.warehouseId,
      );
      return {
        ...p,
        totalPieces: stocks.reduce((acc, s) => acc + s.qtyPieces, 0),
        stocks,
      };
    })
    .sort((a, b) => skuCompare(a.sku, b.sku));

  // Heal products that stored a raw (possibly truncated) data URL in the old
  // column: the payload moves to `product_images` and `imageUrl` becomes a
  // lightweight served URL. No-op once there is nothing left to migrate.
  await migrateLegacyProductImages(rows);

  return rows;
}

export async function fetchProductRow(id: number): Promise<ProductRow | null> {
  const all = await fetchProductRows();
  return all.find((p) => p.id === id) ?? null;
}

export type TxFilters = {
  q?: string;
  type?: string;
  warehouseId?: number;
  productId?: number;
  from?: Date;
  to?: Date;
  sinceDays?: number;
  limit?: number;
};

export type TxRow = {
  id: number;
  type: "inbound" | "outbound" | "transfer" | "adjustment";
  enteredQty: number;
  enteredUnit: StockUnit;
  qtyPieces: number;
  destination: string | null;
  reason: string | null;
  resultingTotalPieces: number;
  createdAt: Date;
  productId: number;
  sku: string;
  productName: string;
  cartonContains: number;
  userName: string | null;
  warehouseName: string | null;
  toWarehouseName: string | null;
};

export async function fetchTransactionRows(f: TxFilters): Promise<TxRow[]> {
  const whFrom = alias(warehouses, "wh_from");
  const whTo = alias(warehouses, "wh_to");
  const conds = [];
  if (f.productId) conds.push(eq(transactions.productId, f.productId));
  if (f.type) conds.push(eq(transactions.type, f.type as "inbound"));
  if (f.warehouseId) {
    conds.push(
      or(
        eq(transactions.warehouseId, f.warehouseId),
        eq(transactions.toWarehouseId, f.warehouseId),
      ),
    );
  }
  if (f.sinceDays) {
    const cutoff = new Date(Date.now() - f.sinceDays * 86_400_000);
    conds.push(gte(transactions.createdAt, cutoff));
  }
  if (f.from) conds.push(gte(transactions.createdAt, f.from));
  if (f.to) conds.push(lte(transactions.createdAt, f.to));
  if (f.q && f.q.trim()) {
    const pattern = `%${f.q.trim()}%`;
    conds.push(
      or(
        ilike(products.sku, pattern),
        ilike(products.name, pattern),
        ilike(transactions.reason, pattern),
        ilike(transactions.destination, pattern),
      ),
    );
  }

  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      enteredQty: transactions.enteredQty,
      enteredUnit: transactions.enteredUnit,
      qtyPieces: transactions.qtyPieces,
      destination: transactions.destination,
      reason: transactions.reason,
      resultingTotalPieces: transactions.resultingTotalPieces,
      createdAt: transactions.createdAt,
      productId: transactions.productId,
      sku: products.sku,
      productName: products.name,
      cartonContains: products.cartonContains,
      userName: users.displayName,
      warehouseName: whFrom.name,
      toWarehouseName: whTo.name,
    })
    .from(transactions)
    .leftJoin(products, eq(transactions.productId, products.id))
    .leftJoin(users, eq(transactions.userId, users.id))
    .leftJoin(whFrom, eq(transactions.warehouseId, whFrom.id))
    .leftJoin(whTo, eq(transactions.toWarehouseId, whTo.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(transactions.createdAt), desc(transactions.id))
    .limit(Math.min(f.limit ?? 300, 500));

  return rows.map((r) => ({
    ...r,
    type: r.type as TxRow["type"],
    enteredUnit: r.enteredUnit as StockUnit,
    sku: r.sku ?? "",
    productName: r.productName ?? "",
    cartonContains: r.cartonContains ?? 1,
  }));
}
