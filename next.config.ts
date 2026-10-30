import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  outputFileTracingIncludes: { "/*": ["./agent-skills/**/*"] },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
