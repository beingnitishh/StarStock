import { getSessionUser, type SessionUser } from "./auth";
import { isReadOnlyRole } from "./roles";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  console.error("[api]", e);
  return Response.json({ error: "Unexpected server error" }, { status: 500 });
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Not authenticated. Please sign in.");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") {
    throw new HttpError(403, "Only Admin can access this feature.");
  }
  return user;
}

/**
 * Guards every endpoint that changes data. Member accounts are read-only and
 * are rejected here even if they call the API directly.
 */
export async function requireWriter(): Promise<SessionUser> {
  const user = await requireUser();
  if (isReadOnlyRole(user.role)) {
    throw new HttpError(
      403,
      "Your Member account is read-only. You can view stock but not make changes.",
    );
  }
  return user;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

export function parseUnit(value: unknown): "piece" | "carton" {
  const v = String(value ?? "").trim().toLowerCase();
  if (["piece", "pieces", "pcs", "pc"].includes(v)) return "piece";
  if (["carton", "cartons", "ctn", "ctns", "box", "boxes"].includes(v)) return "carton";
  throw new HttpError(400, `Unknown unit "${value}". Use "piece" or "carton".`);
}

export function parsePositiveInt(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, `${field} must be a whole number greater than zero.`);
  }
  return n;
}

export function parseNonNegativeInt(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new HttpError(400, `${field} must be a whole number (0 or more).`);
  }
  return n;
}
