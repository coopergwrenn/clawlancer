import type { Metadata, Viewport } from "next";
import {
  Inter,
  Instrument_Serif,
  EB_Garamond,
  Space_Grotesk,
} from "next/font/google";
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

// EB Garamond + Space Grotesk are scoped to /edge via the [data-theme="edge"]
// block in globals.css — they're declared here at the root so next/font can
// optimize the load, but the body className doesn't reference them so the
// rest of instaclaw.io keeps using Inter as the default.
const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  style: ["normal", "italic"],
  variable: "--font-edge-display",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-edge-sans",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://instaclaw.io"),
  title: "InstaClaw.io — Your Personal AI Agent, Live in Minutes",
  description:
    "A personal AI that works for you around the clock. It handles your tasks, remembers everything, and gets smarter every day. Set it up in minutes. No technical experience required.",
  alternates: { canonical: "https://instaclaw.io" },
  openGraph: {
    title: "InstaClaw.io — Your Personal AI Agent, Live in Minutes",
    description:
      "A personal AI that works for you around the clock. It handles your tasks, remembers everything, and gets smarter every day. Set it up in minutes.",
    url: "https://instaclaw.io",
    siteName: "InstaClaw.io",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "InstaClaw.io — Your Personal AI Agent, Live in Minutes",
    description:
      "A personal AI that works for you around the clock. It handles your tasks, remembers everything, and gets smarter every day. Set it up in minutes.",
    site: "@instaclaws",
  },
  other: {
    "virtual-protocol-site-verification": "71866cde58a96a5163f3cd027122f2c8",
    "msvalidate.01": "43D6476A930C29D499D77B858F7D7219",
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
      <body
        className={`${inter.className} ${instrumentSerif.variable} ${ebGaramond.variable} ${spaceGrotesk.variable}`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
