import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-ssh", "ssh2"],
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
};

export default nextConfig;
