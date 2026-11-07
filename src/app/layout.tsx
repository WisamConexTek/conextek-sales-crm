import type { Metadata } from "next";
import { Nunito_Sans, Questrial } from "next/font/google";
import "./globals.css";

// Closest free match to the ConexTek wordmark (light geometric sans). Swap for the official brand font if you have the files.
const body = Nunito_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const brand = Questrial({ subsets: ["latin"], weight: "400", variable: "--font-brand", display: "swap" });

export const metadata: Metadata = { title: "ConexTek CRM", description: "Internal sales CRM", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${brand.variable}`}>
      <body>{children}</body>
    </html>
  );
}
