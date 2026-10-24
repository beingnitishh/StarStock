import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "@/lib/db-transaction";
import { products, type Transaction } from "@/db/schema";
import { HttpError } from "@/lib/api";
import { checkImageUrl } from "@/lib/images";
import { requireMcpWriter, type McpWriter } from "@/lib/mcp-auth";
import {
  MCP_CLIENT_REQUEST_ID_MAX_LENGTH,
  runMcpWriteWithIdempotency,
} from "@/lib/mcp-idempotency";
import { errorResult, jsonResult } from "@/lib/mcp-response";
import { registerProductDetailedInTransaction } from "@/lib/products";
import { normalizeApplicationSource } from "@/lib/source-app";
import { performOperationDetailedInTransaction } from "@/lib/stock";
import { MAX_STOCK_PIECES, type StockUnit } from "@/lib/units";

type AddProductInput = {
  sku: string;
  name?: string;
  stockUnit?: StockUnit;
  cartonContains: number;
  openingQty?: number;
  warehouseId: number;
  imageUrl?: string;
  client_request_id?: string;
};

type StockMovementInput = {
  sku: string;
  quantity: number;
  unit: StockUnit;
  warehouseId: number;
  reason?: string;
  reference?: string;
  client_request_id?: string;
};

type OutboundStockInput = StockMovementInput & { destination?: string };

type ProductIdentity = { id: number; sku: string; name: string };

const clientRequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MCP_CLIENT_REQUEST_ID_MAX_LENGTH)
  .optional()
  .describe(
    "Optional idempotency key. Reuse by the same authenticated user within 24 hours returns the original result without repeating the write.",
  );

const addProductSchema = {
  client_request_id: clientRequestIdSchema,
  sku: z.string().trim().min(1).max(60).describe("Unique product SKU (exact, case-sensitive)."),
  name: z.string().trim().max(120).optional().describe("Product name; optional like the web listing form."),
  stockUnit: z
    .enum(["piece", "carton"])
    .optional()
    .describe("Unit used for openingQty. Defaults to piece."),
  cartonContains: z
    .number()
    .int()
    .min(1)
    .max(MAX_STOCK_PIECES)
    .describe("Configured pieces per carton, used for carton conversion."),
  openingQty: z
    .number()
    .int()
    .min(0)
    .max(MAX_STOCK_PIECES)
    .optional()
    .describe("Opening quantity in stockUnit. Defaults to 0."),
  warehouseId: z
    .number()
    .int()
    .positive()
    .describe("Existing warehouse id for opening stock (see list_warehouses)."),
  imageUrl: z
    .string()
    .trim()
    .max(4_000)
    .optional()
    .describe("Optional validated http(s) or site-relative image URL. MCP does not accept image uploads/data URLs."),
};

const movementSchema = {
  client_request_id: clientRequestIdSchema,
  sku: z.string().trim().min(1).max(60).describe("Exact, case-sensitive product SKU."),
  quantity: z.number().int().positive().max(MAX_STOCK_PIECES).describe("Positive whole quantity to move."),
  unit: z.enum(["piece", "carton"]).describe("Unit of quantity; cartons use the product's cartonContains."),
  warehouseId: z.number().int().positive().describe("Existing warehouse id (see list_warehouses)."),
  reason: z.string().trim().min(1).max(500).optional().describe("Optional movement reason."),
  reference: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Optional short reference. Provide either reason or reference, not both."),
};

const outboundSchema = {
  ...movementSchema,
  destination: z.string().trim().min(1).max(120).optional().describe("Optional outbound destination."),
};

function actor(writer: McpWriter) {
  return {
    id: writer.user.id,
    username: writer.user.username,
    displayName: writer.user.displayName,
  };
}

function auditTransaction(input: {
  transaction: Transaction;
  product: ProductIdentity;
  writer: McpWriter;
  warehouseName: string | null;
  toWarehouseName?: string | null;
  previousWarehousePieces?: number | null;
  resultingWarehousePieces?: number | null;
}) {
  const { transaction, product, writer } = input;
  return {
    id: transaction.id,
    type: transaction.type,
    productId: product.id,
    sku: product.sku,
    productName: product.name,
    enteredQty: transaction.enteredQty,
    enteredUnit: transaction.enteredUnit,
    qtyPieces: transaction.qtyPieces,
    warehouse: transaction.warehouseId
      ? { id: transaction.warehouseId, name: input.warehouseName }
      : null,
    toWarehouse: transaction.toWarehouseId
      ? { id: transaction.toWarehouseId, name: input.toWarehouseName ?? null }
      : null,
    destination: transaction.destination,
    reason: transaction.reason,
    previousWarehousePieces: input.previousWarehousePieces ?? null,
    resultingWarehousePieces: input.resultingWarehousePieces ?? null,
    previousTotalPieces: transaction.previousTotalPieces,
    clientRequestId: transaction.clientRequestId,
    resultingTotalPieces: transaction.resultingTotalPieces,
    sourceApp: normalizeApplicationSource(transaction.sourceApp),
    createdAt: transaction.createdAt.toISOString(),
    by: actor(writer),
  };
}

