import Image from "next/image";

export function Footer() {
  return (
    <footer
      className="relative z-10 mt-10 pt-18 px-6 pb-14 flex flex-col items-center gap-4 font-sans"
      style={{
        background: "#000",
        color: "rgba(255,255,255,0.85)",
      }}
    >
      <Image
        src="/edge/edge.svg"
        alt="Edge"
        width={48}
        height={56}
        className="block mb-4"
      />
      <div className="flex flex-wrap justify-center items-center gap-3 text-sm leading-[1.6]">
        <span>© 2026 Edge Institute, Inc.</span>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
        <span>A 501(c)(3) nonprofit organization</span>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
        <span>EIN: 99-2785973</span>
      </div>
      <div className="flex flex-wrap justify-center items-center gap-3 text-sm leading-[1.6]">
        <a href="#" className="no-underline text-inherit">
          Privacy Policy
        </a>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
        <a href="#" className="no-underline text-inherit">
          Terms of Service
        </a>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
        <a href="#" className="no-underline text-inherit">
          Contact
        </a>
        <span style={{ color: "rgba(255,255,255,0.4)" }}>·</span>
        <a href="#" className="no-underline text-inherit">
          Edge City
        </a>
      </div>
    </footer>
  );
}
