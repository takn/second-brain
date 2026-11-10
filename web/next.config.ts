import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@second-brain/schema"],
  output: "standalone",
};

export default nextConfig;
