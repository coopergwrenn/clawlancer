import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";
import { LenisProvider } from "@/components/landing/lenis-provider";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LenisProvider>
      <div
        data-theme="landing"
        style={{
          "--background": "#f8f7f4",
          "--foreground": "#333334",
          "--muted": "#6b6b6b",
          "--card": "#ffffff",
          "--border": "rgba(0,0,0,0.1)",
          "--accent": "#DC6743",
          background: "#f8f7f4",
          color: "#333334",
        } as React.CSSProperties}
      >
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </div>
    </LenisProvider>
  );
}
