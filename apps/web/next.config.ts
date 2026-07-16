import type { NextConfig } from "next";
// Validate env vars at build time — a missing/invalid var fails the build.
import "./src/env";

const nextConfig: NextConfig = {
  typedRoutes: true,
  transpilePackages: ["@study/ai", "@study/core", "@study/db", "@study/ui"],
};

export default nextConfig;
