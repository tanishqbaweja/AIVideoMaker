/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["fluent-ffmpeg", "ffmpeg-static", "ffprobe-static"]
};

export default nextConfig;