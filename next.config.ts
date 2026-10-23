import type { NextConfig } from "next";

/**
 * The sign-in and OAuth consent pages must never be framed by another site:
 * clickjacking them would let an attacker trick a signed-in user into
 * approving access to their stock data.
 */
const noFramingHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/oauth/:path*", headers: noFramingHeaders },
      { source: "/login", headers: noFramingHeaders },
    ];
  },
};

export default nextConfig;
