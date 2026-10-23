import { buildProtectedResourceMetadata } from "@/lib/mcp-metadata";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) — advertised in the
 * `WWW-Authenticate` header of every 401 from `/api/mcp`, so MCP clients know
 * which authorization server to use.
 */
export async function GET(req: Request) {
  const metadata = await buildProtectedResourceMetadata(req);
  return Response.json(metadata, {
    headers: { ...CORS_HEADERS, "cache-control": "public, max-age=300" },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
