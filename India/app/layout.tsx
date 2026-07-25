import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "V-GEN | AI Architect v4.2",
  description: "Local AI video generation pipeline powered by Gemini, Pexels, and FFmpeg."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
