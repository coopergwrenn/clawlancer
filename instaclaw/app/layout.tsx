import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "InstaClaw.io — Your Own OpenClaw Instance, Live in Minutes",
  description:
    "The easiest way to deploy your own OpenClaw instance. Full shell access, browser automation, skills, memory — your own dedicated VM. No DevOps required.",
  openGraph: {
    title: "InstaClaw.io — Your Own OpenClaw Instance, Live in Minutes",
    description:
      "The easiest way to deploy your own OpenClaw instance. Full shell access, browser automation, skills, memory — your own dedicated VM.",
    siteName: "InstaClaw.io",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "InstaClaw.io — Your Own OpenClaw Instance, Live in Minutes",
    description:
      "The easiest way to deploy your own OpenClaw instance. Full shell access, browser automation, skills, memory — your own dedicated VM.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
