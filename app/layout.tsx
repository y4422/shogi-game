import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "将棋 — 本格AI対戦",
  description:
    "ブラウザで遊べる本格将棋。やねうら王 + 水匠ぷち搭載のAIと対戦できます。",
  applicationName: "将棋 本格AI対戦",
  openGraph: {
    title: "将棋 — 本格AI対戦",
    description:
      "ブラウザで遊べる本格将棋。やねうら王 + 水匠ぷち搭載のAIと対戦。駒落ち・形勢バー・棋譜表示つき。",
    type: "website",
    locale: "ja_JP",
    siteName: "将棋 本格AI対戦",
  },
  twitter: {
    card: "summary",
    title: "将棋 — 本格AI対戦",
    description:
      "ブラウザで遊べる本格将棋。やねうら王 + 水匠ぷち搭載のAIと対戦。",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#131419" },
    { media: "(prefers-color-scheme: light)", color: "#ede7d7" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
