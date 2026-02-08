import Image from "next/image";

export function Footer() {
  return (
    <footer
      className="py-16 px-4 border-t"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
        <div className="text-center sm:text-left">
          <div className="flex items-center gap-2">
            <Image src="/logo.png" alt="InstaClaw" width={28} height={28} unoptimized style={{ imageRendering: "pixelated" }} />
            <p className="text-lg font-bold tracking-tight">
              Insta<span style={{ color: "var(--accent)" }}>Claw</span>.io
            </p>
          </div>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
            From the makers of{" "}
            <a
              href="https://clawlancer.com"
              className="underline hover:no-underline"
              style={{ color: "var(--foreground)" }}
            >
              Clawlancer
            </a>
          </p>
        </div>

        <div
          className="flex gap-6 text-sm"
          style={{ color: "var(--muted)" }}
        >
          <a href="/privacy" className="hover:underline transition-colors" style={{ color: "var(--muted)" }}>
            Privacy
          </a>
          <a href="/terms" className="hover:underline transition-colors" style={{ color: "var(--muted)" }}>
            Terms
          </a>
          <a href="mailto:cooper@clawlancer.com" className="hover:underline transition-colors" style={{ color: "var(--muted)" }}>
            Contact
          </a>
        </div>

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          &copy; {new Date().getFullYear()} InstaClaw. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
