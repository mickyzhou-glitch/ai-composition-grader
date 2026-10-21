import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  output: "export",
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next" : "dist",
  images: {
    unoptimized: true,
  },
});

export default nextConfig;
