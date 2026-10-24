import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Lazily applies the additive MCP inventory schema, mirroring OAuth's
 * first-use table bootstrap. Deploying application code does not require a
 * separate drizzle-kit step, and every statement is safe to run again.
 *
 * The DATABASE_URL role needs permission to alter `transactions` and create
 * tables in its schema. Historical rows receive NULL in the new columns.
 */
const MCP_INVENTORY_SCHEMA_SQL = [
  sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_app text`,
  sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS previous_total_pieces integer`,
  sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_request_id text`,
  sql`
    CREATE TABLE IF NOT EXISTS mcp_write_requests (
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_request_id text NOT NULL,
      response jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, client_request_id)
    )
  `,
  sql`
    COMMENT ON COLUMN transactions.source_app IS
      'Origin of a new inventory change: chatgpt, claude, web, or unknown. NULL is historical/unknown.'
  `,
  sql`
    COMMENT ON COLUMN transactions.previous_total_pieces IS
      'Total stock across warehouses immediately before this movement; NULL for historical records.'
  `,
  sql`
    COMMENT ON COLUMN transactions.client_request_id IS
      'Optional MCP client idempotency key; repeated keys are scoped to one user for 24 hours.'
  `,
  sql`
    COMMENT ON TABLE mcp_write_requests IS
      'Committed MCP responses used to replay a client_request_id for one user within 24 hours.'
  `,
];

const globalForMcpSchema = globalThis as typeof globalThis & {
  __starstockMcpInventorySchema?: Promise<void>;
};

export function ensureMcpInventorySchema(): Promise<void> {
  if (!globalForMcpSchema.__starstockMcpInventorySchema) {
    globalForMcpSchema.__starstockMcpInventorySchema = (async () => {
      for (const statement of MCP_INVENTORY_SCHEMA_SQL) {
        await db.execute(statement);
      }
    })().catch((error) => {
      // A later request can retry after a transient database/permission error.
      delete globalForMcpSchema.__starstockMcpInventorySchema;
      throw error;
    });
  }
  return globalForMcpSchema.__starstockMcpInventorySchema;
}
