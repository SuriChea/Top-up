import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    const apiUrl = process.env.API_INTERNAL_URL || "http://localhost:3001";
    return [
      { source: "/api/:path*", destination: `${apiUrl}/api/:path*` },
      { source: "/mock-pay/:path*", destination: "http://mock-pay:4001/:path*" }
    ];
  }
};

export default nextConfig;
