import type { Metadata, Viewport } from "next";
import "./globals.css";
import InlineScript from "@/components/InlineScript";

export const metadata: Metadata = {
  // Replaced in the browser with the firm name from Settings once data loads.
  title: "Textile operations",
  description: "Stock, job cards, AI photo reads and floor efficiency for owners, supervisors and workers",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  // "Add to Home Screen" on iPhone opens full-screen like an app.
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Textile" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // App-like: no pinch / double-tap zoom on phones.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#F3F0E8",
};

// Runs before first paint so the saved (or system) theme never flashes.
// Also blocks pinch-zoom in iPhone Safari (it ignores user-scalable=no).
const themeScript = `(function(){try{var t=localStorage.getItem('tb-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='dark'?'#111210':'#F3F0E8')}catch(e){document.documentElement.dataset.theme='light'}try{document.addEventListener('gesturestart',function(e){e.preventDefault()},{passive:false})}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+Devanagari:wght@400;500;600&family=Noto+Sans+Gujarati:wght@400;500;600&display=swap" rel="stylesheet" />
        <InlineScript html={themeScript} />
      </head>
      <body>{children}</body>
    </html>
  );
}
