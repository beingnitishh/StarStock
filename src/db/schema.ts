import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role", {
    // `member` is a read-only account: it can view stock but not change it.
    enum: ["admin", "stock_head", "stock_boy", "member"],
  })
    .notNull()
    .default("stock_boy"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  active: boolean("active").notNull().default(true),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const warehouses = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull().default(""),
  imageUrl: text("image_url").notNull().default(""),
  stockUnit: text("stock_unit", { enum: ["piece", "carton"] })
    .notNull()
    .default("piece"),
  cartonContains: integer("carton_contains").notNull().default(1),
  openingStockPieces: integer("opening_stock_pieces").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Uploaded product photos live in their own table so a listing request never
 * has to ship megabytes of base64. `products.imageUrl` points at
 * `/api/products/<id>/image?v=<timestamp>` for stored photos, or keeps an
 * external/site-relative link when the product was listed with a URL.
 */
export const productImages = pgTable("product_images", {
  productId: integer("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  mimeType: text("mime_type").notNull().default("image/jpeg"),
  /** Base64 payload (no data-URL prefix). */
  data: text("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const warehouseStock = pgTable(
  "warehouse_stock",
  {
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    qtyPieces: integer("qty_pieces").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.warehouseId] })],
);

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    type: text("type", {
      enum: ["inbound", "outbound", "transfer", "adjustment"],
    }).notNull(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    enteredQty: integer("entered_qty").notNull(),
    enteredUnit: text("entered_unit", { enum: ["piece", "carton"] }).notNull(),
    qtyPieces: integer("qty_pieces").notNull(),
    warehouseId: integer("warehouse_id").references(() => warehouses.id, {
      onDelete: "set null",
    }),
    toWarehouseId: integer("to_warehouse_id").references(() => warehouses.id, {
      onDelete: "set null",
    }),
    destination: text("destination"),
    reason: text("reason"),
    resultingTotalPieces: integer("resulting_total_pieces").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tx_product_created_idx").on(t.productId, t.createdAt),
    index("tx_created_idx").on(t.createdAt),
    index("tx_type_idx").on(t.type),
  ],
);

export const bulkUploads = pgTable("bulk_uploads", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  filename: text("filename").notNull().default(""),
  totalRows: integer("total_rows").notNull().default(0),
  createdCount: integer("created_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  errors: jsonb("errors").notNull().default("[]"),
  summary: jsonb("summary").notNull().default("{}"),
});

export type User = typeof users.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Warehouse = typeof warehouses.$inferSelect;
export type WarehouseStockRow = typeof warehouseStock.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type BulkUpload = typeof bulkUploads.$inferSelect;
