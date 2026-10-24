-- Minimal pre-change StarStock schema used only by the disposable test cluster.
-- It intentionally omits transactions.source_app and previous_total_pieces so
-- the real additive migration can be tested against the former shape.

CREATE TABLE users (
  id serial PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'stock_boy',
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz
);

CREATE TABLE warehouses (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id serial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  stock_unit text NOT NULL DEFAULT 'piece',
  carton_contains integer NOT NULL DEFAULT 1,
  opening_stock_pieces integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_stock (
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id integer NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  qty_pieces integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE TABLE transactions (
  id serial PRIMARY KEY,
  type text NOT NULL,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  entered_qty integer NOT NULL,
  entered_unit text NOT NULL,
  qty_pieces integer NOT NULL,
  warehouse_id integer REFERENCES warehouses(id) ON DELETE SET NULL,
  to_warehouse_id integer REFERENCES warehouses(id) ON DELETE SET NULL,
  destination text,
  reason text,
  resulting_total_pieces integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tx_product_created_idx ON transactions (product_id, created_at);
CREATE INDEX tx_created_idx ON transactions (created_at);
CREATE INDEX tx_type_idx ON transactions (type);

CREATE TABLE oauth_clients (
  id serial PRIMARY KEY,
  client_id text NOT NULL UNIQUE,
  client_name text NOT NULL DEFAULT '',
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  grant_types jsonb NOT NULL DEFAULT '["authorization_code", "refresh_token"]'::jsonb,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  scope text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  token_hash text PRIMARY KEY,
  kind text NOT NULL,
  client_id text NOT NULL,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_tokens_user_idx ON oauth_tokens (user_id);
CREATE INDEX oauth_tokens_client_idx ON oauth_tokens (client_id);