function writeFailure(error: unknown): CallToolResult {
  if (error instanceof HttpError) return errorResult(error.message);
  // Do not log database errors, connection strings, tokens, prompts, or tool
  // arguments. The transaction wrapper has already rejected the operation.
  console.error("[mcp] Inventory write failed.");
  return errorResult("The inventory change could not be completed. Please retry or contact an Admin.");
}

async function exactProduct(tx: DbTransaction, sku: string): Promise<ProductIdentity | null> {
  const rows = await tx
    .select({ id: products.id, sku: products.sku, name: products.name })
    .from(products)
    .where(eq(products.sku, sku))
    .limit(1);
  return rows[0] ?? null;
}

function reasonFrom(input: StockMovementInput): string | null {
  if (input.reason && input.reference) {
    throw new HttpError(400, "Provide either reason or reference, not both.");
  }
  return input.reason ?? input.reference ?? null;
}

export async function addProductTool(
  input: AddProductInput,
  authInfo: AuthInfo | undefined,
): Promise<CallToolResult> {
  try {
    const writer = await requireMcpWriter(authInfo);
    const clientRequestId = input.client_request_id?.trim() ?? null;
    return await runMcpWriteWithIdempotency(
      writer.user.id,
      input.client_request_id,
      async (tx) => {
        if (input.imageUrl && /^data:/i.test(input.imageUrl)) {
          throw new HttpError(
            400,
            "MCP supports validated image URLs only. Upload image files through the StarStock website.",
          );
        }
        const imageCheck = checkImageUrl(input.imageUrl ?? "");
        if (!imageCheck.ok) throw new HttpError(400, imageCheck.error);

        const created = await registerProductDetailedInTransaction(
          tx,
          {
            sku: input.sku,
            name: input.name ?? "",
            imageUrl: imageCheck.value,
            stockUnit: input.stockUnit ?? "piece",
            cartonContains: input.cartonContains,
            openingQty: input.openingQty ?? 0,
            warehouseId: input.warehouseId,
          },
          writer.user.id,
          writer.sourceApp,
          clientRequestId,
        );
        const opening = created.openingTransactions[0] ?? null;
        const transaction = opening
          ? auditTransaction({
              transaction: opening.transaction,
              product: created.product,
              writer,
              warehouseName: opening.warehouseName,
              previousWarehousePieces: 0,
              resultingWarehousePieces: opening.transaction.qtyPieces,
            })
          : null;
        const sourceApp = normalizeApplicationSource(
          opening?.transaction.sourceApp ?? writer.sourceApp,
        );
        const product = {
          id: created.product.id,
          sku: created.product.sku,
          name: created.product.name,
          imageUrl: created.product.imageUrl,
          stockUnit: created.product.stockUnit,
          cartonContains: created.product.cartonContains,
          totalPieces: created.product.openingStockPieces,
          warehouses: [
            {
              warehouseId: input.warehouseId,
              warehouse: created.stockWarehouses[0]?.name ?? null,
              qtyPieces: created.product.openingStockPieces,
            },
          ],
        };

        return jsonResult(
          `Created ${created.product.sku} with ${created.product.openingStockPieces} opening pieces` +
            (transaction
              ? ` and inbound transaction #${transaction.id}`
              : " (no opening-stock transaction for zero quantity)") +
            ` via ${sourceApp}.`,
          {
            ok: true,
            product,
            openingQty: input.openingQty ?? 0,
            openingUnit: created.product.stockUnit,
            openingPieces: created.product.openingStockPieces,
            sourceApp,
            clientRequestId,
            createdBy: actor(writer),
            transaction,
          },
        );
      },
    );
  } catch (error) {
    return writeFailure(error);
  }
}

