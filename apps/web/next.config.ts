import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@verder/api", "@verder/auth", "@verder/db", "@verder/core"],
};

export default nextConfig;
