import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerReadOnlyTools } from "@/lib/mcp-tools";
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
 * Only read-only tools are exposed (see `src/lib/mcp-tools.ts`).
 */
const mcpHandler = createMcpHandler(
  (server) => {
    registerReadOnlyTools(server);
  },
  {
    serverInfo: { name: "StarStock", version: "1.0.0" },
    instructions:
      "StarStock is an inventory system. These tools are read-only: use search_products and get_product to look up " +
      "products and stock levels per warehouse, low_stock to find items running out, list_warehouses for warehouse " +
      "ids, and list_transactions for stock movement history. Nothing here can change stock.",
  },
  {
    // The route lives at /api/[transport]; deriving endpoints from /api makes
    // the Streamable HTTP endpoint /api/mcp (/api/sse and /api/message are
    // disabled — SSE is deprecated in the current MCP spec).
    basePath: "/api",
    disableSse: true,
    maxDuration: 60,
    verboseLogs: false,
  },
);

const handler = withMcpAuth(
  mcpHandler,
  async (_req, bearerToken) => verifyAccessToken(bearerToken),
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