async function moveStock(
  type: "inbound" | "outbound",
  input: StockMovementInput & { destination?: string },
  authInfo: AuthInfo | undefined,
): Promise<CallToolResult> {
  try {
    const writer = await requireMcpWriter(authInfo);
    const clientRequestId = input.client_request_id?.trim() ?? null;
    return await runMcpWriteWithIdempotency(
      writer.user.id,
      input.client_request_id,
      async (tx) => {
        const product = await exactProduct(tx, input.sku);
        if (!product) {
          throw new HttpError(
            404,
            `No product found with exact SKU "${input.sku}". Use search_products to find it.`,
          );
        }
        const result = await performOperationDetailedInTransaction(tx, {
          type,
          productId: product.id,
          qty: input.quantity,
          unit: input.unit,
          warehouseId: input.warehouseId,
          toWarehouseId: null,
          destination: type === "outbound" ? (input.destination ?? null) : null,
          reason: reasonFrom(input),
          userId: writer.user.id,
          sourceApp: writer.sourceApp,
          clientRequestId,
        });
        const transaction = auditTransaction({
          transaction: result.transaction,
          product,
          writer,
          warehouseName: result.warehouseName,
          previousWarehousePieces: result.previousWarehousePieces,
          resultingWarehousePieces: result.resultingWarehousePieces,
        });
        const sourceApp = normalizeApplicationSource(result.transaction.sourceApp);
        const verb = type === "inbound" ? "Added" : "Removed";

        return jsonResult(
          `${verb} ${result.transaction.qtyPieces} pieces ${type === "inbound" ? "into" : "from"} ${result.warehouseName}. ` +
            `Warehouse stock is now ${result.resultingWarehousePieces} pieces; total stock is ${result.resultingTotalPieces}. Transaction #${result.transaction.id} via ${sourceApp}.`,
          {
            ok: true,
            type,
            product,
            [type === "inbound" ? "quantityAdded" : "quantityRemoved"]: input.quantity,
            unit: input.unit,
            [type === "inbound" ? "quantityAddedPieces" : "quantityRemovedPieces"]:
              result.transaction.qtyPieces,
            warehouse: { id: input.warehouseId, name: result.warehouseName },
            previousWarehousePieces: result.previousWarehousePieces,
            resultingWarehousePieces: result.resultingWarehousePieces,
            previousTotalPieces: result.transaction.previousTotalPieces,
            resultingTotalPieces: result.resultingTotalPieces,
            sourceApp,
            clientRequestId,
            transaction,
          },
        );
      },
    );
  } catch (error) {
    return writeFailure(error);
  }
}

export async function inboundStockTool(
  input: StockMovementInput,
  authInfo: AuthInfo | undefined,
): Promise<CallToolResult> {
  return moveStock("inbound", input, authInfo);
}

export async function outboundStockTool(
  input: OutboundStockInput,
  authInfo: AuthInfo | undefined,
): Promise<CallToolResult> {
  return moveStock("outbound", input, authInfo);
}

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "add_product",
    {
      title: "Add product",
      description:
        "Create one product and its opening stock atomically using StarStock's existing product registration path. " +
        "Positive opening stock records an inbound Opening stock transaction. Requires starstock.write and a current Admin, Stock Head, or Stock Boy account. " +
        "Images are validated URLs only; file/data-URL uploads remain available on the website. " +
        "Provide client_request_id for safe retries: the same user's key replays the original result for 24 hours.",
      inputSchema: addProductSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => addProductTool(input, extra.authInfo),
  );

  server.registerTool(
    "inbound_stock",
    {
      title: "Receive stock",
      description:
        "Add a positive piece/carton quantity to an exact SKU at one warehouse, with atomic stock and transaction writes. " +
        "Returns committed before/after warehouse and total stock plus the audit record. Requires starstock.write and an inventory-writing role. " +
        "Provide client_request_id for 24-hour same-user retry protection.",
      inputSchema: movementSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => inboundStockTool(input, extra.authInfo),
  );

  server.registerTool(
    "outbound_stock",
    {
      title: "Issue stock",
      description:
        "Remove a positive piece/carton quantity from an exact SKU at one warehouse. " +
        "Uses StarStock's product/stock locking and rejects insufficient stock without partial writes. Requires starstock.write and an inventory-writing role. " +
        "Provide client_request_id for 24-hour same-user retry protection.",
      inputSchema: outboundSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) => outboundStockTool(input, extra.authInfo),
  );
}
