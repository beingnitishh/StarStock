import { getSessionUser } from "@/lib/auth";
import {
  buildRedirectUrl,
  parseAuthorizeQuery,
  type AuthorizeQuery,
} from "@/lib/oauth-authorize";
import { createAuthorizationCode, OAUTH_SCOPE } from "@/lib/oauth";
import { canWriteStock } from "@/lib/roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Handles the Allow / Deny buttons on the consent screen.
 *
 * On Allow a single-use, 10-minute authorization code is issued and the user
 * is sent back to the client with `code` and the original `state`. On Deny the
 * client gets `error=access_denied`, which is also an OAuth-defined redirect.
 */
function htmlError(message: string, status = 400): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorization failed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#1c1c1a">
<h1 style="font-size:1.15rem">This authorization request can’t continue</h1>
<p style="line-height:1.6;color:#5a5a52">${message}</p>
<p style="line-height:1.6;color:#8a8a80;font-size:.8rem">Nothing was shared. You can close this window and try connecting the app again.</p>
</body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function redirectTo(url: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: url, "cache-control": "no-store" },
  });
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return htmlError("The request body could not be read.");
  }

  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  const outcome = await parseAuthorizeQuery(params);
  if (outcome.kind === "fatal") return htmlError(outcome.message);
  if (outcome.kind === "redirect-error") {
    return redirectTo(
      buildRedirectUrl(outcome.redirectUri, {
        error: outcome.error,
        error_description: outcome.description,
        state: outcome.state,
      }),
    );
  }

  const user = await getSessionUser();
  if (!user) {
    return htmlError(
      "You are signed out. Sign in to StarStock and try connecting the app again.",
      401,
    );
  }

  const query: AuthorizeQuery = outcome.query;

  if (params.decision !== "allow") {
    return redirectTo(
      buildRedirectUrl(query.redirectUri, {
        error: "access_denied",
        error_description: "The user denied the request.",
        state: query.state,
      }),
    );
  }

  const code = await createAuthorizationCode({
    clientId: query.clientId,
    userId: user.id,
    redirectUri: query.redirectUri,
    codeChallenge: query.codeChallenge,
    codeChallengeMethod: query.codeChallengeMethod,
    // A Member may authorize a read connection even if a client requested
    // write scope. Account permissions remain authoritative at execution too.
    scope: canWriteStock(user.role) ? query.scope : OAUTH_SCOPE,
  });

  return redirectTo(
    buildRedirectUrl(query.redirectUri, { code, state: query.state }),
  );
}
