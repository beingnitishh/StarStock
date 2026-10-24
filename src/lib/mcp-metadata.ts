import { getPublicOrigin, protectedResourceHandler } from "mcp-handler";
import { OAUTH_SCOPES } from "./oauth";

/**
 * RFC 9728 protected-resource metadata for the MCP endpoint.
 *
 * Built from the request origin (respecting proxy headers) so the same code
 * works on localhost, Vercel previews and production. Served both at
 * `/.well-known/oauth-protected-resource` (the URL advertised in the 401
 * `WWW-Authenticate` header) and at its path-suffixed form
 * `/.well-known/oauth-protected-resource/api/mcp`, which some clients probe.
 */
export async function buildProtectedResourceMetadata(
  req: Request,
): Promise<Record<string, unknown>> {
  const origin = getPublicOrigin(req);
  const respond = protectedResourceHandler({
    authServerUrls: [origin],
    resourceUrl: `${origin}/api/mcp`,
  });

  const base = (await respond(req).json()) as Record<string, unknown>;
  return {
    ...base,
    resource_name: "StarStock",
    scopes_supported: [...OAUTH_SCOPES],
    resource_documentation: origin,
  };
}
