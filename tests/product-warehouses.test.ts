import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { Role } from "@/lib/roles";
import { MAX_STOCK_PIECES } from "@/lib/units";

let activeCookieToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ss_session" && activeCookieToken
        ? { name: "ss_session", value: activeCookieToken }
        : undefined,
    set: () => {},
  }),
}));

let embedded: EmbeddedPostgres;
let control: Client;
let db: typeof import("@/db").db;
let pool: typeof import("@/db").pool;
let schema: typeof import("@/db/schema");
let productsRoute: typeof import("@/app/api/products/route");
let productDetailRoute: typeof import("@/app/api/products/[id]/route");
let productWarehousesRoute: typeof import("@/app/api/products/[id]/warehouses/route");
let bulkRoute: typeof import("@/app/api/products/bulk/route");
let warehouseDetailRoute: typeof import("@/app/api/warehouses/[id]/route");
let operationsRoute: typeof import("@/app/api/operations/route");
let writeTools: typeof import("@/lib/mcp-write-tools");
let oauth: typeof import("@/lib/oauth");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No test port available.");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

beforeAll(async () => {
  const dataDirectory = path.join(
    tmpdir(),
    `starstock-prod-wh-test-${process.pid}-${randomUUID().slice(0, 8)}`,
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
  await embedded.createDatabase("starstock_wh_test");

  const connectionString = `postgresql://postgres:test-only-password@127.0.0.1:${port}/starstock_wh_test`;
  process.env.DATABASE_URL = connectionString;

  control = new Client({ connectionString });
  await control.connect();
  const baseSchema = await readFile(
    path.join(process.cwd(), "tests/fixtures/pre-migration-schema.sql"),
    "utf8",
  );
  await control.query(baseSchema);
  await control.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY,
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS bulk_uploads (
      id serial PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by integer REFERENCES users(id) ON DELETE SET NULL,
      filename text NOT NULL DEFAULT '',
      total_rows integer NOT NULL DEFAULT 0,
      created_count integer NOT NULL DEFAULT 0,
      failed_count integer NOT NULL DEFAULT 0,
      errors jsonb NOT NULL DEFAULT '[]'::jsonb,
      summary jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  const dbModule = await import("@/db");
  db = dbModule.db;
  pool = dbModule.pool;
  schema = await import("@/db/schema");
  productsRoute = await import("@/app/api/products/route");
  productDetailRoute = await import("@/app/api/products/[id]/route");
  productWarehousesRoute = await import(
    "@/app/api/products/[id]/warehouses/route"
  );
  bulkRoute = await import("@/app/api/products/bulk/route");
  warehouseDetailRoute = await import("@/app/api/warehouses/[id]/route");
  operationsRoute = await import("@/app/api/operations/route");
  writeTools = await import("@/lib/mcp-write-tools");
  oauth = await import("@/lib/oauth");
});

afterAll(async () => {
  activeCookieToken = undefined;
  if (pool) await pool.end();
  if (control) await control.end();
  if (embedded) await embedded.stop();
});

async function createUserWithSession(role: Role = "admin") {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await db
    .insert(schema.users)
    .values({
      username: `user-${role}-${suffix}`,
      displayName: `User ${role} ${suffix}`,
      passwordHash: "unused",
      role,
    })
    .returning();
  const token = randomBytes(24).toString("hex");
  await db.insert(schema.sessions).values({
    token,
    userId: user.id,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { user, token };
}

async function createWarehouse(label: string) {
  const [wh] = await db
    .insert(schema.warehouses)
    .values({ name: `${label} ${randomUUID().slice(0, 6)}` })
    .returning();
  return wh;
}

describe("Single-warehouse product listing & Add product to another warehouse", () => {
  test("single product listing, bulk upload, and MCP add_product work with a single warehouse", async () => {
    const { user, token } = await createUserWithSession("admin");
    activeCookieToken = token;

    const whA = await createWarehouse("Surat Hub");
    const whB = await createWarehouse("Mumbai Hub");

    // 1. Single product listing via POST /api/products
    const createRes = await productsRoute.POST(
      new Request("http://starstock.test/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sku: "SINGLE-WEB-01",
          name: "Single Warehouse Web Item",
          imageUrl: "",
          stockUnit: "piece",
          cartonContains: 1,
          openingQty: 12,
          warehouseId: whA.id,
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const createdBody = (await createRes.json()) as { productId: number };

    // Confirm PR #21's multi-select warehouseIds payload is no longer accepted without warehouseId
    const rejectedMulti = await productsRoute.POST(
      new Request("http://starstock.test/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sku: "REJECT-MULTI-01",
          name: "Should Reject",
          imageUrl: "",
          stockUnit: "piece",
          cartonContains: 1,
          openingQty: 5,
          warehouseIds: [whA.id, whB.id],
        }),
      }),
    );
    expect(rejectedMulti.status).toBe(400);

    const detailRes = await productDetailRoute.GET(
      new Request(`http://starstock.test/api/products/${createdBody.productId}`),
      { params: Promise.resolve({ id: String(createdBody.productId) }) },
    );
    expect(detailRes.status).toBe(200);
    const detailData = (await detailRes.json()) as {
      product: { totalPieces: number; stocks: Array<{ warehouseId: number; qtyPieces: number }> };
    };
    expect(detailData.product.totalPieces).toBe(12);
    expect(detailData.product.stocks).toEqual([
      expect.objectContaining({ warehouseId: whA.id, qtyPieces: 12 }),
    ]);

    // 2. Bulk CSV upload with a single warehouse
    const csv = [
      "SKU,Product Name,Image URL,Opening Stock,Unit,Carton Contains,Warehouse",
      `BULK-SINGLE-01,Bulk Single Item,,4,carton,6,${whB.name}`,
    ].join("\n");
    const form = new FormData();
    form.set("file", new File([csv], "products.csv", { type: "text/csv" }));
    const bulkRes = await bulkRoute.POST(
      new Request("http://starstock.test/api/products/bulk", {
        method: "POST",
        body: form,
      }),
    );
    expect(bulkRes.status).toBe(200);
    const bulkJson = (await bulkRes.json()) as { created: number; failed: number };
    expect(bulkJson).toMatchObject({ created: 1, failed: 0 });

    const [bulkProd] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.sku, "BULK-SINGLE-01"));
    expect(bulkProd?.openingStockPieces).toBe(24);
    const bulkStockRows = await db
      .select()
      .from(schema.warehouseStock)
      .where(eq(schema.warehouseStock.productId, bulkProd!.id));
    expect(bulkStockRows).toHaveLength(1);
    expect(bulkStockRows[0]).toMatchObject({ warehouseId: whB.id, qtyPieces: 24 });

    // 3. MCP add_product tool with a single warehouse
    const client = await oauth.registerOAuthClient({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    });
    const tokens = await oauth.issueTokens(
      client.clientId,
      user.id,
      "starstock.read starstock.write",
    );
    const authInfo = await oauth.verifyAccessToken(tokens.access_token);
    expect(authInfo).not.toBeNull();

    const mcpResult = await writeTools.addProductTool(
      {
        sku: "MCP-SINGLE-01",
        name: "MCP Single Warehouse Product",
        stockUnit: "piece",
        cartonContains: 1,
        openingQty: 7,
        warehouseId: whA.id,
      },
      authInfo!,
    );
    expect(mcpResult.isError).not.toBe(true);
    const [mcpProd] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.sku, "MCP-SINGLE-01"));
    expect(mcpProd?.openingStockPieces).toBe(7);
  });

  test("lists product in 1 warehouse, adds 2 more (0 and >0 opening stock), updates all views, and skips duplicates", async () => {
    const writer = await createUserWithSession("stock_boy");
    const member = await createUserWithSession("member");

    const wh1 = await createWarehouse("Warehouse One");
    const wh2 = await createWarehouse("Warehouse Two");
    const wh3 = await createWarehouse("Warehouse Three");

    // List product in wh1 only with 10 pcs
    activeCookieToken = writer.token;
    const createRes = await productsRoute.POST(
      new Request("http://starstock.test/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sku: "ADD-WH-01",
          name: "Expandable Product",
          imageUrl: "",
          stockUnit: "piece",
          cartonContains: 1,
          openingQty: 10,
          warehouseId: wh1.id,
        }),
      }),
    );
    expect(createRes.status).toBe(201);
    const { productId } = (await createRes.json()) as { productId: number };

    // Initial product state: listed only in wh1; wh2 and wh3 are unlisted; wh1 is NOT offered
    const beforeRes = await productDetailRoute.GET(
      new Request(`http://starstock.test/api/products/${productId}`),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    const beforeData = (await beforeRes.json()) as {
      product: { stocks: Array<{ warehouseId: number; qtyPieces: number }> };
    };
    const listedBefore = new Set(beforeData.product.stocks.map((s) => s.warehouseId));
    const offeredBefore = [wh1, wh2, wh3].filter((w) => !listedBefore.has(w.id));
    expect(offeredBefore.map((w) => w.id)).toEqual([wh2.id, wh3.id]);
    expect(offeredBefore.some((w) => w.id === wh1.id)).toBe(false);

    // Auth & role checks on POST /api/products/[id]/warehouses
    activeCookieToken = undefined;
    const unauthRes = await productWarehousesRoute.POST(
      new Request(`http://starstock.test/api/products/${productId}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warehouses: [{ warehouseId: wh2.id, openingStock: 0 }] }),
      }),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    expect(unauthRes.status).toBe(401);

    activeCookieToken = member.token;
    const forbiddenRes = await productWarehousesRoute.POST(
      new Request(`http://starstock.test/api/products/${productId}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warehouses: [{ warehouseId: wh2.id, openingStock: 0 }] }),
      }),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    expect(forbiddenRes.status).toBe(403);

    // Add wh2 (opening stock 0) and wh3 (opening stock 25) as writer
    activeCookieToken = writer.token;
    const addRes = await productWarehousesRoute.POST(
      new Request(`http://starstock.test/api/products/${productId}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warehouses: [
            { warehouseId: wh2.id, openingStock: 0 },
            { warehouseId: wh3.id, openingStock: 25 },
          ],
          unit: "piece",
        }),
      }),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    expect(addRes.status).toBe(200);
    const addJson = (await addRes.json()) as {
      ok: boolean;
      added: Array<{
        warehouseId: number;
        warehouseName: string;
        qtyPieces: number;
        transactionId: number | null;
      }>;
      skippedWarehouseIds: number[];
      resultingTotalPieces: number;
    };
    expect(addJson.ok).toBe(true);
    expect(addJson.resultingTotalPieces).toBe(35);
    expect(addJson.skippedWarehouseIds).toEqual([]);
    expect(addJson.added).toHaveLength(2);
    expect(addJson.added[0]).toMatchObject({
      warehouseId: wh2.id,
      qtyPieces: 0,
      transactionId: null,
    });
    expect(addJson.added[1]).toMatchObject({
      warehouseId: wh3.id,
      qtyPieces: 25,
    });
    expect(addJson.added[1].transactionId).toEqual(expect.any(Number));

    // Product detail now shows all 3 warehouses and accurate stock history
    const afterRes = await productDetailRoute.GET(
      new Request(`http://starstock.test/api/products/${productId}`),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    const afterData = (await afterRes.json()) as {
      product: {
        totalPieces: number;
        stocks: Array<{ warehouseId: number; warehouseName: string; qtyPieces: number }>;
      };
      history: Array<{
        type: string;
        qtyPieces: number;
        warehouseName: string | null;
        reason: string | null;
        previousTotalPieces: number | null;
        resultingTotalPieces: number;
      }>;
    };
    expect(afterData.product.totalPieces).toBe(35);
    expect(
      afterData.product.stocks
        .filter((s) => [wh1.id, wh2.id, wh3.id].includes(s.warehouseId))
        .map((s) => ({ warehouseId: s.warehouseId, qtyPieces: s.qtyPieces })),
    ).toEqual([
      { warehouseId: wh1.id, qtyPieces: 10 },
      { warehouseId: wh2.id, qtyPieces: 0 },
      { warehouseId: wh3.id, qtyPieces: 25 },
    ]);

    // Only 2 transactions exist: initial 10 in wh1 and opening 25 in wh3 (no 0-qty tx for wh2)
    expect(afterData.history).toHaveLength(2);
    expect(afterData.history[0]).toMatchObject({
      type: "inbound",
      qtyPieces: 25,
      warehouseName: wh3.name,
      reason: "Opening stock",
      previousTotalPieces: 10,
      resultingTotalPieces: 35,
    });

    // Both wh2 (0 qty) and wh3 (25 qty) detail pages now list this product
    for (const [wh, expectedQty] of [
      [wh2, 0],
      [wh3, 25],
    ] as const) {
      const whRes = await warehouseDetailRoute.GET(
        new Request(`http://starstock.test/api/warehouses/${wh.id}`),
        { params: Promise.resolve({ id: String(wh.id) }) },
      );
      expect(whRes.status).toBe(200);
      const whData = (await whRes.json()) as {
        items: Array<{ product: { id: number; sku: string }; qtyPieces: number }>;
      };
      const found = whData.items.find((it) => it.product.id === productId);
      expect(found).toBeDefined();
      expect(found?.qtyPieces).toBe(expectedQty);
    }

    // Inbound and adjustment operations now work in the newly added 0-qty warehouse (wh2)
    const inboundRes = await operationsRoute.POST(
      new Request("http://starstock.test/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "inbound",
          productId,
          qty: 5,
          unit: "piece",
          warehouseId: wh2.id,
          reason: "Restock wh2",
        }),
      }),
    );
    expect(inboundRes.status).toBe(200);

    const adjustRes = await operationsRoute.POST(
      new Request("http://starstock.test/api/operations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "adjustment",
          productId,
          qty: 8,
          unit: "piece",
          warehouseId: wh2.id,
          reason: "Cycle count wh2",
        }),
      }),
    );
    expect(adjustRes.status).toBe(200);

    // Trying to add an already-listed warehouse skips duplicates without creating duplicate rows or altering stock
    const dupRes = await productWarehousesRoute.POST(
      new Request(`http://starstock.test/api/products/${productId}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warehouses: [
            { warehouseId: wh1.id, openingStock: 500 },
            { warehouseId: wh2.id, openingStock: 0 },
          ],
        }),
      }),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    expect(dupRes.status).toBe(200);
    const dupJson = (await dupRes.json()) as {
      added: unknown[];
      skippedWarehouseIds: number[];
      resultingTotalPieces: number;
    };
    expect(dupJson.added).toEqual([]);
    expect(dupJson.skippedWarehouseIds).toEqual([wh1.id, wh2.id]);
    expect(dupJson.resultingTotalPieces).toBe(43); // 10 + 8 + 25 untouched
  });

  test("validates product/warehouses, deduplicates payload IDs, and rolls back atomically on error", async () => {
    const writer = await createUserWithSession("stock_head");
    activeCookieToken = writer.token;

    const whBase = await createWarehouse("Atomic Base");
    const whValid = await createWarehouse("Atomic Valid");
    const whSecond = await createWarehouse("Atomic Second");

    const createRes = await productsRoute.POST(
      new Request("http://starstock.test/api/products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sku: "ATOMIC-WH-01",
          name: "Atomic Test Product",
          imageUrl: "",
          stockUnit: "piece",
          cartonContains: 1,
          openingQty: 1,
          warehouseId: whBase.id,
        }),
      }),
    );
    const { productId } = (await createRes.json()) as { productId: number };

    // Missing product -> 404
    const missingProdRes = await productWarehousesRoute.POST(
      new Request("http://starstock.test/api/products/999999/warehouses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ warehouses: [{ warehouseId: whValid.id }] }),
      }),
      { params: Promise.resolve({ id: "999999" }) },
    );
    expect(missingProdRes.status).toBe(404);

    // Non-existent warehouse mixed with valid warehouse -> 400 and zero rows added
    const badWhRes = await productWarehousesRoute.POST(
      new Request(`http://starstock.test/api/products/${productId}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warehouses: [
            { warehouseId: whValid.id, openingStock: 5 },
            { warehouseId: 999999, openingStock: 0 },
          ],
        }),
      }),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    expect(badWhRes.status).toBe(400);

    // Quantity limit overflow on second warehouse rolls back the first warehouse's insert too
    const overflowRes = await productWarehousesRoute.POST(
      new Request(`http://starstock.test/api/products/${productId}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warehouses: [
            { warehouseId: whValid.id, openingStock: 10 },
            { warehouseId: whSecond.id, openingStock: MAX_STOCK_PIECES },
          ],
        }),
      }),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    expect(overflowRes.status).toBe(400);

    const rowsAfterRollback = await db
      .select()
      .from(schema.warehouseStock)
      .where(eq(schema.warehouseStock.productId, productId));
    expect(rowsAfterRollback).toHaveLength(1);
    expect(rowsAfterRollback[0]?.warehouseId).toBe(whBase.id);

    // Duplicate warehouseId inside the same request payload is deduplicated cleanly
    const dedupRes = await productWarehousesRoute.POST(
      new Request(`http://starstock.test/api/products/${productId}/warehouses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          warehouses: [
            { warehouseId: whValid.id, openingStock: 6 },
            { warehouseId: whValid.id, openingStock: 99 },
          ],
        }),
      }),
      { params: Promise.resolve({ id: String(productId) }) },
    );
    expect(dedupRes.status).toBe(200);
    const dedupJson = (await dedupRes.json()) as {
      added: Array<{ warehouseId: number; qtyPieces: number }>;
      skippedWarehouseIds: number[];
      resultingTotalPieces: number;
    };
    expect(dedupJson.added).toEqual([
      expect.objectContaining({ warehouseId: whValid.id, qtyPieces: 6 }),
    ]);
    expect(dedupJson.skippedWarehouseIds).toEqual([whValid.id]);
    expect(dedupJson.resultingTotalPieces).toBe(7);
  });
});
