/* Seed script: creates demo users, warehouses, products and transaction history. */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "./index";
import { transactions, users, warehouses } from "./schema";
import { hashPassword } from "@/lib/auth";
import { registerProduct } from "@/lib/products";
import { performOperation } from "@/lib/stock";

async function main() {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) {
    console.log("Seed skipped: data already present.");
    return;
  }

  const [admin] = await db
    .insert(users)
    .values([
      {
        username: "admin",
        displayName: "Ava Sinclair",
        passwordHash: hashPassword("admin123"),
        role: "admin",
      },
      {
        username: "stockhead",
        displayName: "Noor Haddad",
        passwordHash: hashPassword("stock123"),
        role: "stock_head",
      },
      {
        username: "stockboy",
        displayName: "Marco Reyes",
        passwordHash: hashPassword("stock123"),
        role: "stock_boy",
      },
      {
        username: "member",
        displayName: "Priya Nair",
        passwordHash: hashPassword("member123"),
        role: "member",
      },
    ])
    .returning();

  const [wh1] = await db
    .insert(warehouses)
    .values([
      { name: "Main Warehouse", createdBy: admin.id },
      { name: "East Depot", createdBy: admin.id },
    ])
    .returning();
  const [wh2] = await db
    .select()
    .from(warehouses)
    .where(sql`${warehouses.name} = 'East Depot'`)
    .limit(1);

  const head = (await db.select().from(users).where(sql`${users.username} = 'stockhead'`))[0];
  const boy = (await db.select().from(users).where(sql`${users.username} = 'stockboy'`))[0];

  const products = [
    { sku: "ALM-1L0", name: "Almond Milk 1L", imageUrl: "/products/almond-milk.jpg", stockUnit: "carton" as const, cartonContains: 12, openingQty: 8 },
    { sku: "CFE-250", name: "Ground Coffee 250g", imageUrl: "/products/coffee.jpg", stockUnit: "piece" as const, cartonContains: 12, openingQty: 60 },
    { sku: "OLV-500", name: "Olive Oil 500ml", imageUrl: "/products/olive-oil.jpg", stockUnit: "carton" as const, cartonContains: 6, openingQty: 5 },
    { sku: "PST-400", name: "Penne Pasta 400g", imageUrl: "/products/pasta.jpg", stockUnit: "carton" as const, cartonContains: 24, openingQty: 3 },
    { sku: "RCE-5KG", name: "Basmati Rice 5kg", imageUrl: "/products/rice.jpg", stockUnit: "piece" as const, cartonContains: 4, openingQty: 20 },
    { sku: "TEA-100", name: "Black Tea 100 Bags", imageUrl: "/products/tea.jpg", stockUnit: "carton" as const, cartonContains: 12, openingQty: 2 },
  ];

  const bySku = new Map<string, number>();
  for (const p of products) {
    const created = await registerProduct(
      { ...p, warehouseId: wh1.id },
      admin.id,
    );
    bySku.set(p.sku, created.id);
  }

  const op = (args: Parameters<typeof performOperation>[0]) => performOperation(args);

  // ALM-1L0: Main 96 -> +48 inbound, -30 outbound, transfer 24 to East
  await op({ type: "inbound", productId: bySku.get("ALM-1L0")!, qty: 4, unit: "carton", warehouseId: wh1.id, toWarehouseId: null, destination: null, reason: "Supplier delivery PO-2291", userId: head.id });
  await op({ type: "outbound", productId: bySku.get("ALM-1L0")!, qty: 30, unit: "piece", warehouseId: wh1.id, toWarehouseId: null, destination: "Sold to Customer", reason: null, userId: boy.id });
  await op({ type: "transfer", productId: bySku.get("ALM-1L0")!, qty: 2, unit: "carton", warehouseId: wh1.id, toWarehouseId: wh2.id, destination: null, reason: "Rebalance for east orders", userId: head.id });

  // CFE-250: Main 60 -> -24 outbound, adjustment to 30
  await op({ type: "outbound", productId: bySku.get("CFE-250")!, qty: 2, unit: "carton", warehouseId: wh1.id, toWarehouseId: null, destination: "Sold to Customer", reason: null, userId: boy.id });
  await op({ type: "adjustment", productId: bySku.get("CFE-250")!, qty: 30, unit: "piece", warehouseId: wh1.id, toWarehouseId: null, destination: null, reason: "Cycle count correction", userId: head.id });

  // OLV-500: Main 30 -> +12 inbound East, -12 outbound Main
  await op({ type: "inbound", productId: bySku.get("OLV-500")!, qty: 12, unit: "piece", warehouseId: wh2.id, toWarehouseId: null, destination: null, reason: "New harvest batch", userId: admin.id });
  await op({ type: "outbound", productId: bySku.get("OLV-500")!, qty: 2, unit: "carton", warehouseId: wh1.id, toWarehouseId: null, destination: "Sold to Customer", reason: null, userId: boy.id });

  // PST-400: Main 72 -> -20 outbound, +48 inbound
  await op({ type: "outbound", productId: bySku.get("PST-400")!, qty: 20, unit: "piece", warehouseId: wh1.id, toWarehouseId: null, destination: "Sold to Customer", reason: "Wholesale order #88", userId: boy.id });
  await op({ type: "inbound", productId: bySku.get("PST-400")!, qty: 2, unit: "carton", warehouseId: wh1.id, toWarehouseId: null, destination: null, reason: null, userId: head.id });

  // RCE-5KG: Main 20 -> transfer 6 to East, outbound 4 from East
  await op({ type: "transfer", productId: bySku.get("RCE-5KG")!, qty: 6, unit: "piece", warehouseId: wh1.id, toWarehouseId: wh2.id, destination: null, reason: null, userId: head.id });
  await op({ type: "outbound", productId: bySku.get("RCE-5KG")!, qty: 4, unit: "piece", warehouseId: wh2.id, toWarehouseId: null, destination: "Sold to Customer", reason: null, userId: boy.id });

  // TEA-100: Main 24 -> outbound 21 (low stock)
  await op({ type: "outbound", productId: bySku.get("TEA-100")!, qty: 21, unit: "piece", warehouseId: wh1.id, toWarehouseId: null, destination: "Sold to Customer", reason: null, userId: boy.id });

  // Spread transaction history across the past two weeks; opening stock goes further back.
  await db.execute(sql`
    UPDATE transactions
    SET created_at = now() - (random() * interval '13 days') - interval '4 hours'
    WHERE reason IS DISTINCT FROM 'Opening stock'
  `);
  await db.execute(sql`
    UPDATE transactions
    SET created_at = now() - interval '20 days' - (random() * interval '2 days')
    WHERE reason = 'Opening stock'
  `);

  console.log("Seed complete.");
  console.log(
    "Logins: admin/admin123, stockhead/stock123, stockboy/stock123, member/member123 (read-only)",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
