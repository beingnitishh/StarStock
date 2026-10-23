import { asc } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/db";
import { warehouses } from "@/db/schema";
import {
  fetchProductBySku,
  fetchProductRows,
  fetchTransactionRows,
  type ProductRow,
} from "@/lib/query";

/**
 * Read-only StarStock tools exposed over MCP.
 *
 * Every tool here only reads. There are deliberately no tools that create,
 * move, adjust or delete stock: an MCP client can look, never touch. Each
 * result contains a short human-readable summary followed by the same data as
 * JSON so a model can both quote it and reason over it.
 */

const MAX_SEARCH_RESULTS = 25;
const MAX_TRANSACTIONS = 100;
const MAX_LOW_STOCK_ROWS = 100;

type WarehouseQty = { warehouse: string; warehouseId: number; qtyPieces: number };

function stockBreakdown(product: ProductRow): WarehouseQty[] {
  return product.stocks.map((s) => ({
    warehouse: s.warehouseName,
    warehouseId: s.warehouseId,
    qtyPieces: s.qtyPieces,
  }));
}

function productSummary(product: ProductRow): string {
  const parts = stockBreakdown(product)
    .map((s) => `${s.warehouse}: ${s.qtyPieces} pcs`)
    .join(", ");
  const per = product.cartonContains > 1 ? ` (1 carton = ${product.cartonContains} pcs)` : "";
  return `${product.sku} — ${product.name || "unnamed"}: ${product.totalPieces} pcs total${per}${
    parts ? ` — ${parts}` : " — no warehouse stock"
  }`;
}

