import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Role } from "@/lib/roles";

const CHATGPT_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const READ_SCOPE = "starstock.read";
const WRITE_SCOPE = "starstock.read starstock.write";

let embedded: EmbeddedPostgres;
let control: Client;
let dataDirectory = "";
let db: typeof import("@/db").db;
let pool: typeof import("@/db").pool;
let schema: typeof import("@/db/schema");
let catalogue: typeof import("@/lib/query");
let productsLib: typeof import("@/lib/products");
let stockLib: typeof import("@/lib/stock");
let oauth: typeof import("@/lib/oauth");
let oauthAuthorize: typeof import("@/lib/oauth-authorize");
let mcpAuth: typeof import("@/lib/mcp-auth");
let writeTools: typeof import("@/lib/mcp-write-tools");
let mcpPOST: typeof import("@/app/api/[transport]/route").POST;

let legacyProductId = 0;
let legacyWarehouseId = 0;
let secondWarehouseId = 0;
let legacyUserId = 0;
let chatgptReadToken = "";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port available.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

beforeAll(async () => {
  dataDirectory = path.join(
    tmpdir(),
    `starstock-mcp-test-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  const port = await availablePort();
  embedded = new EmbeddedPostgres({
    databaseDir: dataDirectory,
    user: "postgres",
    password: "test-only-password",
    port,
    persistent: false,
    onLog: () => {},
  });
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase("starstock_test");

  const connectionString = `postgresql://postgres:test-only-password@127.0.0.1:${port}/starstock_test`;
  if (!connectionString.includes("127.0.0.1")) throw new Error("Refusing a non-local test database.");
  process.env.DATABASE_URL = connectionString;
  control = new Client({ connectionString });
  await control.connect();
  const currentSchema = await readFile(
    path.join(process.cwd(), "tests/fixtures/pre-migration-schema.sql"),
    "utf8",
  );
  await control.query(currentSchema);

  // Import application modules only after DATABASE_URL points at the isolated
  // cluster. No module ever receives an external/production connection string.
  [db, pool, schema, catalogue, productsLib, stockLib, oauth, oauthAuthorize, mcpAuth, writeTools] =
    await Promise.all([
      import("@/db").then((module) => module.db),
      import("@/db").then((module) => module.pool),
      import("@/db/schema"),
      import("@/lib/query"),
      import("@/lib/products"),
      import("@/lib/stock"),
      import("@/lib/oauth"),
      import("@/lib/oauth-authorize"),
      import("@/lib/mcp-auth"),
      import("@/lib/mcp-write-tools"),
    ]);
  mcpPOST = (await import("@/app/api/[transport]/route")).POST;
});

afterAll(async () => {
  if (pool) await pool.end();
  if (control) await control.end();
  if (embedded) await embedded.stop();
});

async function createUser(role: Role = "admin") {
  const suffix = randomUUID().slice(0, 8);
  const rows = await db
    .insert(schema.users)
    .values({
      username: `test-${suffix}`,
      displayName: `Test ${role} ${suffix}`,
      passwordHash: "not-used-by-oauth-tests",
      role,
    })
    .returning();
  return rows[0];
}

async function createWarehouse(label = "Warehouse") {
  const rows = await db
    .insert(schema.warehouses)
    .values({ name: `${label} ${randomUUID().slice(0, 8)}` })
    .returning();
  return rows[0];
}

async function issueConnection(
  userId: number,
  platform: "chatgpt" | "claude" | "unknown",
  scope = WRITE_SCOPE,
) {
  const redirectUris =
    platform === "chatgpt"
      ? [CHATGPT_CALLBACK]
      : platform === "claude"
        ? [CLAUDE_CALLBACK]
        // Eligible for write by host, but not a documented hosted callback,
        // so server attribution must remain unknown.
        : ["https://connector.chatgpt.com/custom/oauth/callback"];
  const client = await oauth.registerOAuthClient({
    // A spoofed name alone must never influence source attribution.
    clientName: platform === "unknown" ? "ChatGPT" : platform,
    redirectUris,
  });
  const tokens = await oauth.issueTokens(client.clientId, userId, scope);
  return { client, tokens };
}

async function verifiedAuth(token: string): Promise<AuthInfo> {
  const auth = await oauth.verifyAccessToken(token);
  if (!auth) throw new Error("Expected a valid test access token.");
  return auth;
}

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  tools?: Array<{
    name: string;
    inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
  }>;
};

type McpResponse = {
  status: number;
  result?: ToolResult;
  error?: { message?: string };
};

let requestId = 0;
async function callMcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
): Promise<McpResponse> {
  const id = ++requestId;
  const response = await mcpPOST(
    new Request("http://starstock.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    { params: Promise.resolve({ transport: "mcp" }) },
  );
  const text = await response.text();
  let payload: { result?: ToolResult; error?: { message?: string } } = {};
  if (text.trim()) {
    if (text.trimStart().startsWith("{")) {
      payload = JSON.parse(text) as typeof payload;
    } else {
      const messages = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()) as { id?: number } & typeof payload);
      payload = messages.find((message) => message.id === id) ?? messages.at(-1) ?? {};
    }
  }
  return { status: response.status, ...payload };
}

