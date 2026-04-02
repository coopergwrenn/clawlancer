import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "$INSTACLAW Tokenomics — Every Action Burns",
  description:
    "Every dollar that flows through InstaClaw automatically buys and burns $INSTACLAW on Base. Three independent burn sources. Zero crypto UX. Real revenue. Real burns.",
  openGraph: {
    title: "$INSTACLAW Tokenomics — Every Action Burns",
    description:
      "Every dollar that flows through InstaClaw automatically buys and burns $INSTACLAW on Base. Three independent burn sources. Zero crypto UX. Real revenue. Real burns.",
    url: "https://instaclaw.io/token",
  },
  twitter: {
    card: "summary_large_image",
    title: "$INSTACLAW Tokenomics — Every Action Burns",
    description:
      "Every dollar that flows through InstaClaw automatically buys and burns $INSTACLAW on Base. Three independent burn sources. Zero crypto UX.",
  },
};

export default function TokenLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
