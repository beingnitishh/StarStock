import {
  clientSupportsWriteScope,
  getOAuthClient,
  OAUTH_WRITE_SCOPE,
  scopeForOAuthClient,
  type OAuthClientRecord,
} from "./oauth";

/**
 * Validation shared by the consent page (`GET /oauth/authorize`) and the
 * decision endpoint (`POST /api/oauth/authorize`).
 *
 * The client and the redirect URI are validated first — before anything is
 * redirected — because an unverified redirect URI would let an attacker
 * receive another user's authorization code. Later failures are safe to report
 * back to the client through `redirect_uri` as OAuth error parameters.
 */

export type AuthorizeQuery = {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  responseType: string;
  /** Original request flags let consent explain why write was withheld. */
  writeRequested: boolean;
  writeEligible: boolean;
};

export type AuthorizeOutcome =
  | { kind: "ok"; client: OAuthClientRecord; query: AuthorizeQuery }
  /** Bad client or redirect_uri: render an error, never redirect. */
  | { kind: "fatal"; message: string }
  /** Safe to redirect back with `error=...` (redirect_uri already trusted). */
  | {
      kind: "redirect-error";
      redirectUri: string;
      state?: string;
      error: string;
      description: string;
    };

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Read access remains the default. Write scope is granted only when the
 * client explicitly requests it; unknown scopes are always dropped.
 */
export function grantedScope(requested: string, redirectUris?: unknown): string {
  return scopeForOAuthClient(requested, redirectUris);
}

export async function parseAuthorizeQuery(
  input: Record<string, string | string[] | undefined>,
): Promise<AuthorizeOutcome> {
  const clientId = firstValue(input.client_id).trim();
  const redirectUri = firstValue(input.redirect_uri).trim();
  const state = firstValue(input.state) || undefined;
  const responseType = firstValue(input.response_type).trim() || "code";
  const codeChallenge = firstValue(input.code_challenge).trim();
  const codeChallengeMethod = firstValue(input.code_challenge_method).trim() || "S256";
  const scope = firstValue(input.scope);

  if (!clientId) {
    return { kind: "fatal", message: "This authorization link is missing its client_id." };
  }
  const client = await getOAuthClient(clientId);
  if (!client) {
    return {
      kind: "fatal",
      message:
        "This app is not registered with StarStock. Ask the app to register again, then retry.",
    };
  }
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return {
      kind: "fatal",
      message:
        "This authorization request used a redirect URI that does not match the one registered for the app.",
    };
  }

  if (responseType !== "code") {
    return {
      kind: "redirect-error",
      redirectUri,
      state,
      error: "unsupported_response_type",
      description: "Only the authorization code flow is supported.",
    };
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return {
      kind: "redirect-error",
      redirectUri,
      state,
      error: "invalid_request",
      description: "PKCE with the S256 method is required.",
    };
  }

  const writeRequested = scope.split(/\s+/).includes(OAUTH_WRITE_SCOPE);
  const writeEligible = clientSupportsWriteScope(client.redirectUris);

  return {
    kind: "ok",
    client,
    query: {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      scope: grantedScope(scope, client.redirectUris),
      responseType,
      writeRequested,
      writeEligible,
    },
  };
}

/** Builds `<redirect_uri>?code=...&state=...` (or an `error=` URL). */
export function buildRedirectUrl(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
