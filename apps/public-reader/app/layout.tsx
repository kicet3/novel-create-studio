import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "@ncs/reader-core/themes.css";
import "./globals.css";
import { ReaderShell } from "@/src/components/ReaderShell";
import { SITE_DESCRIPTION, SITE_NAME } from "@/src/lib/href";
import { getEnv } from "@/src/server/env";

// per-request rendering: nonce CSP (proxy.ts); data reads are cached (src/server/cached.ts). `next build` never queries.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const origin = getEnv().publicOrigin;
  return {
    metadataBase: new URL(origin),
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    icons: { icon: "/icon.svg" },
    alternates: { canonical: "/" },
    openGraph: { siteName: SITE_NAME, type: "website", locale: "ko_KR", url: "/", title: SITE_NAME, description: SITE_DESCRIPTION },
    twitter: { card: "summary" },
    robots: { index: true, follow: true },
    formatDetection: { telephone: false, email: false, address: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111111" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <ReaderShell>{children}</ReaderShell>
      </body>
    </html>
  );
}
