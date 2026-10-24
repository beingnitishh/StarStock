import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  products,
  transactions,
  users,
  warehouseStock,
  warehouses,
} from "@/db/schema";
import { ensureMcpInventorySchema } from "./mcp-schema";
import { normalizeApplicationSource, type ApplicationSource } from "./source-app";
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

type ProductEntity = typeof products.$inferSelect;

/** Attach only the stock rows belonging to the supplied product page. */
async function hydrateProductRows(prods: ProductEntity[]): Promise<ProductRow[]> {
  if (prods.length === 0) return [];

  const stockRows = await db
    .select({
      productId: warehouseStock.productId,
      warehouseId: warehouseStock.warehouseId,
      qtyPieces: warehouseStock.qtyPieces,
      warehouseName: warehouses.name,
    })
    .from(warehouseStock)
    .innerJoin(warehouses, eq(warehouseStock.warehouseId, warehouses.id))
    .where(inArray(warehouseStock.productId, prods.map((p) => p.id)));

  const byProduct = new Map<number, ProductStock[]>();
  for (const stock of stockRows) {
    const rows = byProduct.get(stock.productId) ?? [];
    rows.push({
      warehouseId: stock.warehouseId,
      warehouseName: stock.warehouseName,
      qtyPieces: stock.qtyPieces,
    });
    byProduct.set(stock.productId, rows);
  }

  return prods.map((product) => {
    const stocks = (byProduct.get(product.id) ?? []).sort(
      (a, b) => a.warehouseId - b.warehouseId,
    );
    return {
      ...product,
      totalPieces: stocks.reduce((total, stock) => total + stock.qtyPieces, 0),
      stocks,
    };
  });
}

/**
 * Loads product rows (each with its per-warehouse stock) for the products
 * matching `where`. Pass `undefined` to load the whole catalogue.
 *
 * Only the stock rows of the selected products are fetched, so asking for a
 * single product never pulls the whole catalogue or every warehouse balance.
 */
async function loadProductRows(where?: SQL): Promise<ProductRow[]> {
  const prods = await db.select().from(products).where(where);
  const rows = await hydrateProductRows(prods);
  return rows.sort((a, b) => skuCompare(a.sku, b.sku));
}

export async function fetchProductRows(): Promise<ProductRow[]> {
  return loadProductRows();
}

/** One product (plus its warehouse stock), or `null` when it does not exist. */
export async function fetchProductRow(id: number): Promise<ProductRow | null> {
  if (!Number.isInteger(id)) return null;
  const rows = await loadProductRows(eq(products.id, id));
  return rows[0] ?? null;
}

/**
 * One product looked up by its SKU, or `null`.
 *
 * SKUs are unique and stored as entered, so the indexed exact match runs
 * first; only when that finds nothing do we fall back to a case-insensitive
 * match (sheets and image file names are often typed in another case).
 */
export async function fetchProductBySku(sku: string): Promise<ProductRow | null> {
  const value = sku.trim();
  if (!value) return null;
  const exact = await loadProductRows(eq(products.sku, value));
  if (exact[0]) return exact[0];
  const ci = await loadProductRows(
    sql`lower(${products.sku}) = ${value.toLowerCase()}`,
  );
  return ci[0] ?? null;
}

export type ProductPage = {
  products: ProductRow[];
  totalCount: number;
};

/**
 * Efficient offset pagination for MCP. Product id is the stable order and the
 * stock query is bounded to this page rather than hydrating the whole catalogue.
 */
export async function fetchProductPage(limit: number, offset: number): Promise<ProductPage> {
  const [countRows, prods] = await Promise.all([
    db.select({ value: sql<number>`count(*)::int` }).from(products),
    db.select().from(products).orderBy(asc(products.id)).limit(limit).offset(offset),
  ]);
  return {
    products: await hydrateProductRows(prods),
    totalCount: countRows[0]?.value ?? 0,
  };
}

export type CatalogueSummary = {
  totalProducts: number;
  zeroStockProducts: number;
  totalPieces: number;
  warehouses: Array<{ id: number; name: string; totalPieces: number }>;
};

/** Database-level catalogue totals; products without any stock row count as zero. */
export async function fetchCatalogueSummary(): Promise<CatalogueSummary> {
  const [aggregateResult, warehouseRows] = await Promise.all([
    db.execute(sql`
      WITH product_totals AS (
        SELECT ${products.id} AS product_id,
               coalesce(sum(${warehouseStock.qtyPieces}), 0)::numeric AS total_pieces
        FROM ${products}
        LEFT JOIN ${warehouseStock} ON ${warehouseStock.productId} = ${products.id}
        GROUP BY ${products.id}
      )
      SELECT count(*)::int AS total_products,
             count(*) FILTER (WHERE total_pieces = 0)::int AS zero_stock_products,
             coalesce(sum(total_pieces), 0)::text AS total_pieces
      FROM product_totals
    `),
    db
      .select({
        id: warehouses.id,
        name: warehouses.name,
        totalPieces: sql<string>`coalesce(sum(${warehouseStock.qtyPieces}), 0)::text`,
      })
      .from(warehouses)
      .leftJoin(warehouseStock, eq(warehouseStock.warehouseId, warehouses.id))
      .groupBy(warehouses.id, warehouses.name)
      .orderBy(asc(warehouses.id)),
  ]);

  const aggregate = aggregateResult.rows[0] as
    | { total_products: number; zero_stock_products: number; total_pieces: string }
    | undefined;
  return {
    totalProducts: Number(aggregate?.total_products ?? 0),
    zeroStockProducts: Number(aggregate?.zero_stock_products ?? 0),
    totalPieces: Number(aggregate?.total_pieces ?? 0),
    warehouses: warehouseRows.map((warehouse) => ({
      id: warehouse.id,
      name: warehouse.name,
      totalPieces: Number(warehouse.totalPieces),
    })),
  };
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
  sourceApp: ApplicationSource;
  previousTotalPieces: number | null;
  clientRequestId: string | null;
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
  // The web history UI can be the first request after deployment. Bootstrap
  // nullable audit columns before selecting them, just like OAuth tables.
  await ensureMcpInventorySchema();
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
      sourceApp: transactions.sourceApp,
      previousTotalPieces: transactions.previousTotalPieces,
      clientRequestId: transactions.clientRequestId,
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

  return rows.map((row) => ({
    ...row,
    type: row.type as TxRow["type"],
    enteredUnit: row.enteredUnit as StockUnit,
    sourceApp: normalizeApplicationSource(row.sourceApp),
    sku: row.sku ?? "",
    productName: row.productName ?? "",
    cartonContains: row.cartonContains ?? 1,
  }));
}
