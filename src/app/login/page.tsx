import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/redirects";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  // Only same-origin paths are honoured, so ?next= can never bounce a user
  // to another site. The OAuth consent screen uses this to come back.
  const next = safeNextPath(rawNext);

  const user = await getSessionUser();
  if (user) redirect(next ?? "/dashboard");
  return <LoginForm next={next} />;
}
