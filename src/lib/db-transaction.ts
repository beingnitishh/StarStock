import type { db } from "@/db";

/** Shared Drizzle transaction handle used by atomic inventory write helpers. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
