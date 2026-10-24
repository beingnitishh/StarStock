import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpWriteRequests } from "@/db/schema";
import { HttpError } from "./api";
import type { DbTransaction } from "./db-transaction";
import { ensureMcpInventorySchema } from "./mcp-schema";

export const MCP_CLIENT_REQUEST_ID_MAX_LENGTH = 200;
export const MCP_REQUEST_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeRequestId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "client_request_id must be a string.");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MCP_CLIENT_REQUEST_ID_MAX_LENGTH) {
    throw new HttpError(
      400,
      `client_request_id must contain 1–${MCP_CLIENT_REQUEST_ID_MAX_LENGTH} characters.`,
    );
  }
  return normalized;
}

function storedResult(value: unknown): CallToolResult {
  if (!value || typeof value !== "object" || !Array.isArray((value as CallToolResult).content)) {
    // Never treat an incomplete reservation as permission to repeat a write.
    throw new Error("Stored MCP idempotency response is incomplete.");
  }
  return value as CallToolResult;
}

/**
 * Runs one MCP write in a transaction. With a retry key, the key reservation,
 * inventory mutation, audit row, and original response are committed together.
 * Concurrent duplicates wait on the primary key and then replay that response.
 */
export async function runMcpWriteWithIdempotency(
  userId: number,
  clientRequestId: string | undefined,
  operation: (tx: DbTransaction) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const requestId = normalizeRequestId(clientRequestId);
  await ensureMcpInventorySchema();

  return db.transaction(async (tx) => {
    if (requestId) {
      const inserted = await tx
        .insert(mcpWriteRequests)
        .values({ userId, clientRequestId: requestId })
        .onConflictDoNothing()
        .returning({ clientRequestId: mcpWriteRequests.clientRequestId });

      if (inserted.length === 0) {
        const [existing] = await tx
          .select()
          .from(mcpWriteRequests)
          .where(
            and(
              eq(mcpWriteRequests.userId, userId),
              eq(mcpWriteRequests.clientRequestId, requestId),
            ),
          )
          .for("update");
        if (!existing) throw new Error("MCP idempotency reservation disappeared.");

        const cutoff = Date.now() - MCP_REQUEST_REPLAY_WINDOW_MS;
        if (existing.createdAt.getTime() >= cutoff) {
          return storedResult(existing.response);
        }

        // A key becomes reusable only after 24 hours. The row lock serializes
        // simultaneous attempts to reuse the same expired key.
        await tx
          .delete(mcpWriteRequests)
          .where(
            and(
              eq(mcpWriteRequests.userId, userId),
              eq(mcpWriteRequests.clientRequestId, requestId),
            ),
          );
        await tx
          .insert(mcpWriteRequests)
          .values({ userId, clientRequestId: requestId });
      }
    }

    const result = await operation(tx);

    if (requestId) {
      const saved = await tx
        .update(mcpWriteRequests)
        .set({ response: result })
        .where(
          and(
            eq(mcpWriteRequests.userId, userId),
            eq(mcpWriteRequests.clientRequestId, requestId),
          ),
        )
        .returning({ clientRequestId: mcpWriteRequests.clientRequestId });
      if (saved.length !== 1) {
        throw new Error("MCP idempotency response could not be saved.");
      }
    }

    // db.transaction resolves only after commit, so neither a new result nor a
    // replayable response can be reported before the inventory change is durable.
    return result;
  });
}
