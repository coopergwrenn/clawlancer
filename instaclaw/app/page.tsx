import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Comparison } from "@/components/landing/comparison";
import { UseCases } from "@/components/landing/use-cases";
import { Features } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";
import { FAQ } from "@/components/landing/faq";
import { Footer } from "@/components/landing/footer";
import { LenisProvider } from "@/components/landing/lenis-provider";
import { ScrollReveal } from "@/components/landing/scroll-reveal";
import { NotificationBar } from "@/components/landing/notification-bar";

export default function Home() {
  return (
    <LenisProvider>
      <main
        data-theme="landing"
        style={{
          '--background': '#f8f7f4',
          '--foreground': '#333334',
          '--muted': '#6b6b6b',
          '--card': '#ffffff',
          '--border': 'rgba(0, 0, 0, 0.1)',
          '--accent': '#DC6743',
          background: '#f8f7f4',
          color: '#333334',
        } as React.CSSProperties}
      >
        <NotificationBar />
        <Hero />
        <hr className="section-divider" />
        <ScrollReveal />
        <hr className="section-divider" />
        <HowItWorks />
        <hr className="section-divider" />
        <Comparison />
        <hr className="section-divider" />
        <UseCases />
        <hr className="section-divider" />
        <Features />
        <hr className="section-divider" />
        <Pricing />
        <hr className="section-divider" />
        <FAQ />
        <hr className="section-divider" />
        <Footer />
      </main>
    </LenisProvider>
  );
}