function callTool(
  token: string | null,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpResponse> {
  return callMcp(token, "tools/call", { name, arguments: args });
}

function toolData<T>(response: McpResponse): T {
  if (response.error) throw new Error(response.error.message ?? "MCP JSON-RPC error");
  const text = response.result?.content?.[1]?.text;
  if (!text) {
    throw new Error(`Expected JSON tool data, got ${JSON.stringify(response.result)}`);
  }
  return JSON.parse(text) as T;
}

function toolError(response: McpResponse): string {
  return response.result?.content?.[0]?.text ?? response.error?.message ?? "Missing MCP error";
}

function contentText(result: CallToolResult, index = 0): string {
  const content = result.content[index];
  if (content?.type !== "text") throw new Error("Expected MCP text content.");
  return content.text;
}

async function productBySku(sku: string) {
  const rows = await db.select().from(schema.products).where(eq(schema.products.sku, sku));
  return rows[0] ?? null;
}

// Use direct SQL helpers for assertions where Drizzle's callback form would
// obscure which exact row is being checked.
async function stockValue(productId: number, warehouseId: number): Promise<number> {
  const result = await control.query<{ qty_pieces: number }>(
    "SELECT qty_pieces FROM warehouse_stock WHERE product_id = $1 AND warehouse_id = $2",
    [productId, warehouseId],
  );
  return result.rows[0]?.qty_pieces ?? 0;
}

async function transactionRows(productId: number) {
  const result = await control.query(
    "SELECT * FROM transactions WHERE product_id = $1 ORDER BY id",
    [productId],
  );
  return result.rows as Array<Record<string, unknown>>;
}

describe("StarStock MCP inventory expansion (isolated PostgreSQL)", () => {
  test("empty catalogue and summary return correct zero values before migration", async () => {
    const page = await catalogue.fetchProductPage(25, 0);
    expect(page).toEqual({ products: [], totalCount: 0 });
    expect(await catalogue.fetchCatalogueSummary()).toEqual({
      totalProducts: 0,
      zeroStockProducts: 0,
      totalPieces: 0,
      warehouses: [],
    });
  });

  test("first-use bootstrap and additive migration preserve history and are safe to rerun", async () => {
    const user = await control.query<{ id: number }>(
      "INSERT INTO users (username, password_hash, display_name, role) VALUES ('legacy-admin', 'unused', 'Legacy Admin', 'admin') RETURNING id",
    );
    legacyUserId = user.rows[0].id;
    const warehouse = await control.query<{ id: number }>(
      "INSERT INTO warehouses (name, created_by) VALUES ('Legacy Main', $1) RETURNING id",
      [legacyUserId],
    );
    legacyWarehouseId = warehouse.rows[0].id;
    const second = await control.query<{ id: number }>(
      "INSERT INTO warehouses (name, created_by) VALUES ('Legacy East', $1) RETURNING id",
      [legacyUserId],
    );
    secondWarehouseId = second.rows[0].id;
    const product = await control.query<{ id: number }>(
      "INSERT INTO products (sku, name, stock_unit, carton_contains, opening_stock_pieces, created_by) VALUES ('LEGACY-5', 'Legacy product', 'piece', 1, 5, $1) RETURNING id",
      [legacyUserId],
    );
    legacyProductId = product.rows[0].id;
    await control.query(
      "INSERT INTO warehouse_stock (product_id, warehouse_id, qty_pieces) VALUES ($1, $2, 5)",
      [legacyProductId, legacyWarehouseId],
    );
    await control.query(
      "INSERT INTO transactions (type, product_id, user_id, entered_qty, entered_unit, qty_pieces, warehouse_id, reason, resulting_total_pieces) VALUES ('inbound', $1, $2, 5, 'piece', 5, $3, 'Historical opening', 5)",
      [legacyProductId, legacyUserId, legacyWarehouseId],
    );

    // Exercise the web history query before any manual migration command. Its
    // first-use bootstrap must make the new projection safe on the old schema.
    const automaticRows = await catalogue.fetchTransactionRows({ productId: legacyProductId });
    expect(automaticRows[0]).toMatchObject({
      sourceApp: "unknown",
      previousTotalPieces: null,
      clientRequestId: null,
    });
    const bootstrapped = await control.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.mcp_write_requests')::text AS table_name",
    );
    expect(bootstrapped.rows[0].table_name).toBe("mcp_write_requests");

    const migration = await readFile(
      path.join(process.cwd(), "drizzle/0001_mcp_transaction_audit.sql"),
      "utf8",
    );
    await control.query(migration);
    await control.query(migration);

    const historical = await transactionRows(legacyProductId);
    expect(historical).toHaveLength(1);
    expect(historical[0].source_app).toBeNull();
    expect(historical[0].previous_total_pieces).toBeNull();
    expect(historical[0].client_request_id).toBeNull();
    expect(historical[0].reason).toBe("Historical opening");
    const rows = await catalogue.fetchTransactionRows({ productId: legacyProductId });
    expect(rows[0].sourceApp).toBe("unknown");
    expect(rows[0].previousTotalPieces).toBeNull();
  });

  test("pagination is stable and catalogue/warehouse aggregates include zero and multi-warehouse stock", async () => {
    const registrations = [
      { sku: "PAGE-01", qty: 0, unit: "piece" as const, per: 1, warehouseId: legacyWarehouseId },
      { sku: "PAGE-02", qty: 2, unit: "carton" as const, per: 3, warehouseId: legacyWarehouseId },
      { sku: "PAGE-03", qty: 4, unit: "piece" as const, per: 1, warehouseId: secondWarehouseId },
      { sku: "PAGE-04", qty: 1, unit: "piece" as const, per: 1, warehouseId: legacyWarehouseId },
      { sku: "PAGE-05", qty: 0, unit: "piece" as const, per: 1, warehouseId: secondWarehouseId },
      { sku: "PAGE-06", qty: 1, unit: "piece" as const, per: 1, warehouseId: legacyWarehouseId },
      { sku: "PAGE-07", qty: 2, unit: "piece" as const, per: 1, warehouseId: secondWarehouseId },
    ];
    const created = new Map<string, number>();
    for (const item of registrations) {
      const product = await productsLib.registerProduct(
        {
          sku: item.sku,
          name: item.sku,
          imageUrl: "",
          stockUnit: item.unit,
          cartonContains: item.per,
          openingQty: item.qty,
          warehouseId: item.warehouseId,
        },
        legacyUserId,
      );
      created.set(item.sku, product.id);
    }
    const webResult = await stockLib.performOperation({
      type: "inbound",
      productId: created.get("PAGE-04")!,
      qty: 5,
      unit: "piece",
      warehouseId: secondWarehouseId,
      toWarehouseId: null,
      destination: null,
      reason: "Multi-warehouse fixture",
      userId: legacyUserId,
    });
    expect(webResult).toEqual({ resultingTotalPieces: 6 });

    const pages = await Promise.all([
      catalogue.fetchProductPage(3, 0),
      catalogue.fetchProductPage(3, 3),
      catalogue.fetchProductPage(3, 6),
    ]);
    expect(pages.map((page) => page.products.length)).toEqual([3, 3, 2]);
    expect(pages.every((page) => page.totalCount === 8)).toBe(true);
    const ids = pages.flatMap((page) => page.products.map((product) => product.id));
    expect(new Set(ids).size).toBe(8);
    for (const page of pages) {
      const pageIds = page.products.map((product) => product.id);
      expect(pageIds).toEqual([...pageIds].sort((a, b) => a - b));
    }
    expect(pages[2].products[1].sku).toBe("PAGE-07");
    const multi = pages.flatMap((page) => page.products).find((product) => product.sku === "PAGE-04");
    expect(multi?.totalPieces).toBe(6);
    expect(multi?.stocks).toHaveLength(2);

    expect(await catalogue.fetchCatalogueSummary()).toEqual({
      totalProducts: 8,
      zeroStockProducts: 2,
      totalPieces: 24,
      warehouses: [
        { id: legacyWarehouseId, name: "Legacy Main", totalPieces: 13 },
        { id: secondWarehouseId, name: "Legacy East", totalPieces: 11 },
      ],
    });

    const readUser = await createUser("member");
    const connection = await issueConnection(readUser.id, "chatgpt", READ_SCOPE);
    chatgptReadToken = connection.tokens.access_token;
    const first = await callTool(chatgptReadToken, "list_products", { limit: 3, offset: 0 });
    expect(first.status).toBe(200);
    expect(first.result?.isError).not.toBe(true);
    const firstData = toolData<{
      count: number;
      totalCount: number;
      hasMore: boolean;
      nextOffset: number;
      products: Array<{ sku: string; warehouses: unknown[] }>;
    }>(first);
    expect(firstData).toMatchObject({ count: 3, totalCount: 8, hasMore: true, nextOffset: 3 });
    const last = toolData<{ count: number; hasMore: boolean; nextOffset: null }>(
      await callTool(chatgptReadToken, "list_products", { limit: 3, offset: 6 }),
    );
    expect(last).toMatchObject({ count: 2, hasMore: false, nextOffset: null });
  });

  test("ChatGPT add_product commits opening stock, exact audit fields, and rejects duplicate SKU", async () => {
    const user = await createUser("admin");
    const connection = await issueConnection(user.id, "chatgpt");
    const args = {
      sku: "MCP-ADD-CTN",
      name: "MCP carton product",
      stockUnit: "carton",
      cartonContains: 6,
      openingQty: 2,
      warehouseId: legacyWarehouseId,
      imageUrl: "https://example.com/product.jpg",
    };
    const response = await callTool(connection.tokens.access_token, "add_product", args);
    expect(response.status).toBe(200);
    expect(response.result?.isError).not.toBe(true);
    const data = toolData<{
      ok: boolean;
      sourceApp: string;
      openingPieces: number;
      product: { id: number; warehouses: Array<{ warehouse: string; qtyPieces: number }> };
      transaction: {
        id: number;
        sourceApp: string;
        previousTotalPieces: number;
        resultingTotalPieces: number;
        previousWarehousePieces: number;
        resultingWarehousePieces: number;
        by: { id: number };
      };
    }>(response);
    expect(data.ok).toBe(true);
    expect(data.sourceApp).toBe("chatgpt");
    expect(data.openingPieces).toBe(12);
    expect(data.product.warehouses[0]).toMatchObject({ warehouse: "Legacy Main", qtyPieces: 12 });
    expect(data.transaction).toMatchObject({
      sourceApp: "chatgpt",
      previousTotalPieces: 0,
      resultingTotalPieces: 12,
      previousWarehousePieces: 0,
      resultingWarehousePieces: 12,
      by: { id: user.id },
    });
    expect(await stockValue(data.product.id, legacyWarehouseId)).toBe(12);
    const stored = await productBySku(args.sku);
    expect(stored?.createdBy).toBe(user.id);
    const audit = await transactionRows(data.product.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      source_app: "chatgpt",
      previous_total_pieces: 0,
      resulting_total_pieces: 12,
      entered_qty: 2,
      entered_unit: "carton",
      qty_pieces: 12,
    });

    const duplicate = await callTool(connection.tokens.access_token, "add_product", args);
    expect(duplicate.result?.isError).toBe(true);
    expect(toolError(duplicate)).toContain("already exists");
    expect(await transactionRows(data.product.id)).toHaveLength(1);
  });

  test("Claude inbound/outbound conversion, insufficient stock, and invalid warehouse are atomic", async () => {
    const user = await createUser("stock_head");
    const connection = await issueConnection(user.id, "claude");
    const product = await productBySku("MCP-ADD-CTN");
    if (!product) throw new Error("Missing add_product fixture.");

    const inbound = await callTool(connection.tokens.access_token, "inbound_stock", {
      sku: product.sku,
      quantity: 1,
      unit: "carton",
      warehouseId: legacyWarehouseId,
      reference: "PO-MCP-1",
    });
    expect(inbound.result?.isError).not.toBe(true);
    const inboundData = toolData<{
      quantityAddedPieces: number;
      resultingWarehousePieces: number;
      resultingTotalPieces: number;
      sourceApp: string;
      transaction: { reason: string; previousWarehousePieces: number };
    }>(inbound);
    expect(inboundData).toMatchObject({
      quantityAddedPieces: 6,
      resultingWarehousePieces: 18,
      resultingTotalPieces: 18,
      sourceApp: "claude",
      transaction: { reason: "PO-MCP-1", previousWarehousePieces: 12 },
    });

    const outbound = await callTool(connection.tokens.access_token, "outbound_stock", {
      sku: product.sku,
      quantity: 7,
      unit: "piece",
      warehouseId: legacyWarehouseId,
      destination: "Test destination",
    });
    const outboundData = toolData<{
      quantityRemovedPieces: number;
      resultingWarehousePieces: number;
      resultingTotalPieces: number;
      transaction: { sourceApp: string; destination: string };
    }>(outbound);
    expect(outboundData).toMatchObject({
      quantityRemovedPieces: 7,
      resultingWarehousePieces: 11,
      resultingTotalPieces: 11,
      transaction: { sourceApp: "claude", destination: "Test destination" },
    });

    const beforeFailure = await transactionRows(product.id);
    const insufficient = await callTool(connection.tokens.access_token, "outbound_stock", {
      sku: product.sku,
      quantity: 999,
      unit: "piece",
      warehouseId: legacyWarehouseId,
    });
    expect(insufficient.result?.isError).toBe(true);
    expect(toolError(insufficient)).toContain("Insufficient stock");
    const invalidWarehouse = await callTool(connection.tokens.access_token, "inbound_stock", {
      sku: product.sku,
      quantity: 1,
      unit: "piece",
      warehouseId: 999_999,
    });
    expect(invalidWarehouse.result?.isError).toBe(true);
    expect(toolError(invalidWarehouse)).toContain("warehouse does not exist");
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(11);
    expect(await transactionRows(product.id)).toHaveLength(beforeFailure.length);
  });

  test("image uploads are rejected without creating a product", async () => {
    const user = await createUser("admin");
    const connection = await issueConnection(user.id, "unknown");
    const response = await callTool(connection.tokens.access_token, "add_product", {
      sku: "MCP-IMAGE-UPLOAD",
      name: "No upload",
      cartonContains: 1,
      openingQty: 0,
      warehouseId: legacyWarehouseId,
      imageUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(response.result?.isError).toBe(true);
    expect(toolError(response)).toContain("URLs only");
    expect(await productBySku("MCP-IMAGE-UPLOAD")).toBeNull();
  });

  test("a transaction-insert database error rolls back stock and never returns success", async () => {
    const product = await productsLib.registerProduct(
      {
        sku: "ROLLBACK-1",
        name: "Rollback fixture",
        imageUrl: "",
        stockUnit: "piece",
        cartonContains: 1,
        openingQty: 10,
        warehouseId: legacyWarehouseId,
      },
      legacyUserId,
    );
    await control.query(`
      CREATE FUNCTION reject_mcp_test_transaction() RETURNS trigger AS $$
      BEGIN
        IF NEW.reason = 'FORCE_ROLLBACK:test' THEN
          RAISE EXCEPTION 'forced isolated-test rollback';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_mcp_test_transaction
      BEFORE INSERT ON transactions
      FOR EACH ROW EXECUTE FUNCTION reject_mcp_test_transaction();
    `);
    const user = await createUser("admin");
    const connection = await issueConnection(user.id, "chatgpt");
    const requestId = `rollback-${randomUUID()}`;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await callTool(connection.tokens.access_token, "inbound_stock", {
        sku: product.sku,
        quantity: 5,
        unit: "piece",
        warehouseId: legacyWarehouseId,
        reason: "FORCE_ROLLBACK:test",
        client_request_id: requestId,
      });
      expect(response.result?.isError).toBe(true);
      expect(toolError(response)).not.toContain("forced isolated-test rollback");
      expect(toolError(response)).not.toContain(process.env.DATABASE_URL);
      expect(log).toHaveBeenCalledWith("[mcp] Inventory write failed.");
    } finally {
      log.mockRestore();
    }
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(10);
    expect(await transactionRows(product.id)).toHaveLength(1);
    const failedReservation = await control.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM mcp_write_requests WHERE user_id = $1 AND client_request_id = $2",
      [user.id, requestId],
    );
    expect(failedReservation.rows[0].count).toBe(0);

    const recovered = await callTool(connection.tokens.access_token, "inbound_stock", {
      sku: product.sku,
      quantity: 5,
      unit: "piece",
      warehouseId: legacyWarehouseId,
      reason: "Recovered after isolated rollback",
      client_request_id: requestId,
    });
    expect(recovered.result?.isError).not.toBe(true);
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(15);
    const recoveredAudit = await transactionRows(product.id);
    expect(recoveredAudit).toHaveLength(2);
    expect(recoveredAudit[1].client_request_id).toBe(requestId);
  });

  test("concurrent outbound operations cannot create negative stock or false transactions", async () => {
    const product = await productsLib.registerProduct(
      {
        sku: "CONCURRENT-1",
        name: "Concurrency fixture",
        imageUrl: "",
        stockUnit: "piece",
        cartonContains: 1,
        openingQty: 100,
        warehouseId: legacyWarehouseId,
      },
      legacyUserId,
    );
    const operations = Array.from({ length: 8 }, () =>
      stockLib.performOperationDetailed({
        type: "outbound",
        productId: product.id,
        qty: 20,
        unit: "piece",
        warehouseId: legacyWarehouseId,
        toWarehouseId: null,
        destination: null,
        reason: "Concurrent isolated test",
        userId: legacyUserId,
        sourceApp: "claude",
      }),
    );
    const results = await Promise.allSettled(operations);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(0);
    const audit = await transactionRows(product.id);
    expect(audit).toHaveLength(6); // opening stock + five successful outbound operations
    expect(audit.filter((row) => row.reason === "Concurrent isolated test")).toHaveLength(5);
    expect(audit.every((row) => Number(row.resulting_total_pieces) >= 0)).toBe(true);
  });

  test("add_product replays the original result for 24 hours, including zero opening stock", async () => {
    const user = await createUser("admin");
    const connection = await issueConnection(user.id, "chatgpt");
    const requestId = `add-${randomUUID()}`;
    const firstResponse = await callTool(connection.tokens.access_token, "add_product", {
      sku: "IDEMP-ADD",
      name: "Idempotent product",
      stockUnit: "piece",
      cartonContains: 1,
      openingQty: 2,
      warehouseId: legacyWarehouseId,
      client_request_id: requestId,
    });
    expect(firstResponse.result?.isError).not.toBe(true);
    const first = toolData<{
      clientRequestId: string;
      product: { id: number; sku: string };
      transaction: { id: number; clientRequestId: string };
    }>(firstResponse);
    expect(first.clientRequestId).toBe(requestId);
    expect(first.transaction.clientRequestId).toBe(requestId);

    // The key, not the second payload, determines a recent duplicate. No
    // differently named product or extra opening stock may be created.
    const replay = await callTool(connection.tokens.access_token, "add_product", {
      sku: "IDEMP-SHOULD-NOT-EXIST",
      name: "Different retry payload",
      stockUnit: "piece",
      cartonContains: 1,
      openingQty: 99,
      warehouseId: legacyWarehouseId,
      client_request_id: requestId,
    });
    expect(replay.result).toEqual(firstResponse.result);
    expect(await productBySku("IDEMP-SHOULD-NOT-EXIST")).toBeNull();
    expect(await stockValue(first.product.id, legacyWarehouseId)).toBe(2);
    const audit = await transactionRows(first.product.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].client_request_id).toBe(requestId);

    const zeroRequestId = `add-zero-${randomUUID()}`;
    const zeroArgs = {
      sku: "IDEMP-ADD-ZERO",
      name: "Zero opening idempotency",
      stockUnit: "piece",
      cartonContains: 1,
      openingQty: 0,
      warehouseId: legacyWarehouseId,
      client_request_id: zeroRequestId,
    };
    const zeroFirst = await callTool(connection.tokens.access_token, "add_product", zeroArgs);
    const zeroReplay = await callTool(connection.tokens.access_token, "add_product", zeroArgs);
    expect(zeroFirst.result?.isError).not.toBe(true);
    expect(zeroReplay.result).toEqual(zeroFirst.result);
    const zero = toolData<{
      clientRequestId: string;
      product: { id: number };
      transaction: null;
    }>(zeroFirst);
    expect(zero.clientRequestId).toBe(zeroRequestId);
    expect(zero.transaction).toBeNull();
    expect(await transactionRows(zero.product.id)).toHaveLength(0);
    const saved = await control.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM mcp_write_requests WHERE user_id = $1 AND client_request_id = ANY($2)",
      [user.id, [requestId, zeroRequestId]],
    );
    expect(saved.rows[0].count).toBe(2);
  });

  test("inbound/outbound retries are atomic, concurrent-safe, user-scoped, and expire after 24 hours", async () => {
    const product = await productsLib.registerProduct(
      {
        sku: "IDEMP-MOVE",
        name: "Idempotent movements",
        imageUrl: "",
        stockUnit: "piece",
        cartonContains: 1,
        openingQty: 30,
        warehouseId: legacyWarehouseId,
      },
      legacyUserId,
    );
    const user = await createUser("admin");
    const connection = await issueConnection(user.id, "chatgpt");
    const inboundRequestId = `in-${randomUUID()}`;
    const inboundArgs = {
      sku: product.sku,
      quantity: 3,
      unit: "piece",
      warehouseId: legacyWarehouseId,
      client_request_id: inboundRequestId,
    };
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () =>
        callTool(connection.tokens.access_token, "inbound_stock", inboundArgs),
      ),
    );
    for (const response of concurrent) {
      expect(response.result?.isError).not.toBe(true);
      expect(response.result).toEqual(concurrent[0].result);
    }
    const inbound = toolData<{ transaction: { id: number; clientRequestId: string } }>(concurrent[0]);
    expect(inbound.transaction.clientRequestId).toBe(inboundRequestId);
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(33);
    expect(await transactionRows(product.id)).toHaveLength(2); // opening + one inbound

    // Keys are scoped to the user across all three write tools, not merely to
    // one tool name, so this returns the original inbound response.
    const crossToolReplay = await callTool(connection.tokens.access_token, "outbound_stock", {
      ...inboundArgs,
      quantity: 20,
    });
    expect(crossToolReplay.result).toEqual(concurrent[0].result);
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(33);

    const outboundRequestId = `out-${randomUUID()}`;
    const outboundArgs = {
      sku: product.sku,
      quantity: 2,
      unit: "piece",
      warehouseId: legacyWarehouseId,
      client_request_id: outboundRequestId,
    };
    const outboundFirst = await callTool(connection.tokens.access_token, "outbound_stock", outboundArgs);
    const outboundReplay = await callTool(connection.tokens.access_token, "outbound_stock", outboundArgs);
    expect(outboundReplay.result).toEqual(outboundFirst.result);
    const outbound = toolData<{ transaction: { id: number; clientRequestId: string } }>(outboundFirst);
    expect(outbound.transaction.clientRequestId).toBe(outboundRequestId);
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(31);
    expect(await transactionRows(product.id)).toHaveLength(3);

    const otherUser = await createUser("stock_boy");
    const otherConnection = await issueConnection(otherUser.id, "claude");
    const otherResult = await callTool(otherConnection.tokens.access_token, "outbound_stock", outboundArgs);
    expect(otherResult.result?.isError).not.toBe(true);
    const other = toolData<{ transaction: { id: number } }>(otherResult);
    expect(other.transaction.id).not.toBe(outbound.transaction.id);
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(29);
    expect(await transactionRows(product.id)).toHaveLength(4);

    await control.query(
      "UPDATE mcp_write_requests SET created_at = now() - interval '25 hours' WHERE user_id = $1 AND client_request_id = $2",
      [user.id, outboundRequestId],
    );
    const afterExpiry = await callTool(connection.tokens.access_token, "outbound_stock", outboundArgs);
    expect(afterExpiry.result?.isError).not.toBe(true);
    const expired = toolData<{ transaction: { id: number } }>(afterExpiry);
    expect(expired.transaction.id).not.toBe(outbound.transaction.id);
    expect(await stockValue(product.id, legacyWarehouseId)).toBe(27);
    const finalAudit = await transactionRows(product.id);
    expect(finalAudit).toHaveLength(5);
    expect(finalAudit.filter((row) => row.client_request_id === outboundRequestId)).toHaveLength(3);
  });

  test("Admin, Stock Head and Stock Boy can write; Member can read but never write", async () => {
    for (const role of ["admin", "stock_head", "stock_boy"] as const) {
      const user = await createUser(role);
      const connection = await issueConnection(user.id, "unknown");
      const sku = `ROLE-${role.toUpperCase()}`;
      const created = await writeTools.addProductTool(
        {
          sku,
          name: role,
          stockUnit: "piece",
          cartonContains: 1,
          openingQty: 1,
          warehouseId: legacyWarehouseId,
        },
        await verifiedAuth(connection.tokens.access_token),
      );
      expect(created.isError).not.toBe(true);
      const moved = await writeTools.inboundStockTool(
        { sku, quantity: 1, unit: "piece", warehouseId: legacyWarehouseId },
        await verifiedAuth(connection.tokens.access_token),
      );
      expect(moved.isError).not.toBe(true);
      expect(await stockValue((await productBySku(sku))!.id, legacyWarehouseId)).toBe(2);
    }

    const member = await createUser("member");
    const memberConnection = await issueConnection(member.id, "unknown");
    const memberAuth = await verifiedAuth(memberConnection.tokens.access_token);
    const denied = await writeTools.addProductTool(
      {
        sku: "ROLE-MEMBER-DENIED",
        name: "Must not exist",
        cartonContains: 1,
        openingQty: 1,
        warehouseId: legacyWarehouseId,
      },
      memberAuth,
    );
    expect(denied.isError).toBe(true);
    expect(contentText(denied)).toContain("read-only");
    expect(await productBySku("ROLE-MEMBER-DENIED")).toBeNull();
    const read = await callTool(memberConnection.tokens.access_token, "catalogue_summary");
    expect(read.result?.isError).not.toBe(true);
  });

  test("missing/invalid tokens, inactive accounts, and stale role claims fail closed", async () => {
    expect((await callTool(null, "list_products")).status).toBe(401);
    expect((await callTool("not-a-real-token", "list_products")).status).toBe(401);

    const user = await createUser("stock_boy");
    const connection = await issueConnection(user.id, "claude");
    const staleAuth = await verifiedAuth(connection.tokens.access_token);
    await db.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, user.id));
    await expect(mcpAuth.requireMcpWriter(staleAuth)).rejects.toThrow("read-only");

    await db.update(schema.users).set({ role: "stock_boy", active: false }).where(eq(schema.users.id, user.id));
    expect(await oauth.verifyAccessToken(connection.tokens.access_token)).toBeUndefined();
    expect((await callTool(connection.tokens.access_token, "list_products")).status).toBe(401);
    await expect(mcpAuth.requireMcpWriter(staleAuth)).rejects.toThrow("invalid, expired");
  });

  test("tool-supplied identity/role/source cannot override OAuth identity and registration", async () => {
    const user = await createUser("stock_boy");
    const other = await createUser("admin");
    const connection = await issueConnection(user.id, "unknown");
    const response = await writeTools.inboundStockTool(
      {
        sku: "MCP-ADD-CTN",
        quantity: 1,
        unit: "piece",
        warehouseId: legacyWarehouseId,
        userId: other.id,
        role: "admin",
        sourceApp: "chatgpt",
      } as unknown as Parameters<typeof writeTools.inboundStockTool>[0],
      await verifiedAuth(connection.tokens.access_token),
    );
    expect(response.isError).not.toBe(true);
    const data = JSON.parse(contentText(response, 1)) as {
      sourceApp: string;
      transaction: { sourceApp: string; by: { id: number } };
    };
    expect(data.sourceApp).toBe("unknown");
    expect(data.transaction.sourceApp).toBe("unknown");
    expect(data.transaction.by.id).toBe(user.id);
  });

  test("OAuth write scope is limited to ChatGPT/Claude hosts at authorize, token, and refresh", async () => {
    const allowed = [
      CHATGPT_CALLBACK,
      CLAUDE_CALLBACK,
      "https://connector.eu.chatgpt.com/oauth/callback",
      "https://mcp.eu.claude.ai/oauth/callback",
    ];
    for (const redirectUri of allowed) {
      expect(oauthAuthorize.grantedScope(WRITE_SCOPE, [redirectUri])).toBe(WRITE_SCOPE);
    }
    const denied = [
      "https://example.com/oauth/callback",
      "https://chatgpt.com.evil.example/callback",
      "https://claude.ai.evil.example/callback",
      "http://chatgpt.com/callback",
      "http://localhost:3000/callback",
      "not a URL",
    ];
    for (const redirectUri of denied) {
      expect(oauthAuthorize.grantedScope(WRITE_SCOPE, [redirectUri])).toBe(READ_SCOPE);
    }
    expect(
      oauthAuthorize.grantedScope(WRITE_SCOPE, [CHATGPT_CALLBACK, "https://example.com/callback"]),
    ).toBe(READ_SCOPE);

    const user = await createUser("admin");
    const external = await oauth.registerOAuthClient({
      clientName: "External read-only client",
      redirectUris: ["https://example.com/oauth/callback"],
    });
    const externalTokens = await oauth.issueTokens(external.clientId, user.id, WRITE_SCOPE);
    expect(externalTokens.scope).toBe(READ_SCOPE);
    const externalAuth = await verifiedAuth(externalTokens.access_token);
    expect(externalAuth.scopes).toEqual([READ_SCOPE]);
    await expect(mcpAuth.requireMcpWriter(externalAuth)).rejects.toThrow("starstock.write");

    const outcome = await oauthAuthorize.parseAuthorizeQuery({
      client_id: external.clientId,
      redirect_uri: "https://example.com/oauth/callback",
      response_type: "code",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      scope: WRITE_SCOPE,
    });
    if (outcome.kind !== "ok") throw new Error("Expected a valid external authorization query.");
    expect(outcome.query).toMatchObject({
      scope: READ_SCOPE,
      writeRequested: true,
      writeEligible: false,
    });

    // Even a direct call that bypasses the consent route cannot store a write
    // code for an ineligible registered client.
    const code = await oauth.createAuthorizationCode({
      clientId: external.clientId,
      userId: user.id,
      redirectUri: "https://example.com/oauth/callback",
      codeChallenge: "A".repeat(43),
      codeChallengeMethod: "S256",
      scope: WRITE_SCOPE,
    });
    const codeRows = await db
      .select({ scope: schema.oauthCodes.scope })
      .from(schema.oauthCodes)
      .where(eq(schema.oauthCodes.codeHash, oauth.sha256Hex(code)));
    expect(codeRows[0].scope).toBe(READ_SCOPE);

    const mixed = await oauth.registerOAuthClient({
      clientName: "Mixed registration",
      redirectUris: [CHATGPT_CALLBACK, "https://example.com/callback"],
    });
    expect((await oauth.issueTokens(mixed.clientId, user.id, WRITE_SCOPE)).scope).toBe(READ_SCOPE);

    const subdomain = await oauth.registerOAuthClient({
      clientName: "Eligible subdomain",
      redirectUris: ["https://connector.eu.chatgpt.com/custom/callback"],
    });
    const subdomainTokens = await oauth.issueTokens(subdomain.clientId, user.id, WRITE_SCOPE);
    expect(subdomainTokens.scope).toBe(WRITE_SCOPE);
    expect((await verifiedAuth(subdomainTokens.access_token)).scopes).toContain("starstock.write");

    const refreshClient = await oauth.registerOAuthClient({
      clientName: "Registration changed before refresh",
      redirectUris: [CHATGPT_CALLBACK],
    });
    const refreshTokens = await oauth.issueTokens(refreshClient.clientId, user.id, WRITE_SCOPE);
    expect(refreshTokens.scope).toBe(WRITE_SCOPE);
    await db
      .update(schema.oauthClients)
      .set({ redirectUris: ["https://example.com/new-callback"] })
      .where(eq(schema.oauthClients.clientId, refreshClient.clientId));
    // Existing bearer tokens lose write immediately, and refresh cannot restore it.
    expect((await verifiedAuth(refreshTokens.access_token)).scopes).toEqual([READ_SCOPE]);
    const rotated = await oauth.rotateRefreshToken(refreshTokens.refresh_token, refreshClient.clientId);
    expect(rotated.scope).toBe(READ_SCOPE);
    expect((await verifiedAuth(rotated.access_token)).scopes).toEqual([READ_SCOPE]);
  });

  test("read-only OAuth scope cannot write and refresh does not silently add permissions", async () => {
    expect(oauthAuthorize.grantedScope("")).toBe(READ_SCOPE);
    expect(oauthAuthorize.grantedScope("unknown.scope")).toBe(READ_SCOPE);
    expect(oauthAuthorize.grantedScope("starstock.write")).toBe(READ_SCOPE);
    expect(oauthAuthorize.grantedScope(WRITE_SCOPE, [CHATGPT_CALLBACK])).toBe(WRITE_SCOPE);
    expect(oauthAuthorize.grantedScope(WRITE_SCOPE, [CLAUDE_CALLBACK])).toBe(WRITE_SCOPE);

    const user = await createUser("admin");
    const connection = await issueConnection(user.id, "chatgpt", READ_SCOPE);
    const denied = await callTool(connection.tokens.access_token, "inbound_stock", {
      sku: "MCP-ADD-CTN",
      quantity: 1,
      unit: "piece",
      warehouseId: legacyWarehouseId,
    });
    expect(denied.result?.isError).toBe(true);
    expect(toolError(denied)).toContain("starstock.write");

    const rotated = await oauth.rotateRefreshToken(
      connection.tokens.refresh_token,
      connection.client.clientId,
    );
    expect(rotated.scope).toBe(READ_SCOPE);
    const auth = await verifiedAuth(rotated.access_token);
    expect(auth.scopes).toEqual([READ_SCOPE]);
    expect(auth.extra?.sourceApp).toBe("chatgpt");
    await expect(mcpAuth.requireMcpWriter(auth)).rejects.toThrow("starstock.write");
  });

  test("all existing read tools and new reads work for both ChatGPT and Claude read connections", async () => {
    const claudeUser = await createUser("member");
    const claude = await issueConnection(claudeUser.id, "claude", READ_SCOPE);
    const tokens = [chatgptReadToken, claude.tokens.access_token];
    const toolNames = [
      "search_products",
      "get_product",
      "list_warehouses",
      "low_stock",
      "list_transactions",
      "list_products",
      "catalogue_summary",
      "add_product",
      "inbound_stock",
      "outbound_stock",
    ];

    for (const token of tokens) {
      const listed = await callMcp(token, "tools/list");
      expect(listed.status).toBe(200);
      expect(listed.result?.tools?.map((tool) => tool.name).sort()).toEqual([...toolNames].sort());
      for (const writeTool of ["add_product", "inbound_stock", "outbound_stock"]) {
        const registered = listed.result?.tools?.find((tool) => tool.name === writeTool);
        expect(registered?.inputSchema?.properties).toHaveProperty("client_request_id");
        expect(registered?.inputSchema?.required ?? []).not.toContain("client_request_id");
      }

      const search = toolData<{ products: Array<Record<string, unknown>> }>(
        await callTool(token, "search_products", { query: "PAGE-02" }),
      );
      expect(search.products[0]).toMatchObject({ sku: "PAGE-02" });
      expect(search.products[0]).toHaveProperty("stockUnit");
      expect(search.products[0]).toHaveProperty("cartonContains");
      expect(search.products[0]).toHaveProperty("totalPieces");
      expect(search.products[0]).toHaveProperty("warehouses");

      const product = toolData<{
        product: Record<string, unknown>;
        recentTransactions: Array<Record<string, unknown>>;
      }>(await callTool(token, "get_product", { sku: "PAGE-02" }));
      expect(product.product).toHaveProperty("openingStockPieces");
      expect(product.recentTransactions[0]).toHaveProperty("sourceApp");
      expect(product.recentTransactions[0]).toHaveProperty("previousTotalPieces");

      const warehouses = toolData<{ warehouses: unknown[] }>(
        await callTool(token, "list_warehouses"),
      );
      expect(warehouses.warehouses.length).toBeGreaterThanOrEqual(2);
      const low = toolData<{ thresholdPieces: number; products: unknown[] }>(
        await callTool(token, "low_stock", { threshold_pieces: 0 }),
      );
      expect(low.thresholdPieces).toBe(0);
      expect(low.products.length).toBeGreaterThanOrEqual(2);
      const history = toolData<{ transactions: Array<Record<string, unknown>> }>(
        await callTool(token, "list_transactions", { productId: legacyProductId }),
      );
      expect(history.transactions[0]).toMatchObject({ sourceApp: "unknown", previousTotalPieces: null });
      expect(toolData<{ totalProducts: number }>(await callTool(token, "catalogue_summary")).totalProducts).toBeGreaterThan(0);
      expect(toolData<{ totalCount: number }>(await callTool(token, "list_products", { limit: 1 })).totalCount).toBeGreaterThan(0);
    }
  });
});
