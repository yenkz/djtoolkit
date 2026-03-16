import type { Metadata } from "next";
import { DM_Sans, Space_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { Grain } from "@/components/ui/Grain";
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
    <html lang="en">
      <body
        className={`${dmSans.variable} ${spaceMono.variable} antialiased bg-hw-body text-hw-text`}
      >
        {children}
        <Grain />
        <Toaster
          theme="dark"
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
      </body>
    </html>
  );
}
