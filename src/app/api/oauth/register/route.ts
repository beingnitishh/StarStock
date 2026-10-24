import { errResponse, HttpError } from "@/lib/api";
import { getClientIp } from "@/lib/login-attempts";
import {
  isAcceptableRedirectUri,
  isRegistrationRateLimited,
  OAUTH_SCOPES,
  recordOAuthRegistration,
  registerOAuthClient,
  REGISTRATION_RATE_LIMIT_MESSAGE,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * ChatGPT and Claude register themselves here before starting the
 * authorization-code flow. StarStock only issues public clients (`none`
 * authentication) protected by PKCE, so no client secret is created or stored.
 *
 * Any https redirect URI is accepted at registration; the authorization
 * endpoint later requires an exact match against this list, which is what
 * keeps an attacker from redirecting someone else's code to themselves.
 *
 * Each IP may register at most 10 clients per hour.
 */
export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    if (await isRegistrationRateLimited(ip)) {
      throw new HttpError(429, REGISTRATION_RATE_LIMIT_MESSAGE);
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Request body must be valid JSON.");
    }

    const rawUris = body.redirect_uris;
    if (!Array.isArray(rawUris) || rawUris.length === 0) {
      throw new HttpError(400, "redirect_uris must be a non-empty array of URIs.");
    }
    const redirectUris: string[] = [];
    for (const value of rawUris) {
      const uri = typeof value === "string" ? value.trim() : "";
      if (!uri || !isAcceptableRedirectUri(uri)) {
        throw new HttpError(
          400,
          `"${String(value)}" is not an acceptable redirect URI. Use an https URL (http is allowed only for localhost).`,
        );
      }
      if (!redirectUris.includes(uri)) redirectUris.push(uri);
    }

    const clientName =
      typeof body.client_name === "string" && body.client_name.trim()
        ? body.client_name.trim()
        : "MCP client";

    const client = await registerOAuthClient({
      clientName,
      redirectUris,
      grantTypes: ["authorization_code", "refresh_token"],
    });
    await recordOAuthRegistration(ip);

    return Response.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: OAUTH_SCOPES.join(" "),
      },
      {
        status: 201,
        headers: { ...CORS_HEADERS, "cache-control": "no-store" },
      },
    );
  } catch (e) {
    const res = errResponse(e);
    res.headers.set("access-control-allow-origin", "*");
    return res;
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
