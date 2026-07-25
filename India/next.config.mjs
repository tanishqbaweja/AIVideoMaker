import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the India clone self-contained instead of inheriting the parent repo
  // as the workspace root just because it also has a package-lock.json.
  outputFileTracingRoot: fileURLToPath(new URL("./", import.meta.url)),
  serverExternalPackages: ["fluent-ffmpeg", "ffmpeg-static", "ffprobe-static"]
};

export default nextConfig;
