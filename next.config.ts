import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack (default in Next.js 16) handles browser/server splits automatically.
  // onnxruntime-web is a 'use client'-only dynamic import, so no special config needed.
  turbopack: {},
};

export default nextConfig;
