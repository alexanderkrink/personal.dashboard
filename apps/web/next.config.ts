import type { NextConfig } from "next";
// Validate env vars at build time — a missing/invalid var fails the build.
import "./src/env";

const nextConfig: NextConfig = {
  typedRoutes: true,
  transpilePackages: ["@studyos/ai", "@studyos/core", "@studyos/db", "@studyos/ui"],
};

export default nextConfig;
