import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Manrope, Space_Grotesk } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  weight: ["400", "500", "600", "700", "800"],
});

const space = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space",
  weight: ["500", "600", "700"],
});

const jb = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jb",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Star Stock — Inventory Control",
  description:
    "Inventory management with SKU tracking, warehouses, piece/carton stock and full transaction history.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${space.variable} ${jb.variable}`}>
      <body>{children}</body>
    </html>
  );
}
