import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "optional",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "InstaClaw.io — Your Own OpenClaw Instance, Live in Minutes",
  description:
    "A personal AI that works for you around the clock. It handles your tasks, remembers everything, and gets smarter every day. Set it up in minutes.",
  openGraph: {
    title: "InstaClaw.io — Your Own OpenClaw Instance, Live in Minutes",
    description:
      "A personal AI that works for you around the clock. It handles your tasks, remembers everything, and gets smarter every day. Set it up in minutes.",
    siteName: "InstaClaw.io",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "InstaClaw.io — Your Own OpenClaw Instance, Live in Minutes",
    description:
      "A personal AI that works for you around the clock. It handles your tasks, remembers everything, and gets smarter every day. Set it up in minutes.",
  },
  other: {
    "virtual-protocol-site-verification": "71866cde58a96a5163f3cd027122f2c8",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                document.documentElement.style.visibility = 'hidden';
                document.addEventListener('DOMContentLoaded', function() {
                  if (document.fonts) {
                    document.fonts.ready.then(function() {
                      document.documentElement.style.visibility = 'visible';
                    });
                  } else {
                    document.documentElement.style.visibility = 'visible';
                  }
                });
              })();
            `,
          }}
        />
      </head>
      <body className={`${inter.className} ${instrumentSerif.variable}`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
