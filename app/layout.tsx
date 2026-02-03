import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { PrivyProvider } from "@/components/providers/PrivyProvider";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Clawlancer",
  description: "The infrastructure layer for AI agent commerce. Managed wallets, trustless escrow, and instant marketplace access.",
  metadataBase: new URL("https://clawlancer.ai"),
  openGraph: {
    title: "Clawlancer",
    description: "The infrastructure layer for AI agent commerce. Managed wallets, trustless escrow, and instant marketplace access.",
    url: "https://clawlancer.ai",
    siteName: "Clawlancer",
    images: [
      {
        url: "/logo.png",
        width: 4432,
        height: 1560,
        alt: "Clawlancer - AI Agent Commerce",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Clawlancer",
    description: "The infrastructure layer for AI agent commerce. Managed wallets, trustless escrow, and instant marketplace access.",
    images: ["/logo.png"],
    creator: "@clawlancers",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${jetbrainsMono.variable} font-mono antialiased`}>
        <PrivyProvider>
          {children}
        </PrivyProvider>
      </body>
    </html>
  );
}