/** A tool result with a human summary first, then the machine-readable JSON. */
function jsonResult(summary: string, data: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

export function registerReadOnlyTools(server: McpServer): void {
  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search the StarStock catalogue for products whose SKU or product name contains the given text (case-insensitive). " +
        `Returns at most ${MAX_SEARCH_RESULTS} matches with the SKU, name, stock unit, pieces per carton, current total stock in pieces, and the quantity held in each warehouse. ` +
        "Use this to find a product when you do not know its exact SKU; use get_product for full details and recent history of one known SKU.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .describe("Text to look for in the SKU or product name, e.g. \"coffee\" or \"CFE\"."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const needle = query.trim().toLowerCase();
      const all = await fetchProductRows();
      const matches = all
        .filter((p) => p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))
        .slice(0, MAX_SEARCH_RESULTS);

      if (matches.length === 0) {
        return jsonResult(
          `No products match "${query}". The catalogue has ${all.length} products.`,
          { query, count: 0, catalogueSize: all.length, products: [] },
        );
      }

      const summary =
        `Found ${matches.length} product${matches.length === 1 ? "" : "s"} matching "${query}"` +
        (matches.length === MAX_SEARCH_RESULTS ? ` (showing the first ${MAX_SEARCH_RESULTS})` : "") +
        `:\n` +
        matches.map((p) => `• ${productSummary(p)}`).join("\n");

      return jsonResult(summary, {
        query,
        count: matches.length,
        truncated: matches.length === MAX_SEARCH_RESULTS,
        products: matches.map((p) => ({
          sku: p.sku,
          name: p.name,
          stockUnit: p.stockUnit,
          cartonContains: p.cartonContains,
          totalPieces: p.totalPieces,
          warehouses: stockBreakdown(p),
        })),
      });
    },
  );

  server.registerTool(
    "get_product",
    {
      title: "Get product details",
      description:
        "Look up a single product by its exact SKU (case-insensitive) and return its stock per warehouse plus its 10 most recent stock movements. " +
        "Use this after search_products has given you a SKU, when the user asks how much of something is in stock or what happened to it recently.",
      inputSchema: {
        sku: z.string().trim().min(1).describe('The product SKU, e.g. "CFE-250".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sku }) => {
      const product = await fetchProductBySku(sku);
      if (!product) {
        return errorResult(
          `No product found with SKU "${sku}". Use search_products to find the right SKU.`,
        );
      }
      const history = await fetchTransactionRows({ productId: product.id, limit: 10 });

      const summary =
        `${productSummary(product)}\n` +
        (history.length === 0
          ? "No stock movements recorded yet."
          : `Last ${history.length} movement${history.length === 1 ? "" : "s"}:\n` +
            history
              .map(
                (t) =>
                  `• ${t.createdAt.toISOString().slice(0, 10)} — ${t.type} ${t.enteredQty} ${t.enteredUnit} ` +
                  `(${t.qtyPieces} pcs)` +
                  (t.warehouseName ? ` at ${t.warehouseName}` : "") +
                  (t.toWarehouseName ? ` → ${t.toWarehouseName}` : "") +
                  (t.destination ? ` to ${t.destination}` : "") +
                  (t.reason ? ` — ${t.reason}` : ""),
              )
              .join("\n"));

      return jsonResult(summary, {
        product: {
          sku: product.sku,
          name: product.name,
          stockUnit: product.stockUnit,
          cartonContains: product.cartonContains,
          openingStockPieces: product.openingStockPieces,
          totalPieces: product.totalPieces,
          warehouses: stockBreakdown(product),
        },
        recentTransactions: history.map((t) => ({
          id: t.id,
          type: t.type,
          enteredQty: t.enteredQty,
          enteredUnit: t.enteredUnit,
          qtyPieces: t.qtyPieces,
          warehouse: t.warehouseName,
          toWarehouse: t.toWarehouseName,
          destination: t.destination,
          reason: t.reason,
          resultingTotalPieces: t.resultingTotalPieces,
          createdAt: t.createdAt.toISOString(),
          by: t.userName,
        })),
      });
    },
  );

  server.registerTool(
    "list_warehouses",
    {
      title: "List warehouses",
      description:
        "List every StarStock warehouse with its id and name. Use the ids with list_transactions when the user asks about stock or movements in a particular warehouse.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = await db
        .select({ id: warehouses.id, name: warehouses.name, createdAt: warehouses.createdAt })
        .from(warehouses)
        .orderBy(asc(warehouses.id));

      const summary =
        rows.length === 0
          ? "No warehouses exist yet."
          : `${rows.length} warehouse${rows.length === 1 ? "" : "s"}: ` +
            rows.map((w) => `${w.name} (id ${w.id})`).join(", ");

      return jsonResult(summary, {
        count: rows.length,
        warehouses: rows.map((w) => ({
          id: w.id,
          name: w.name,
          createdAt: w.createdAt.toISOString(),
        })),
      });
    },
  );

  server.registerTool(
    "low_stock",
    {
      title: "Find low stock products",
      description:
        "List products whose total stock across all warehouses is at or below the given number of pieces, lowest first. " +
        "Use this when the user asks what is running out or needs reordering. Compare against a full carton where relevant (cartonContains).",
      inputSchema: {
        threshold_pieces: z
          .number()
          .int()
          .min(0)
          .describe("Stock level in pieces at or below which a product counts as low, e.g. 24."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ threshold_pieces }) => {
      const rows = (await fetchProductRows())
        .filter((p) => p.totalPieces <= threshold_pieces)
        .sort((a, b) => a.totalPieces - b.totalPieces);

      const shown = rows.slice(0, MAX_LOW_STOCK_ROWS);
      const summary =
        rows.length === 0
          ? `Every product has more than ${threshold_pieces} pieces in stock.`
          : `${rows.length} product${rows.length === 1 ? " is" : "s are"} at or below ${threshold_pieces} pcs` +
            (rows.length > shown.length ? ` (showing ${shown.length})` : "") +
            `:\n` +
            shown.map((p) => `• ${productSummary(p)}`).join("\n");

      return jsonResult(summary, {
        thresholdPieces: threshold_pieces,
        count: rows.length,
        truncated: rows.length > shown.length,
        products: shown.map((p) => ({
          sku: p.sku,
          name: p.name,
          stockUnit: p.stockUnit,
          cartonContains: p.cartonContains,
          totalPieces: p.totalPieces,
          warehouses: stockBreakdown(p),
        })),
      });
    },
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List stock movements",
      description:
        "List stock movements (inbound, outbound, transfer, adjustment), newest first, with optional filters. " +
        `Returns at most ${MAX_TRANSACTIONS} rows. Filter by free text (SKU, product name, reason or destination), movement type, warehouse id, product id, and an ISO date range. ` +
        "Use this to answer questions like \"what went out last week\" or \"show movements for CFE-250\".",
      inputSchema: {
        q: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Free text matched against SKU, product name, reason and destination."),
        type: z
          .enum(["inbound", "outbound", "transfer", "adjustment"])
          .optional()
          .describe("Only movements of this type."),
        warehouseId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only movements from/to this warehouse id (see list_warehouses)."),
        productId: z.number().int().positive().optional().describe("Only movements of this product id."),
        from: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Include movements on or after this date (ISO 8601, e.g. 2026-01-31)."),
        to: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Include movements on or before this date (ISO 8601, e.g. 2026-02-28)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_TRANSACTIONS)
          .optional()
          .describe(`How many movements to return, 1-${MAX_TRANSACTIONS}. Defaults to 25.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ q, type, warehouseId, productId, from, to, limit }) => {
      const fromDate = from ? new Date(from) : undefined;
      if (fromDate && Number.isNaN(fromDate.getTime())) {
        return errorResult(`"${from}" is not a valid date. Use ISO 8601, e.g. 2026-01-31.`);
      }
      const toDate = to ? new Date(to) : undefined;
      if (toDate && Number.isNaN(toDate.getTime())) {
        return errorResult(`"${to}" is not a valid date. Use ISO 8601, e.g. 2026-02-28.`);
      }
      // A date-only upper bound means "the whole day".
      if (toDate && to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        toDate.setHours(23, 59, 59, 999);
      }

      const rows = await fetchTransactionRows({
        q,
        type,
        warehouseId,
        productId,
        from: fromDate,
        to: toDate,
        limit: limit ?? 25,
      });

      const summary =
        rows.length === 0
          ? "No stock movements match those filters."
          : `${rows.length} stock movement${rows.length === 1 ? "" : "s"} (newest first):\n` +
            rows
              .map(
                (t) =>
                  `• ${t.createdAt.toISOString().slice(0, 16).replace("T", " ")} — ${t.sku} ${t.type} ` +
                  `${t.qtyPieces} pcs` +
                  (t.warehouseName ? ` at ${t.warehouseName}` : "") +
                  (t.toWarehouseName ? ` → ${t.toWarehouseName}` : "") +
                  (t.destination ? ` to ${t.destination}` : ""),
              )
              .join("\n");

      return jsonResult(summary, {
        count: rows.length,
        filters: { q, type, warehouseId, productId, from, to, limit: limit ?? 25 },
        transactions: rows.map((t) => ({
          id: t.id,
          type: t.type,
          sku: t.sku,
          productName: t.productName,
          enteredQty: t.enteredQty,
          enteredUnit: t.enteredUnit,
          qtyPieces: t.qtyPieces,
          warehouse: t.warehouseName,
          toWarehouse: t.toWarehouseName,
          destination: t.destination,
          reason: t.reason,
          resultingTotalPieces: t.resultingTotalPieces,
          createdAt: t.createdAt.toISOString(),
          by: t.userName,
        })),
      });
    },
  );
}
