import { getPublicOrigin } from "mcp-handler";
import { OAUTH_SCOPES } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

/**
 * OAuth 2.1 Authorization Server Metadata (RFC 8414).
 *
 * StarStock is its own authorization server: staff sign in on the StarStock
 * login page, and MCP clients receive a token scoped to read-only stock data.
 * Every URL is derived from the request origin so preview deployments work.
 */
export async function GET(req: Request) {
  const origin = getPublicOrigin(req);
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      scopes_supported: [...OAUTH_SCOPES],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      service_documentation: origin,
    },
    {
      headers: {
        ...CORS_HEADERS,
        "cache-control": "public, max-age=300",
      },
    },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
