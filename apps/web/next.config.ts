import type { NextConfig } from "next";
import { MAX_UPLOAD_BYTES } from "./src/lib/upload-limit";

const nextConfig: NextConfig = {
  transpilePackages: ["@verder/api", "@verder/auth", "@verder/db", "@verder/core"],
  experimental: {
    // Next truncates bodies at 10 MB when middleware is present, which turns
    // legitimate large evidence uploads into opaque 500s. Match the app-level
    // upload ceiling; /api/upload enforces MAX_UPLOAD_BYTES itself with a 413.
    middlewareClientMaxBodySize: MAX_UPLOAD_BYTES,
  },
};

export default nextConfig;
