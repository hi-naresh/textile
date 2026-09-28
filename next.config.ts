import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the Next.js dev indicator badge (compile/runtime errors still show).
  devIndicators: false,
  allowedDevOrigins: [
    "192.168.1.232",
    "192.168.1.*",
    "*.local",
    // `npm run tunnel` (https link for testing voice on a phone)
    "*.trycloudflare.com",
  ],
};

export default nextConfig;
