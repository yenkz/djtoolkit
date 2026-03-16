import type { Metadata } from "next";
import { DM_Sans, Space_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { Grain } from "@/components/ui/Grain";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { ThemeProvider } from "@/lib/theme-provider";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "djtoolkit",
  description: "DJ music library manager",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('djtoolkit-theme');if(t==='light'||(t==='system'&&matchMedia('(prefers-color-scheme: light)').matches))document.documentElement.classList.add('light')})()`,
          }}
        />
      </head>
      <body
        className={`${dmSans.variable} ${spaceMono.variable} antialiased bg-hw-body text-hw-text`}
      >
        <ThemeProvider>
          {children}
          <Grain />
          <Toaster
            richColors
            position="top-right"
            toastOptions={{
              style: {
                background: "var(--hw-surface)",
                border: "1px solid var(--hw-border)",
                color: "var(--hw-text)",
              },
            }}
          />
        </ThemeProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
