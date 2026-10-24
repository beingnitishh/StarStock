import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A tool result with a human summary first, then machine-readable JSON. */
export function jsonResult(summary: string, data: unknown): CallToolResult {
  return {
    content: [
      { type: "text", text: summary },
      { type: "text", text: JSON.stringify(data, null, 2) },
    ],
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
