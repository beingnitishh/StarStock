import { createMcpHandler, getPublicOrigin, withMcpAuth } from "mcp-handler";
import { registerReadOnlyTools } from "@/lib/mcp-tools";
import { registerWriteTools } from "@/lib/mcp-write-tools";
import { OAUTH_SCOPE, verifyAccessToken } from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Remote MCP endpoint (Streamable HTTP).
 *
 *   https://<host>/api/mcp
 *
 * Clients must send `Authorization: Bearer <access token>` — tokens are only
 * issued through the StarStock OAuth flow (`/oauth/authorize` →
 * `/api/oauth/token`). Unauthenticated requests get a 401 whose
 * `WWW-Authenticate` header points at the protected-resource metadata, which
 * is what ChatGPT and Claude use to start the OAuth dance automatically.
 *
 * Read tools require starstock.read. Inventory writes additionally require the
 * opt-in starstock.write scope and a freshly verified inventory-writing user.
 */
const mcpHandler = createMcpHandler(
  (server) => {
    registerReadOnlyTools(server);
    registerWriteTools(server);
  },
  {
    serverInfo: { name: "StarStock", version: "1.0.0" },
    instructions:
      "StarStock is an inventory system. Use list_products for paginated catalogue browsing, search_products/get_product " +
      "for lookups, catalogue_summary for totals, low_stock for threshold searches, list_warehouses for warehouse ids, " +
      "and list_transactions for history. add_product, inbound_stock, and outbound_stock change inventory only when the " +
      "user has approved starstock.write and their current account role permits writes. For safe retries, provide client_request_id; " +
      "the same authenticated user's key returns the original result without another change for 24 hours. Never retry a failed write blindly.",
    // The endpoint has always been stateless, with no long-lived SSE streams.
    maxSubscriptions: 0,
  },
);

const handler = withMcpAuth(
  (req) => {
    // The handler no longer routes by pathname. Keep the existing /api/mcp
    // endpoint and leave the legacy /api/sse and /api/message paths disabled.
    if (new URL(req.url).pathname !== "/api/mcp") {
      return new Response("Not found", { status: 404 });
    }
    return mcpHandler(req);
  },
  async (req, bearerToken) => {
    const verified = await verifyAccessToken(bearerToken);
    if (!verified) return undefined;
    return {
      ...verified,
      // MCP tool callbacks do not receive the HTTP Request directly. Attach
      // the trusted proxy-aware public origin to this request's auth context
      // so URL-producing tools can return links for the current deployment.
      extra: { ...verified.extra, publicOrigin: getPublicOrigin(req) },
    };
  },
  {
    required: true,
    requiredScopes: [OAUTH_SCOPE],
    // 401 responses advertise this URL in WWW-Authenticate so clients can
    // discover the authorization server.
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
  },
);

type Ctx = { params: Promise<{ transport: string }> };

/**
 * The MCP Streamable HTTP transport allows GET (server-initiated SSE stream)
 * and DELETE (session termination) as optional extras. StarStock runs a
 * stateless server with no long-lived sessions, so both answer 405 with an
 * `Allow: POST` header — the response the spec prescribes when a server does
 * not offer them. Authentication runs first, so an unauthenticated GET/DELETE
 * still gets the 401 + `WWW-Authenticate` that starts the OAuth flow.
 */
async function stateless(req: Request): Promise<Response> {
  const res = await handler(req);
  if (res.status !== 405) return res;
  const headers = new Headers(res.headers);
  headers.set("allow", "POST");
  return new Response(res.body, { status: 405, headers });
}

export async function GET(req: Request, _ctx: Ctx) {
  return stateless(req);
}

export async function POST(req: Request, _ctx: Ctx) {
  return handler(req);
}

export async function DELETE(req: Request, _ctx: Ctx) {
  return stateless(req);
}
