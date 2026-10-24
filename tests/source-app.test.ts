import { describe, expect, test } from "vitest";
import { normalizeApplicationSource, sourceAppForRedirectUris } from "@/lib/source-app";

describe("OAuth client source attribution", () => {
  test("recognizes documented hosted ChatGPT callbacks", () => {
    expect(
      sourceAppForRedirectUris(["https://chatgpt.com/connector_platform_oauth_redirect"]),
    ).toBe("chatgpt");
    expect(
      sourceAppForRedirectUris(["https://chatgpt.com/connector/oauth/callback_123"]),
    ).toBe("chatgpt");
  });

  test("recognizes the documented hosted Claude callback", () => {
    expect(sourceAppForRedirectUris(["https://claude.ai/api/mcp/auth_callback"])).toBe(
      "claude",
    );
  });

  test("fails closed for mixed, spoofed, loopback, or malformed registrations", () => {
    expect(
      sourceAppForRedirectUris([
        "https://claude.ai/api/mcp/auth_callback",
        "https://example.com/callback",
      ]),
    ).toBe("unknown");
    expect(sourceAppForRedirectUris(["https://chatgpt.com.evil.example/callback"])).toBe(
      "unknown",
    );
    expect(sourceAppForRedirectUris(["http://localhost:3000/callback"])).toBe("unknown");
    expect(sourceAppForRedirectUris(["not a URL"])).toBe("unknown");
    expect(sourceAppForRedirectUris([])).toBe("unknown");
  });

  test("does not accept an arbitrary source string", () => {
    expect(normalizeApplicationSource("chatgpt")).toBe("chatgpt");
    expect(normalizeApplicationSource("claude")).toBe("claude");
    expect(normalizeApplicationSource("web")).toBe("web");
    expect(normalizeApplicationSource("I am ChatGPT")).toBe("unknown");
    expect(normalizeApplicationSource(null)).toBe("unknown");
  });
});
