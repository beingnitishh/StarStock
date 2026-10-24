/**
 * Application that originated an inventory change.
 *
 * `unknown` is used for historical rows and for MCP clients whose platform
 * cannot be identified from server-held OAuth registration data. It is never
 * inferred from a prompt, request header, or tool argument.
 */
export type ApplicationSource = "chatgpt" | "claude" | "web" | "unknown";

export const APPLICATION_SOURCE_LABELS: Record<ApplicationSource, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  web: "StarStock web",
  unknown: "Unknown",
};

function isPlainHttpsUrl(url: URL, hostname: string): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === hostname &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash
  );
}

/**
 * ChatGPT's documented stable callback, or its per-connection callback.
 * See https://developers.openai.com/plugins/build/auth.
 */
function isChatGPTCallback(url: URL): boolean {
  if (!isPlainHttpsUrl(url, "chatgpt.com")) return false;
  return (
    url.pathname === "/connector_platform_oauth_redirect" ||
    /^\/connector\/oauth\/[^/]+$/.test(url.pathname)
  );
}

/** Hosted Claude's documented fixed MCP OAuth callback. */
function isClaudeCallback(url: URL): boolean {
  return (
    isPlainHttpsUrl(url, "claude.ai") && url.pathname === "/api/mcp/auth_callback"
  );
}

function sourceForCallback(value: string): "chatgpt" | "claude" | "unknown" {
  try {
    const url = new URL(value);
    if (isChatGPTCallback(url)) return "chatgpt";
    if (isClaudeCallback(url)) return "claude";
  } catch {
    // Invalid registration data cannot provide attribution.
  }
  return "unknown";
}

/**
 * Attributes an OAuth client only when every registered callback belongs to
 * one known hosted platform. Requiring the whole set prevents a client from
 * mixing a platform callback with an unrelated callback to borrow its label.
 *
 * Claude Code and other loopback clients deliberately remain `unknown`:
 * localhost callbacks do not establish which application initiated OAuth.
 */
export function sourceAppForRedirectUris(redirectUris: unknown): ApplicationSource {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) return "unknown";
  if (redirectUris.some((uri) => typeof uri !== "string" || !uri)) return "unknown";

  let source: ApplicationSource = "unknown";
  for (const uri of redirectUris) {
    const current = sourceForCallback(uri as string);
    if (current === "unknown") return "unknown";
    if (source !== "unknown" && source !== current) return "unknown";
    source = current;
  }
  return source;
}

/** Only server-generated values should be stored; anything else fails closed. */
export function normalizeApplicationSource(value: unknown): ApplicationSource {
  return value === "chatgpt" || value === "claude" || value === "web"
    ? value
    : "unknown";
}
