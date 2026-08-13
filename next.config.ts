import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // やねうら王 WASM は SharedArrayBuffer(マルチスレッド探索)を使うため、
  // クロスオリジン分離ヘッダーが必須
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
