import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Icon } from "@/components/icons";
import { getSessionUser } from "@/lib/auth";
import { buildRedirectUrl, parseAuthorizeQuery } from "@/lib/oauth-authorize";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Authorize app · Star Stock",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function deniedPage(message: string) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div className="rounded-xl border border-line bg-card p-6">
        <div className="flex items-start gap-2 text-out">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <h1 className="font-display text-lg font-bold tracking-tight">
            This authorization request can’t continue
          </h1>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">{message}</p>
        <p className="mt-4 text-xs text-ink-faint">
          Nothing was shared. You can close this window and try connecting the app again.
        </p>
      </div>
    </main>
  );
}

/**
 * OAuth consent screen.
 *
 * A client (ChatGPT, Claude, …) sends the user here after registering. If the
 * user is not signed in to StarStock we bounce them through the normal login
 * page and bring them straight back here with `?next=`.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const outcome = await parseAuthorizeQuery(params);

  if (outcome.kind === "fatal") return deniedPage(outcome.message);
  if (outcome.kind === "redirect-error") {
    // The redirect URI is already verified against the registration; report
    // the protocol error back to the client the OAuth way.
    redirect(
      buildRedirectUrl(outcome.redirectUri, {
        error: outcome.error,
        error_description: outcome.description,
        state: outcome.state,
      }),
    );
  }

  const user = await getSessionUser();
  if (!user) {
    // Only the path and query: a same-origin path, so `/login` can send the
    // user straight back to this consent screen.
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && first) query.set(key, first);
    }
    const here = `/oauth/authorize?${query.toString()}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  const { client, query } = outcome;

  const hidden: Record<string, string> = {
    client_id: query.clientId,
    redirect_uri: query.redirectUri,
    response_type: query.responseType,
    code_challenge: query.codeChallenge,
    code_challenge_method: query.codeChallengeMethod,
    scope: query.scope,
  };
  if (query.state) hidden.state = query.state;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-xl border border-line bg-card p-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-faint">
          Authorization request
        </p>
        <h1 className="mt-2 font-display text-xl font-bold leading-snug tracking-tight">
          {client.clientName} wants read access to StarStock as {user.displayName}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          It will be able to look up products, stock levels per warehouse and stock movement
          history. It cannot add, move, adjust or delete anything.
        </p>

        <div className="mt-4 space-y-1.5 rounded-lg bg-surface px-3.5 py-3 text-[12px] leading-relaxed text-ink-soft ring-1 ring-line">
          <p className="flex items-center gap-2">
            <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-in" />
            Read products, stock and transactions
          </p>
          <p className="flex items-center gap-2">
            <Icon name="x" className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
            No changes to stock, products, warehouses or users
          </p>
        </div>

        <form method="post" action="/api/oauth/authorize" className="mt-5 space-y-3">
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <button
            type="submit"
            name="decision"
            value="allow"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 py-2.5 text-[13px] font-semibold text-paper shadow-sm transition-colors hover:bg-brand-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Allow
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-card px-3.5 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:border-brand/50 hover:bg-brand-soft/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Deny
          </button>
        </form>

        <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
          Signed in as <span className="font-semibold text-ink-soft">{user.username}</span>. You
          can revoke this later by removing the app from your account.
        </p>
      </div>
    </main>
  );
}
