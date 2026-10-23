import { buildProtectedResourceMetadata } from "@/lib/mcp-metadata";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

/**
 * Path-suffixed variant of the protected-resource metadata
 * (`/.well-known/oauth-protected-resource/api/mcp`), which RFC 9728 defines for
 * resources that live below the root. Some MCP clients probe this form.
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
