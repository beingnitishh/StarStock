-- StarStock MCP inventory audit and idempotency metadata.
--
-- Additive, backward-compatible, and safe to run more than once:
--   * Existing transaction rows receive NULL in every new column.
--   * Existing inserts may omit all new columns during a rolling deployment.
--   * Read code maps a NULL source_app to "unknown".
--   * No existing table, index, row, or transaction is rewritten or removed.
--
-- The application applies these same statements lazily on first relevant use,
-- so running drizzle-kit separately is optional, not a deployment prerequisite.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source_app text;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS previous_total_pieces integer;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS client_request_id text;

CREATE TABLE IF NOT EXISTS mcp_write_requests (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_request_id)
);

COMMENT ON COLUMN transactions.source_app IS
  'Origin of a new inventory change: chatgpt, claude, web, or unknown. NULL is historical/unknown.';

COMMENT ON COLUMN transactions.previous_total_pieces IS
  'Total stock across warehouses immediately before this movement; NULL for historical records.';

COMMENT ON COLUMN transactions.client_request_id IS
  'Optional MCP client idempotency key; repeated keys are scoped to one user for 24 hours.';

COMMENT ON TABLE mcp_write_requests IS
  'Committed MCP responses used to replay a client_request_id for one user within 24 hours.';
