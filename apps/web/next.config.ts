import type { NextConfig } from "next";
// Validate env vars at build time — a missing/invalid var fails the build.
import "./src/env";

const nextConfig: NextConfig = {
  typedRoutes: true,
  transpilePackages: ["@study/ai", "@study/core", "@study/db", "@study/ui"],
  experimental: {
    // Phosphor's barrel export is a known dev/bundle cost; rewrite to per-icon
    // module imports. Always pair with per-icon named imports at call sites.
    optimizePackageImports: ["@phosphor-icons/react"],
  },
};

export default nextConfig;
