import {
  issueTokens,
  OAuthError,
  redeemAuthorizationCode,
  rotateRefreshToken,
} from "@/lib/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

type TokenRequest = Record<string, string>;

/**
 * Token endpoint: `authorization_code` and `refresh_token` grants.
 *
 * Codes and tokens are opaque random strings; only their SHA-256 hashes are
 * stored. PKCE (S256) is mandatory for the code exchange, refresh tokens are
 * rotated on every use, and a deactivated account can no longer exchange.
 */
async function readParams(req: Request): Promise<TokenRequest> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new OAuthError("invalid_request", "Request body must be valid JSON.");
    }
    const params: TokenRequest = {};
    if (body && typeof body === "object") {
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (typeof value === "string") params[key] = value;
      }
    }
    return params;
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new OAuthError("invalid_request", "Send the parameters as a form body.");
  }
  const params: TokenRequest = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

function requireParam(params: TokenRequest, name: string): string {
  const value = params[name];
  if (!value) {
    throw new OAuthError("invalid_request", `"${name}" is required.`);
  }
  return value;
}

export async function POST(req: Request) {
  try {
    const params = await readParams(req);
    const grantType = requireParam(params, "grant_type");
    const clientId = requireParam(params, "client_id");

    let tokens;
    if (grantType === "authorization_code") {
      const code = requireParam(params, "code");
      const redirectUri = requireParam(params, "redirect_uri");
      const codeVerifier = requireParam(params, "code_verifier");

      const { userId, scope } = await redeemAuthorizationCode({
        code,
        clientId,
        redirectUri,
        codeVerifier,
      });
      tokens = await issueTokens(clientId, userId, scope);
    } else if (grantType === "refresh_token") {
      const refreshToken = requireParam(params, "refresh_token");
      tokens = await rotateRefreshToken(refreshToken, clientId);
    } else {
      throw new OAuthError(
        "unsupported_grant_type",
        "Only authorization_code and refresh_token are supported.",
      );
    }

    return Response.json(tokens, {
      headers: {
        ...CORS_HEADERS,
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    });
  } catch (e) {
    if (e instanceof OAuthError) {
      return Response.json(e.toJSON(), {
        status: e.status,
        headers: {
          ...CORS_HEADERS,
          "cache-control": "no-store",
          pragma: "no-cache",
        },
      });
    }
    console.error("[oauth] token endpoint failed", e);
    return Response.json(
      { error: "server_error", error_description: "Unexpected server error." },
      { status: 500, headers: { ...CORS_HEADERS, "cache-control": "no-store" } },
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
