import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marine Intelligence — Safety & Fishing Advisory",
  description: "Conversational map for safe routing, PFZ and weather alerts",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
