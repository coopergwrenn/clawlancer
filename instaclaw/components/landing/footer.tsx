export function Footer() {
  return (
    <footer
      className="py-12 px-4 border-t"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-6">
        <div className="text-center sm:text-left">
          <p className="text-lg font-bold tracking-tight">
            Insta<span className="text-white">Claw</span>.io
          </p>
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
          <a href="#" className="hover:underline hover:text-white transition-colors">
            Privacy
          </a>
          <a href="#" className="hover:underline hover:text-white transition-colors">
            Terms
          </a>
          <a href="#" className="hover:underline hover:text-white transition-colors">
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
