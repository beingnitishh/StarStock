/**
 * Accepts only same-origin, path-style redirect targets such as
 * `/oauth/authorize?client_id=...` — never `https://evil.example` or
 * `//evil.example`, so `?next=` cannot be used as an open redirect.
 */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  // Reject control characters (header/CRLF smuggling) outright.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;

  try {
    const base = "https://starstock.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
