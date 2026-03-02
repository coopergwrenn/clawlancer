import Link from "next/link";

export function CtaBanner({
  heading = "Ready to get started?",
  description = "Get your personal AI agent live in minutes. No technical experience required.",
}: {
  heading?: string;
  description?: string;
}) {
  return (
    <section
      className="py-16 sm:py-20 px-4 text-center"
      style={{ background: "rgba(220,103,67,0.04)" }}
    >
      <h2
        className="text-3xl sm:text-4xl font-normal tracking-[-1px] mb-4"
        style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
      >
        {heading}
      </h2>
      <p
        className="text-sm sm:text-base max-w-md mx-auto mb-8"
        style={{ color: "#6b6b6b" }}
      >
        {description}
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center items-center">
        <Link
          href="/signup"
          className="px-6 py-3 rounded-lg text-sm font-medium transition-all"
          style={{
            background: "#DC6743",
            color: "#fff",
            boxShadow: "0 2px 8px rgba(220,103,67,0.3)",
          }}
        >
          Start Free Trial
        </Link>
        <Link
          href="/pricing"
          className="px-6 py-3 rounded-lg text-sm font-medium transition-all"
          style={{
            background:
              "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
            backdropFilter: "blur(2px)",
            boxShadow:
              "rgba(0,0,0,0.05) 0px 2px 2px 0px inset, rgba(255,255,255,0.5) 0px -2px 2px 0px inset, rgba(0,0,0,0.1) 0px 2px 4px 0px",
            color: "#333334",
          }}
        >
          View Pricing
        </Link>
      </div>
    </section>
  );
}
